import { describe, it, expect } from 'vitest';
import {
  parseAccountLine,
  parseAccountText,
  parseAccountList,
  parseAccountPayload,
  MAX_IMPORT_ITEMS,
} from '../src/utils/accountImport';

// ---------- parser ----------

describe('parseAccountLine', () => {
  it('parses the 4-field export format', () => {
    const r = parseAccountLine('a@b.com----pwd----cid-123----rt-456', 1);
    expect(r).toEqual({
      line: 1,
      email: 'a@b.com',
      password: 'pwd',
      client_id: 'cid-123',
      refresh_token: 'rt-456',
    });
  });

  it('accepts an empty password', () => {
    const r = parseAccountLine('a@b.com--------cid----rt', 2);
    expect('reason' in r).toBe(false);
    expect((r as { password: string }).password).toBe('');
  });

  it('rejects the ambiguous 3-field variant instead of guessing', () => {
    expect(parseAccountLine('a@b.com----cid----rt', 3)).toMatchObject({ line: 3 });
    expect((parseAccountLine('a@b.com----cid----rt', 3) as { reason: string }).reason).toContain('字段不足');
  });

  it('keeps a token that contains the separator', () => {
    const r = parseAccountLine('a@b.com----pwd----cid----part1----part2', 4);
    expect((r as { refresh_token: string }).refresh_token).toBe('part1----part2');
  });

  it('rejects bad email / missing fields with a reason', () => {
    expect(parseAccountLine('not-an-email----p----c----r', 1)).toMatchObject({ reason: '邮箱格式不正确' });
    expect(parseAccountLine('a@b.com----pwd', 2)).toMatchObject({ line: 2 });
    expect(parseAccountLine('a@b.com----pwd----cid----', 3)).toMatchObject({ reason: 'refresh_token 为空' });
  });
});

describe('parseAccountText', () => {
  it('skips blank lines and comments, keeps physical line numbers', () => {
    const parsed = parseAccountText(
      ['# comment', '', 'a@b.com----p----c----r', '   ', 'c@d.com----p----c----r'].join('\n')
    );
    expect(parsed.accepted.map((a) => a.line)).toEqual([3, 5]);
    expect(parsed.rejected).toHaveLength(0);
  });

  it('rejects duplicates inside the same payload (case-insensitive)', () => {
    const parsed = parseAccountText('a@b.com----p----c----r\nA@B.com----p----c----r2');
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.rejected[0]).toMatchObject({ line: 2, email: 'A@B.com' });
    expect(parsed.rejected[0].reason).toContain('重复');
  });
});

describe('parseAccountList / parseAccountPayload', () => {
  it('accepts objects with snake_case and camelCase keys', () => {
    const parsed = parseAccountList([
      { email: 'a@b.com', client_id: 'c1', refresh_token: 'r1' },
      { email: 'c@d.com', clientId: 'c2', refreshToken: 'r2' },
    ]);
    expect(parsed.accepted.map((a) => a.client_id)).toEqual(['c1', 'c2']);
  });

  it('accepts mixed string/object arrays', () => {
    const parsed = parseAccountList(['a@b.com----p----c----r', { email: 'c@d.com', client_id: 'c', refresh_token: 'r' }]);
    expect(parsed.accepted).toHaveLength(2);
  });

  it('unwraps account_string / accounts / single-object shapes', () => {
    expect(parseAccountPayload({ account_string: 'a@b.com----p----c----r' }).accepted).toHaveLength(1);
    expect(parseAccountPayload({ accounts: [{ email: 'a@b.com', client_id: 'c', refresh_token: 'r' }] }).accepted).toHaveLength(1);
    expect(parseAccountPayload({ email: 'a@b.com', client_id: 'c', refresh_token: 'r' }).accepted).toHaveLength(1);
    expect(parseAccountPayload('a@b.com----p----c----r').accepted).toHaveLength(1);
  });

  it('reports an unusable payload instead of throwing', () => {
    expect(parseAccountPayload(null).rejected[0].reason).toContain('请求体为空');
    expect(parseAccountPayload({ nope: 1 }).rejected[0].reason).toContain('无法识别');
  });
});

// ---------- route ----------

interface MockOpts {
  apiKey?: string | null;
  groups?: number[];
  existing?: string[];
}

// Minimal D1 stand-in: matches the handful of statements the import path issues.
function createImportDB(opts: MockOpts = {}) {
  const state = {
    apiKey: opts.apiKey === undefined ? 'test-key' : opts.apiKey,
    groups: opts.groups ?? [1],
    existing: (opts.existing ?? []).map((e) => e.toLowerCase()),
    inserted: [] as string[][],
    nextId: 100,
  };

  function respond(sql: string, params: unknown[]): { results: any[]; meta: Record<string, unknown> } {
    const s = sql.trim();

    if (/FROM settings WHERE key = 'external_api_key'/i.test(s)) {
      return { results: state.apiKey ? [{ value: state.apiKey }] : [], meta: {} };
    }
    if (/^SELECT id FROM groups WHERE id = \?/i.test(s)) {
      const id = Number(params[0]);
      return { results: state.groups.includes(id) ? [{ id }] : [], meta: {} };
    }
    if (/^SELECT lower\(email\) AS e FROM accounts/i.test(s)) {
      const wanted = params.map((p) => String(p).toLowerCase());
      return { results: wanted.filter((e) => state.existing.includes(e)).map((e) => ({ e })), meta: {} };
    }
    if (/^INSERT OR IGNORE INTO accounts/i.test(s)) {
      const rows: { id: number; e: string }[] = [];
      for (let i = 0; i + 4 < params.length; i += 5) {
        const email = String(params[i]);
        const key = email.toLowerCase();
        if (state.existing.includes(key)) continue; // OR IGNORE
        state.existing.push(key);
        state.inserted.push(params.slice(i, i + 5).map((p) => String(p)));
        rows.push({ id: state.nextId++, e: key });
      }
      return { results: rows, meta: {} };
    }
    if (/FROM accounts a LEFT JOIN groups/i.test(s)) {
      return { results: [{ id: 1, email: 'a@b.com', status: 'active', group_id: 1, remark: '', created_at: 'x', group_name: '默认分组' }], meta: {} };
    }
    return { results: [], meta: {} };
  }

  function makeStmt(sql: string) {
    const stmt = {
      sql,
      params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt.params = p;
        return stmt;
      },
      all: async () => respond(sql, stmt.params),
      first: async () => respond(sql, stmt.params).results[0] ?? null,
      run: async () => respond(sql, stmt.params),
    };
    return stmt;
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: { sql: string; params: unknown[] }[]) =>
      stmts.map((st) => respond(st.sql, st.params)),
  };

  return { db, state };
}

async function postAccounts(body: unknown, opts: MockOpts & { query?: string; contentType?: string; key?: string } = {}) {
  const external = (await import('../src/routes/external')).default;
  const { db, state } = createImportDB(opts);
  const contentType = opts.contentType ?? 'application/json';
  // text/* bodies go out raw (that is the point of the text branch); anything else
  // must be valid JSON, exactly like a real caller.
  const payload = contentType.startsWith('text/') ? String(body) : JSON.stringify(body);
  const res = await external.request(
    `/accounts${opts.query ?? ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-API-Key': opts.key ?? 'test-key' },
      body: payload,
    },
    { DB: db } as any
  );
  return { res, state, json: (await res.json()) as any };
}

describe('POST /api/external/accounts', () => {
  it('imports text/plain lines and returns ids', async () => {
    const { res, json, state } = await postAccounts(
      'a@b.com----pwd----cid----rt\nc@d.com----pwd2----cid2----rt2',
      { contentType: 'text/plain' }
    );
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ total: 2, imported: 2, duplicated: 0, invalid: 0, group_id: 1 });
    expect(json.data.results.map((r: any) => r.id)).toEqual([100, 101]);
    expect(state.inserted[0]).toEqual(['a@b.com', 'pwd', 'cid', 'rt', '1']);
  });

  it('flags already-stored emails as duplicates', async () => {
    const { json, state } = await postAccounts('a@b.com----p----c----r', { existing: ['A@B.com'] });
    expect(json.data).toMatchObject({ imported: 0, duplicated: 1 });
    expect(json.data.results[0].status).toBe('duplicate');
    expect(state.inserted).toHaveLength(0);
  });

  it('imports the valid lines and reports the invalid ones', async () => {
    const { json } = await postAccounts('a@b.com----p----c----r\nbroken-line');
    expect(json.data).toMatchObject({ total: 2, imported: 1, invalid: 1 });
    expect(json.data.results[1]).toMatchObject({ status: 'invalid', line: 2 });
  });

  it('honours dry_run without writing', async () => {
    const { json, state } = await postAccounts('a@b.com----p----c----r', { query: '?dry_run=1' });
    expect(json.data).toMatchObject({ imported: 1, dry_run: true });
    expect(json.data.results[0].status).toBe('would_import');
    expect(state.inserted).toHaveLength(0);
  });

  it('accepts a JSON accounts array and a custom group', async () => {
    const { json, state } = await postAccounts(
      { accounts: [{ email: 'a@b.com', client_id: 'c', refresh_token: 'r' }], group_id: 7 },
      { groups: [1, 7] }
    );
    expect(json.data.group_id).toBe(7);
    expect(state.inserted[0][4]).toBe('7');
  });

  it('rejects an unknown group', async () => {
    const { res, json } = await postAccounts('a@b.com----p----c----r', { query: '?group_id=99' });
    expect(res.status).toBe(400);
    expect(json.error.code).toBe('BAD_REQUEST');
  });

  it('rejects empty payloads and oversized batches', async () => {
    expect((await postAccounts({ account_string: '   ' })).res.status).toBe(400);
    const tooMany = Array.from({ length: MAX_IMPORT_ITEMS + 1 }, (_, i) => `u${i}@b.com----p----c----r`).join('\n');
    expect((await postAccounts(tooMany, { contentType: 'text/plain' })).res.status).toBe(400);
  });

  it('enforces the API key', async () => {
    expect((await postAccounts('a@b.com----p----c----r', { key: 'wrong' })).res.status).toBe(401);
    const disabled = await postAccounts('a@b.com----p----c----r', { apiKey: null });
    expect(disabled.res.status).toBe(403);
  });
});

describe('GET /api/external/accounts', () => {
  it('lists account metadata without tokens', async () => {
    const external = (await import('../src/routes/external')).default;
    const { db } = createImportDB();
    const res = await external.request(
      '/accounts?limit=10',
      { headers: { 'X-API-Key': 'test-key' } },
      { DB: db } as any
    );
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.data.items[0]).toMatchObject({ email: 'a@b.com', group_name: '默认分组' });
    expect(json.data.items[0].refresh_token).toBeUndefined();
  });
});

describe('POST /api/accounts (cookie-auth batch import)', () => {
  it('keeps the legacy response shape and reports duplicates', async () => {
    const accounts = (await import('../src/routes/accounts')).default;
    const { db } = createImportDB({ existing: ['c@d.com'] });
    const res = await accounts.request(
      '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_string: 'a@b.com----p----c----r\nc@d.com----p----c----r',
          group_id: 1,
        }),
      },
      { DB: db } as any
    );
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ added: 1, duplicated: 1 });
    expect(json.message).toContain('成功添加 1 个账号');
  });

  it('explains why nothing was added', async () => {
    const accounts = (await import('../src/routes/accounts')).default;
    const { db } = createImportDB();
    const res = await accounts.request(
      '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_string: 'garbage' }),
      },
      { DB: db } as any
    );
    const json = (await res.json()) as any;
    expect(res.status).toBe(400);
    expect(json.error.message).toContain('字段不足');
  });
});
