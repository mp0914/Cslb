// HS256 JWT + PBKDF2 passphrase verification on Web Crypto only.
// Same approach as the adhd-todo-list functions, kept as its own module here
// so the route file stays readable.

const ENC = new TextEncoder();

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

const ONE_YEAR = 365 * 24 * 60 * 60;

export async function signJWT(payload, secret, ttl = ONE_YEAR) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(ENC.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(ENC.encode(JSON.stringify({ ...payload, iat: now, exp: now + ttl })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, ENC.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await hmacKey(secret);
  let valid;
  try {
    valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), ENC.encode(`${header}.${body}`));
  } catch (e) {
    return null;
  }
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch (e) {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Stored form is "saltHex:hashHex". Generate one with `node worker/hash-passphrase.mjs`.
export async function hashPassphrase(passphrase, salt) {
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', ENC.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: s, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return `${hex(s)}:${hex(new Uint8Array(bits))}`;
}

export async function verifyPassphrase(passphrase, stored) {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const candidate = await hashPassphrase(passphrase, salt);
  const got = candidate.split(':')[1];
  // Constant-time-ish compare so the response does not leak a prefix match.
  if (got.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
