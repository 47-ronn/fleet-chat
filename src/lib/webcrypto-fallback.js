// Web Crypto / Clipboard fallback for INSECURE contexts (plain http).
//
// Browsers expose `crypto.subtle` and `crypto.randomUUID` only in secure
// contexts (https://* or http://localhost) — over plain http://<LAN-IP> both
// are undefined and `navigator.clipboard` is missing too, which used to kill
// the panel at the first key derivation ("can't access property 'digest'").
//
// Dev intentionally runs over plain http (see vite.config.js), so when the
// native implementation is absent we install a minimal WebCrypto-shaped shim
// built on @noble/hashes + @noble/ciphers (pure browser JS, zero Node
// builtins — unlike @peculiar/webcrypto, whose 1.x/2.x builds wrap node:crypto).
// It implements exactly the surface this app uses — SHA-256, AES-256-GCM,
// PBKDF2-SHA256 — with standard byte semantics (GCM output is ciphertext
// followed by the 16-byte tag, like native), so envelopes stay wire-compatible
// with the Rust `Cipher`. On https/localhost nothing is patched and the
// noble chunks are never even downloaded (dynamic import inside the branch).
//
// `crypto.getRandomValues` (nonces/salts) is NOT secure-context-only — it is
// always native.

// BufferSource → Uint8Array (both native and shim callers pass plain views).
const u8 = (x) => new Uint8Array(x.buffer, x.byteOffset, x.byteLength);

// document.execCommand('copy') through an offscreen textarea — the pre-async
// Clipboard API trick, good enough for the panel's 📋 buttons.
function execCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new DOMException('copy failed', 'NotAllowedError');
}

// Build the subtle-shaped object. Keys are plain holders: { kind, key }.
function makeSubtle({ gcm, sha256, pbkdf2Async }) {
  const fail = (what) => {
    throw new Error(`webcrypto fallback: unsupported ${what}`);
  };

  return {
    async digest(algorithm, data) {
      if (algorithm !== 'SHA-256') fail(`digest ${algorithm}`);
      return sha256(u8(data));
    },

    async importKey(format, keyData, algorithm /* , extractable, usages */) {
      const bits = u8(keyData);
      if (format !== 'raw') fail(`key format ${format}`);
      if (algorithm === 'PBKDF2') return { kind: 'pbkdf2', key: bits };
      if (algorithm === 'AES-GCM') return { kind: 'aes-gcm', key: bits };
      fail(`algorithm ${algorithm}`);
    },

    async encrypt(algorithm, key, data) {
      if (algorithm?.name !== 'AES-GCM' || key?.kind !== 'aes-gcm') fail('encrypt params');
      // No-AAD, default 128-bit tag — exactly how crypto.js/creds.js call it.
      return gcm(key.key, u8(algorithm.iv)).encrypt(u8(data));
    },

    async decrypt(algorithm, key, data) {
      if (algorithm?.name !== 'AES-GCM' || key?.kind !== 'aes-gcm') fail('decrypt params');
      // Throws on tag mismatch — same auth behaviour as native (creds.js
      // turns that into "неверный PIN").
      return gcm(key.key, u8(algorithm.iv)).decrypt(u8(data));
    },

    async deriveKey(algorithm, baseKey, derivedKeyType /* , extractable, usages */) {
      if (algorithm?.name !== 'PBKDF2' || baseKey?.kind !== 'pbkdf2') fail('deriveKey params');
      if (algorithm.hash !== 'SHA-256') fail(`PBKDF2 hash ${algorithm.hash}`);
      if (derivedKeyType?.name !== 'AES-GCM' || derivedKeyType.length !== 256) {
        fail('derived key type');
      }
      const bits = await pbkdf2Async(sha256, baseKey.key, u8(algorithm.salt), {
        c: algorithm.iterations,
        dkLen: derivedKeyType.length >> 3,
      });
      return { kind: 'aes-gcm', key: bits };
    },
  };
}

/** Install polyfills for everything secure-context-only this app uses.
 *  Idempotent; a no-op where the native APIs exist. */
export async function ensureWebCrypto() {
  // --- crypto.subtle (the E2E engine: AES-GCM / SHA-256 / PBKDF2) -----------
  if (!crypto?.subtle) {
    const [{ gcm }, { sha256 }, { pbkdf2Async }] = await Promise.all([
      import('@noble/ciphers/aes.js'),
      import('@noble/hashes/sha2.js'),
      import('@noble/hashes/pbkdf2.js'),
    ]);
    Object.defineProperty(crypto, 'subtle', {
      value: makeSubtle({ gcm, sha256, pbkdf2Async }),
      configurable: true,
    });
  }

  // --- crypto.randomUUID (relay.js chain ids) -------------------------------
  if (!crypto.randomUUID) {
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10
        const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      },
      configurable: true,
    });
  }

  // --- navigator.clipboard (Chat.svelte 📋 copy buttons) ---------------------
  if (!navigator.clipboard?.writeText) {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text) => Promise.resolve().then(() => execCopy(text)),
        readText: () => Promise.reject(new DOMException('read denied', 'NotAllowedError')),
      },
      configurable: true,
    });
  }
}
