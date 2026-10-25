import { Context, Next } from 'hono';
import { hmacSign, hmacVerify, hashPassword, verifyPasswordHash } from './utils/crypto';
import { first, run } from './db';
import { unauthorized } from './response';
import type { Env, SettingRow } from './types';

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

// Login throttling: after this many failures the endpoint refuses to even check
// the password for LOCK_MS. Stored in the settings table so it survives isolates.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

const KEY_FAILED = 'login_fail_count';
const KEY_LOCKED_UNTIL = 'login_block_until';

// Build cookie payload: expiry timestamp
function buildPayload(expiresAt: number): string {
  return `admin:${expiresAt}`;
}

// Issue a signed session cookie
export async function issueSessionCookie(secret: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const payload = buildPayload(expiresAt);
  const sig = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

// Verify session cookie value
export async function verifySession(cookieValue: string, secret: string): Promise<boolean> {
  const lastDot = cookieValue.lastIndexOf('.');
  if (lastDot === -1) return false;

  const payload = cookieValue.slice(0, lastDot);
  const sig = cookieValue.slice(lastDot + 1);

  const valid = await hmacVerify(payload, sig, secret);
  if (!valid) return false;

  // Check expiry
  const parts = payload.split(':');
  if (parts.length !== 2) return false;
  const expiresAt = parseInt(parts[1], 10);
  if (isNaN(expiresAt)) return false;

  return Math.floor(Date.now() / 1000) < expiresAt;
}

// Build Set-Cookie header value
export function buildSetCookie(value: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Build clear cookie header
export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Parse cookie header to get session value
function getSessionFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const [name, ...rest] = c.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [key, value]
  );
}

// Milliseconds left on the current lockout (0 when not locked)
export async function loginLockRemainingMs(db: D1Database): Promise<number> {
  const row = await first<SettingRow>(db, 'SELECT value FROM settings WHERE key = ?', [
    KEY_LOCKED_UNTIL,
  ]);
  const until = parseInt(row?.value ?? '0', 10) || 0;
  return Math.max(0, until - Date.now());
}

async function recordLoginFailure(db: D1Database): Promise<void> {
  const row = await first<SettingRow>(db, 'SELECT value FROM settings WHERE key = ?', [KEY_FAILED]);
  const count = (parseInt(row?.value ?? '0', 10) || 0) + 1;

  if (count >= MAX_FAILED_ATTEMPTS) {
    await setSetting(db, KEY_LOCKED_UNTIL, String(Date.now() + LOCK_MS));
    await setSetting(db, KEY_FAILED, '0');
    return;
  }
  await setSetting(db, KEY_FAILED, String(count));
}

async function clearLoginFailures(db: D1Database): Promise<void> {
  await run(db, 'DELETE FROM settings WHERE key IN (?, ?)', [KEY_FAILED, KEY_LOCKED_UNTIL]);
}

// Verify login password against the stored hash, or ADMIN_PASSWORD on first run.
// A successful legacy/weaker hash is upgraded in place (PBKDF2 with a new salt).
export async function verifyPassword(
  db: D1Database,
  password: string,
  adminPassword: string
): Promise<boolean> {
  const row = await first<SettingRow>(db, 'SELECT value FROM settings WHERE key = ?', [
    'login_password_hash',
  ]);

  if (row) {
    const check = await verifyPasswordHash(password, row.value);
    if (check.ok && check.needsRehash) {
      await setSetting(db, 'login_password_hash', await hashPassword(password));
    }
    return check.ok;
  }

  // First login: the ADMIN_PASSWORD secret is the source of truth, and its hash
  // is stored so later secret changes do not silently take effect.
  if (adminPassword && password === adminPassword) {
    await setSetting(db, 'login_password_hash', await hashPassword(password));
    return true;
  }

  return false;
}

// Auth middleware for Hono
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const cookie = c.req.header('Cookie') ?? null;
    const session = getSessionFromCookie(cookie);

    if (!session) {
      return unauthorized();
    }

    const valid = await verifySession(session, c.env.COOKIE_SECRET);
    if (!valid) {
      return unauthorized();
    }

    await next();
  };
}

export { MAX_FAILED_ATTEMPTS, LOCK_MS, recordLoginFailure, clearLoginFailures };
