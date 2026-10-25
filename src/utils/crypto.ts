// HMAC-SHA256 signing, PBKDF2 password hashing, constant-time helpers.
//
// Password storage: PBKDF2-SHA256 with a per-password random salt. The iteration
// count is embedded in the stored string ("pbkdf2$sha256$<iter>$<salt>$<hash>")
// so it can be raised later without invalidating existing hashes — a successful
// login with an older/weaker hash asks the caller to re-hash.
//
// Iterations are tuned to the Workers CPU budget: 50k costs ~6ms, which fits the
// free plan's 10ms/request ceiling alongside the D1 round trips.

const encoder = new TextEncoder();

const PBKDF2_PREFIX = 'pbkdf2$sha256$';
const PBKDF2_ITERATIONS = 50_000;
const SALT_BYTES = 16;

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Constant-time comparison for secrets (session signatures, password hashes,
// API keys). Length is the only thing that leaks, which is unavoidable and not
// secret for the fixed-size values we compare.
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt out of range yields NaN; the `|| 0` keeps the arithmetic exact
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Sign a payload string with HMAC-SHA256, return hex signature
export async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bufToHex(sig);
}

// Verify HMAC-SHA256 signature
export async function hmacVerify(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  return timingSafeEqual(expected, signature);
}

// Single SHA-256, hex output. Only used to verify hashes written by older
// versions before PBKDF2 was adopted.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bufToHex(digest);
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
}

// Hash a password with PBKDF2-SHA256 + random salt
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${bufToHex(salt.buffer as ArrayBuffer)}$${bufToHex(bits)}`;
}

export interface PasswordCheck {
  ok: boolean;
  // True when the stored hash is weaker than what this version would produce
  // right now, so the caller should overwrite it after a successful login.
  needsRehash: boolean;
}

// Verify a password against a stored hash (PBKDF2, or legacy unsalted SHA-256)
export async function verifyPasswordHash(password: string, stored: string): Promise<PasswordCheck> {
  if (!stored) return { ok: false, needsRehash: false };

  if (stored.startsWith(PBKDF2_PREFIX)) {
    const parts = stored.slice(PBKDF2_PREFIX.length).split('$');
    const [iterStr, saltHex, hashHex] = parts;
    const iterations = parseInt(iterStr, 10);
    if (!iterations || !saltHex || !hashHex) return { ok: false, needsRehash: false };

    const bits = await pbkdf2Bits(password, hexToBytes(saltHex), iterations);
    const ok = timingSafeEqual(bufToHex(bits), hashHex);
    return { ok, needsRehash: ok && iterations < PBKDF2_ITERATIONS };
  }

  // Legacy format: bare SHA-256 hex, no salt
  const legacy = await sha256Hex(password);
  const ok = timingSafeEqual(legacy, stored);
  return { ok, needsRehash: ok };
}
