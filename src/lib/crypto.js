// End-to-end crypto matching the Rust `Cipher` (crates/shared/src/crypto.rs):
//   key = SHA-256("remote-agents/v1:" + token)   (or the override key verbatim)
//   AES-256-GCM, fresh random 12-byte nonce prepended, base64-encoded.
//   Wire (after base64-decode): nonce(12) || ciphertext || tag(16)
// Web Crypto's AES-GCM appends the 16-byte tag to the ciphertext, so the layout
// matches the Rust `aes-gcm` crate exactly.

import { decompress as zstdDecompress } from 'fzstd';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Agents transparently zstd-compress large payloads INSIDE the encrypted
// envelope (history, file chunks, fleet results). After AES-decrypt the bytes
// are either raw JSON or a zstd frame, told apart by the magic 0x28B52FFD —
// JSON never starts with 0x28. We only ever decompress (the panel's own
// outbound commands are small and sent uncompressed).
function isZstd(b) {
  return b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
}

export async function deriveKey(token, overrideKey) {
  const passphrase =
    overrideKey && overrideKey.length ? overrideKey : `remote-agents/v1:${token}`;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(passphrase));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Raw envelope `nonce(12) || ciphertext || tag(16)` as bytes — the binary-wire
// form (matches Rust `Cipher::encrypt_bytes`). No base64: the protobuf `payload`
// field carries these bytes directly.
export async function encryptBytes(key, plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext))
  );
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce, 0);
  combined.set(ct, nonce.length);
  return combined;
}

// Decrypt a raw envelope produced by `encryptBytes` / Rust `encrypt_bytes`
// (matches Rust `decrypt_bytes`); zstd-decompresses the plaintext if needed.
export async function decryptBytes(key, data) {
  const nonce = data.slice(0, 12);
  const ct = data.slice(12);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
  let pt = new Uint8Array(ptBuf);
  if (isZstd(pt)) pt = zstdDecompress(pt);
  return dec.decode(pt);
}

// Base64 string forms (kept for any text-transport callers); wrap the byte
// versions so the crypto lives in one place.
export async function encryptStr(key, plaintext) {
  return b64encode(await encryptBytes(key, plaintext));
}

export async function decryptStr(key, encoded) {
  return decryptBytes(key, b64decode(encoded));
}
