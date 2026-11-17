// Share-room links with TTL: the "Share room" button hands the room to a phone
// in one scan. The link carries relay/room/token encrypted with AES-GCM under a
// key derived from a random share-code (PBKDF2), so the token never travels as
// plain base64 in a QR. TTL is enforced on decrypt (2 minutes default): a scan
// must happen fast, the link is dead afterwards.
//
// Format (hash): #/app/join/<payload>
//   payload = url-safe-b64( JSON {v, exp, salt, iv, ct} )
//   ct      = AES-GCM(JSON {relayUrl, room, token}, key = PBKDF2(code, salt))
//   code    = 6 random digits, shown next to the QR — the phone user types it
//             once (or it's embedded in a deep link #code for copy-paste).
//
// Why a code at all? The QR is scanned by a stranger's camera app; anything it
// decodes goes through that app. The ciphertext alone is useless without the
// code, and the code is only in the room owner's screen/clipboard.

const ITER = 100_000; // PBKDF2 rounds

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64e(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s + '='.repeat(pad));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export const SHARE_TTL_MS = 2 * 60 * 1000; // 2 minutes — enough to scan + join

async function codeKey(code, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Random 6-digit share code (e.g. "482913"). */
export function genShareCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/**
 * Build the encrypted join payload.
 * Returns { payload, code, exp } — build the URL as
 * `${origin}${pathname}#/app/join/${payload}` and show `code` beside the QR.
 */
export async function buildSharePayload({ relayUrl, room, token }, code = genShareCode(), ttlMs = SHARE_TTL_MS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await codeKey(code, salt);
  const exp = Date.now() + ttlMs;
  const plaintext = enc.encode(JSON.stringify({ relayUrl, room, token }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const payload = b64e(enc.encode(JSON.stringify({ v: 1, exp, salt: [...salt], iv: [...iv], ct: [...ct] })));
  return { payload, code, exp };
}

/**
 * Decrypt a join payload with the code. Returns the creds or null when
 * expired / wrong code (AES-GCM tag failure = wrong code).
 */
export async function openSharePayload(payload, code) {
  let obj;
  try {
    obj = JSON.parse(dec.decode(b64d(payload)));
  } catch {
    return null;
  }
  if (obj?.v !== 1) return null;
  if (typeof obj.exp !== 'number' || Date.now() > obj.exp) return null; // TTL
  const u8 = (arr) => Uint8Array.from(arr ?? []);
  try {
    const key = await codeKey(code, u8(obj.salt));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u8(obj.iv) },
      key,
      u8(obj.ct)
    );
    const creds = JSON.parse(dec.decode(new Uint8Array(pt)));
    if (!creds.relayUrl || !creds.room || !creds.token) return null;
    return creds;
  } catch {
    return null; // wrong code or corrupted
  }
}