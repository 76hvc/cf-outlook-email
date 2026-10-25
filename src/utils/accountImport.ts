// Account import parsing — shared by the cookie-auth UI route
// (POST /api/accounts) and the API-key route (POST /api/external/accounts).
//
// Wire format (identical to export, so export → import round-trips):
//   email----password----client_id----refresh_token
// Password may be empty (email--------client_id----refresh_token), but the line
// must always carry 4 segments: a 3-segment line is ambiguous (is segment 2 the
// password or the client_id?) and is rejected instead of being guessed at.

import { isValidEmail } from './validation';

export const IMPORT_SEPARATOR = '----';

// Per-request ceiling. Each imported row costs D1 queries (dup check + insert),
// and the free plan allows ~50 queries per Worker invocation, so bulk imports
// are meant to be batched by the caller rather than sent in one huge blob.
export const MAX_IMPORT_ITEMS = 300;

export interface ParsedAccount {
  line: number;
  email: string;
  password: string;
  client_id: string;
  refresh_token: string;
}

export interface RejectedAccount {
  line: number;
  email?: string;
  raw?: string;
  reason: string;
  // 'duplicate' = already in the payload (retryable by dropping the line);
  // 'invalid' = malformed, needs fixing
  kind?: 'invalid' | 'duplicate';
}

export interface ParseResult {
  accepted: ParsedAccount[];
  rejected: RejectedAccount[];
}

function isRejected(v: ParsedAccount | RejectedAccount): v is RejectedAccount {
  return (v as RejectedAccount).reason !== undefined;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// Parse one `----`-separated line
export function parseAccountLine(raw: string, line: number): ParsedAccount | RejectedAccount {
  const parts = raw.split(IMPORT_SEPARATOR).map((s) => s.trim());

  let email: string;
  let password: string;
  let clientId: string;
  let refreshToken: string;

  if (parts.length >= 4) {
    email = parts[0];
    password = parts[1];
    clientId = parts[2];
    // Re-join the tail: a token containing the separator must not be truncated
    refreshToken = parts.slice(3).join(IMPORT_SEPARATOR);
  } else {
    return {
      line,
      raw,
      reason: `字段不足：需要 4 段 邮箱${IMPORT_SEPARATOR}密码${IMPORT_SEPARATOR}client_id${IMPORT_SEPARATOR}refresh_token（密码可留空，写成 邮箱${IMPORT_SEPARATOR}${IMPORT_SEPARATOR}client_id${IMPORT_SEPARATOR}refresh_token）`,
    };
  }

  if (!email) return { line, raw, reason: '邮箱为空' };
  if (!isValidEmail(email)) return { line, email, raw, reason: '邮箱格式不正确' };
  if (!clientId) return { line, email, raw, reason: 'client_id 为空' };
  if (!refreshToken) return { line, email, raw, reason: 'refresh_token 为空' };

  return { line, email, password, client_id: clientId, refresh_token: refreshToken };
}

// Parse a JSON object item ({ email, password, client_id, refresh_token })
function parseAccountObject(obj: Record<string, unknown>, line: number): ParsedAccount | RejectedAccount {
  const email = str(obj.email).trim();
  const password = str(obj.password).trim();
  const clientId = str(obj.client_id ?? obj.clientId).trim();
  const refreshToken = str(obj.refresh_token ?? obj.refreshToken).trim();

  if (!email) return { line, raw: JSON.stringify(obj), reason: '邮箱为空' };
  if (!isValidEmail(email)) return { line, email, raw: JSON.stringify(obj), reason: '邮箱格式不正确' };
  if (!clientId) return { line, email, raw: JSON.stringify(obj), reason: 'client_id 为空' };
  if (!refreshToken) return { line, email, raw: JSON.stringify(obj), reason: 'refresh_token 为空' };

  return { line, email, password, client_id: clientId, refresh_token: refreshToken };
}

// Merge accepted entries while rejecting repeats inside the same payload
// (case-insensitive: the DB unique index is case-sensitive, so this also
// stops `A@x.com` + `a@x.com` from both landing in the table)
function dedupe(accepted: ParsedAccount[], rejected: RejectedAccount[]): ParseResult {
  const seen = new Map<string, number>();
  const kept: ParsedAccount[] = [];
  for (const acc of accepted) {
    const key = acc.email.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      rejected.push({
        line: acc.line,
        email: acc.email,
        reason: `同一请求内邮箱重复（第 ${first} 行已包含）`,
        kind: 'duplicate',
      });
      continue;
    }
    seen.set(key, acc.line);
    kept.push(acc);
  }
  kept.sort((a, b) => a.line - b.line);
  rejected.sort((a, b) => a.line - b.line);
  return { accepted: kept, rejected };
}

// Parse multi-line text. Blank lines and `#` comments are skipped silently.
export function parseAccountText(text: string): ParseResult {
  const accepted: ParsedAccount[] = [];
  const rejected: RejectedAccount[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const parsed = parseAccountLine(raw, i + 1);
    if (isRejected(parsed)) rejected.push(parsed);
    else accepted.push(parsed);
  }

  return dedupe(accepted, rejected);
}

// Parse a JSON array; items may be `----` strings or objects
export function parseAccountList(items: unknown[]): ParseResult {
  const accepted: ParsedAccount[] = [];
  const rejected: RejectedAccount[] = [];

  items.forEach((item, i) => {
    const line = i + 1;
    if (typeof item === 'string') {
      const parsed = parseAccountLine(item.trim(), line);
      if (isRejected(parsed)) rejected.push(parsed);
      else accepted.push(parsed);
      return;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const parsed = parseAccountObject(item as Record<string, unknown>, line);
      if (isRejected(parsed)) rejected.push(parsed);
      else accepted.push(parsed);
      return;
    }
    rejected.push({ line, reason: '条目格式不正确：需要字符串行或对象' });
  });

  return dedupe(accepted, rejected);
}

// Accept every shape the API can receive:
//   - raw text body
//   - { account_string: "..." }
//   - { accounts: [ ... ] }
//   - a single account object
export function parseAccountPayload(input: unknown): ParseResult {
  if (typeof input === 'string') return parseAccountText(input);

  if (Array.isArray(input)) return parseAccountList(input);

  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.account_string === 'string') return parseAccountText(obj.account_string);
    if (typeof obj.text === 'string') return parseAccountText(obj.text);
    if (Array.isArray(obj.accounts)) return parseAccountList(obj.accounts);
    if (typeof obj.email === 'string') return parseAccountList([obj]);
    return {
      accepted: [],
      rejected: [
        {
          line: 0,
          reason: '无法识别的导入格式：需要 account_string / accounts / email 字段，或纯文本行',
        },
      ],
    };
  }

  return {
    accepted: [],
    rejected: [{ line: 0, reason: '请求体为空：请提供账号数据' }],
  };
}
