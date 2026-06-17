// PIN-protected credential storage.
//
// The relay/room/token are encrypted with a key derived from the user's PIN
// (PBKDF2-SHA256 → AES-GCM) and kept in a cookie for 180 days. The PIN itself is
// NEVER stored anywhere, so the cookie is useless to anyone who doesn't know it.
// (A short PIN is still brute-forceable offline if the cookie leaks; the high
// PBKDF2 iteration count is the mitigation — keep PINs reasonably long.)

const COOKIE = 'fc_creds';
const DAYS = 180;
const ITER = 250_000; // PBKDF2 rounds — slows offline PIN guessing

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64e(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64d(str) {
  const bin = atob(str);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, [
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

export async function encryptCreds(pin, creds) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pinKey(pin, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(creds)))
  );
  return { v: 1, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
}

export async function decryptCreds(pin, blob) {
  const key = await pinKey(pin, b64d(blob.salt));
  // AES-GCM is authenticated: a wrong PIN fails the tag check and throws.
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, key, b64d(blob.ct));
  return JSON.parse(dec.decode(new Uint8Array(pt)));
}

// --- cookie helpers ---------------------------------------------------------

function setCookie(name, value, days) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(
    value
  )}; Max-Age=${days * 86400}; Path=/; SameSite=Strict${secure}`;
}
function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function delCookie(name) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Strict`;
}

// --- public API -------------------------------------------------------------

/** True if an encrypted credential cookie is present (→ prompt only for a PIN). */
export function hasStoredCreds() {
  return !!getCookie(COOKIE);
}

/** Encrypt `creds` with `pin` and persist for 180 days. */
export async function storeCreds(pin, creds) {
  setCookie(COOKIE, JSON.stringify(await encryptCreds(pin, creds)), DAYS);
}

/** Decrypt the stored creds with `pin`. Throws 'неверный PIN' on a bad PIN. */
export async function loadCreds(pin) {
  const raw = getCookie(COOKIE);
  if (!raw) throw new Error('нет сохранённых данных');
  let blob;
  try {
    blob = JSON.parse(raw);
  } catch {
    throw new Error('повреждённые сохранённые данные');
  }
  try {
    return await decryptCreds(pin, blob);
  } catch {
    throw new Error('неверный PIN');
  }
}

/** Forget the stored credentials entirely (the cookie is removed). */
export function clearCreds() {
  delCookie(COOKIE);
}
