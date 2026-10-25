import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first, query, run } from '../db';
import { ok, fail } from '../response';
import { getAccessToken, fetchEmails } from '../graph';
import { parseAccountPayload, MAX_IMPORT_ITEMS } from '../utils/accountImport';
import { importAccounts, resolveGroupId } from '../importAccounts';

// External API: fetch emails / import accounts by API key, no login required.
// Mounted BEFORE the cookie auth middleware so it is not gated by sessions.
const external = new Hono<{ Bindings: Env }>();

// API-key auth: accept `X-API-Key` header or `?key=` query param
external.use('*', async (c, next) => {
  const row = await first<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'external_api_key'",
    []
  );
  const configured = row?.value;
  if (!configured) {
    return fail('API_DISABLED', '对外 API 未启用：请在「系统设置」生成 API Key', 403);
  }
  const provided = c.req.header('X-API-Key') || c.req.query('key') || '';
  if (provided !== configured) {
    return fail('UNAUTHORIZED', 'API Key 无效', 401);
  }
  await next();
});

// GET /api/external/emails?email=<addr>&folder=inbox|junkemail|deleteditems|all&top=10&keyword=&includeBody=1
external.get('/emails', async (c) => {
  const email = (c.req.query('email') || '').trim().toLowerCase();
  if (!email) return fail('BAD_REQUEST', '缺少 email 参数', 400);

  const folder = c.req.query('folder') || 'inbox';
  const top = Math.min(parseInt(c.req.query('top') || '10', 10) || 10, 50);
  const keyword = c.req.query('keyword') || undefined;
  // bodyPreview is truncated to 255 chars by Graph; includeBody=1 adds the full plain-text body
  const includeBody = ['1', 'true'].includes((c.req.query('includeBody') || '').toLowerCase());

  const acc = await first<AccountRow>(
    c.env.DB,
    'SELECT * FROM accounts WHERE lower(email) = ?',
    [email]
  );
  if (!acc) return fail('NOT_FOUND', '账号不存在', 404);
  if (acc.status === 'disabled') return fail('DISABLED', '该账号已停用', 400);

  const tok = await getAccessToken(acc.client_id, acc.refresh_token);
  if (!tok.token) {
    await run(c.env.DB, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
    return fail('TOKEN_FAILED', tok.error?.message || 'Token 获取失败', 502);
  }
  // Persist a rotated refresh_token if Microsoft issued one
  if (tok.newRefreshToken && tok.newRefreshToken !== acc.refresh_token) {
    await run(
      c.env.DB,
      "UPDATE accounts SET refresh_token = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [tok.newRefreshToken, acc.id]
    );
  } else if (acc.status === 'error') {
    // Token works without rotation: clear the stale error flag
    await run(c.env.DB, "UPDATE accounts SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
  }

  const result = await fetchEmails(tok.token, { folder, top, skip: 0, keyword, includeBody });
  if (result.error) return fail('GRAPH_ERROR', result.error.message, 502);

  const items = (result.items ?? []).map((e) => ({
    id: e.id,
    subject: e.subject ?? '(无主题)',
    from: {
      name: e.from?.emailAddress?.name ?? '',
      address: e.from?.emailAddress?.address ?? '',
    },
    receivedDateTime: e.receivedDateTime,
    bodyPreview: e.bodyPreview ?? '',
    ...(includeBody ? { body: e.body?.content ?? '' } : {}),
    isRead: e.isRead,
  }));

  return ok({ email, folder, count: items.length, items });
});

// GET /api/external/accounts?status=&keyword=&limit=
// Inventory check for scripts — metadata only, never tokens.
external.get('/accounts', async (c) => {
  const status = (c.req.query('status') || '').trim();
  const keyword = (c.req.query('keyword') || '').trim();
  const limit = Math.min(parseInt(c.req.query('limit') || '200', 10) || 200, 1000);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) {
    conditions.push('a.status = ?');
    params.push(status);
  }
  if (keyword) {
    conditions.push('(a.email LIKE ? OR a.remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const rows = await query<{
    id: number;
    email: string;
    status: string;
    group_id: number;
    remark: string;
    created_at: string;
    group_name: string;
  }>(
    c.env.DB,
    `SELECT a.id, a.email, a.status, a.group_id, a.remark, a.created_at, g.name AS group_name
     FROM accounts a LEFT JOIN groups g ON a.group_id = g.id
     ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT ?`,
    [...params, limit]
  );

  return ok({
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      group_id: r.group_id,
      group_name: r.group_name ?? '默认分组',
      remark: r.remark,
      created_at: r.created_at,
    })),
  });
});

// POST /api/external/accounts — bulk import accounts
//
// Body (any of):
//   text/plain:  email----password----client_id----refresh_token   (one per line)
//   JSON:        { "account_string": "..." }
//                { "accounts": ["<line>", { "email": "...", ... }] }
//                { "email": "...", "password": "...", "client_id": "...", "refresh_token": "..." }
// Optional: ?group_id=<id> (or "group_id" in the JSON body), ?dry_run=1
//
// Returns per-line results so a caller can retry only the failed ones.
external.post('/accounts', async (c) => {
  const contentType = (c.req.header('Content-Type') || '').toLowerCase();

  let input: unknown;
  if (contentType.includes('application/json')) {
    input = await c.req.json().catch(() => undefined);
    if (input === undefined) return fail('BAD_REQUEST', '请求体不是合法 JSON', 400);
  } else {
    // text/plain (or missing content-type): treat the raw body as import lines
    input = await c.req.text();
  }
  if (input === null || input === undefined) return fail('BAD_REQUEST', '请求体为空：请提供账号数据', 400);

  const bodyObj =
    typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  // Target group: query param wins over body field
  const groupRaw = c.req.query('group_id') ?? bodyObj.group_id;
  let groupIdInput: number | undefined;
  if (groupRaw !== undefined && groupRaw !== null && String(groupRaw).trim() !== '') {
    groupIdInput = parseInt(String(groupRaw), 10);
    if (!Number.isInteger(groupIdInput)) return fail('BAD_REQUEST', 'group_id 必须是整数', 400);
  }
  const groupId = await resolveGroupId(c.env.DB, groupIdInput);
  if (groupId === null) {
    return fail('BAD_REQUEST', `分组不存在：group_id=${groupIdInput}`, 400);
  }

  const dryRaw = c.req.query('dry_run') ?? c.req.query('dryRun') ?? bodyObj.dry_run ?? bodyObj.dryRun;
  const dryRun = ['1', 'true', 'yes'].includes(String(dryRaw ?? '').toLowerCase());

  const parsed = parseAccountPayload(input);
  const total = parsed.accepted.length + parsed.rejected.length;
  if (total === 0) {
    return fail(
      'BAD_REQUEST',
      '没有可导入的数据：请按 邮箱----密码----client_id----refresh_token 每行一个提供',
      400
    );
  }
  if (total > MAX_IMPORT_ITEMS) {
    return fail('BAD_REQUEST', `单次最多导入 ${MAX_IMPORT_ITEMS} 条（本次 ${total} 条），请分批提交`, 400);
  }

  const result = await importAccounts(c.env.DB, parsed, { groupId, dryRun });

  const parts: string[] = [];
  if (dryRun) parts.push(`预检通过 ${result.imported} 条（未写入）`);
  else parts.push(`已导入 ${result.imported} 条`);
  if (result.duplicated) parts.push(`重复 ${result.duplicated} 条`);
  if (result.invalid) parts.push(`无效 ${result.invalid} 条`);

  return ok(
    {
      ...result,
      group_id: groupId,
      dry_run: dryRun,
    },
    parts.join('，')
  );
});

export default external;
