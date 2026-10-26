import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { hashPassword, sha256Hex } from '../src/utils/crypto';

// ---------------------------------------------------------------------------
// Minimal settings-backed D1 stand-in. Only the statements the auth route and
// the accounts route actually issue are handled; anything else returns empty.
// ---------------------------------------------------------------------------
function createSettingsDB(initial: Record<string, string> = {}) {
  const settings = new Map<string, string>(Object.entries(initial));

  function makeStmt(sql: string) {
    const stmt = {
      sql,
      params: [] as unknown[],
      bind(...p: unknown[]) {
        stmt.params = p;
        return stmt;
      },
      async first() {
        if (/FROM settings WHERE key = \?/i.test(sql)) {
          const key = String(stmt.params[0]);
          return settings.has(key) ? { value: settings.get(key) } : null;
        }
        if (/FROM accounts a LEFT JOIN groups/i.test(sql)) {
          return {
            id: 5,
            email: 'a@b.com',
            password: 'mailbox-secret',
            client_id: 'cid',
            refresh_token: 'rt-value-1234567890',
            group_id: 1,
            remark: '',
            status: 'active',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            group_name: '默认分组',
            group_color: '#2563eb',
          };
        }
        return null;
      },
      async all() {
        return { results: [], meta: {} };
      },
      async run() {
        if (/INSERT OR REPLACE INTO settings/i.test(sql)) {
          settings.set(String(stmt.params[0]), String(stmt.params[1]));
        } else if (/DELETE FROM settings WHERE key IN/i.test(sql)) {
          for (const k of stmt.params) settings.delete(String(k));
        }
        return { results: [], meta: {} };
      },
    };
    return stmt;
  }

  return {
    db: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async (stmts: { sql: string; params: unknown[] }[]) =>
        stmts.map((s) => ({ results: [], meta: {} })),
    },
    settings,
  };
}

function loginRequest(db: unknown, password: string) {
  return import('../src/routes/auth').then(({ default: authRoute }) =>
    authRoute.request(
      '/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      },
      { DB: db, COOKIE_SECRET: 'test-cookie-secret-0123456789', ADMIN_PASSWORD: 'admin-pass' } as any
    )
  );
}

describe('POST /api/auth/login', () => {
  it('accepts the ADMIN_PASSWORD on first run and stores a PBKDF2 hash', async () => {
    const { db, settings } = createSettingsDB();
    const res = await loginRequest(db, 'admin-pass');
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(settings.get('login_password_hash')).toMatch(/^pbkdf2\$sha256\$/);
  });

  // Regression: the unsalted SHA-256 hash written by older versions must still
  // work, and must be upgraded in place on the way through.
  it('accepts and upgrades a legacy SHA-256 hash', async () => {
    const { db, settings } = createSettingsDB({ login_password_hash: await sha256Hex('old-pass') });
    const res = await loginRequest(db, 'old-pass');

    expect(res.status).toBe(200);
    expect(settings.get('login_password_hash')).toMatch(/^pbkdf2\$sha256\$/);
  });

  it('rejects a wrong password and counts the failure', async () => {
    const { db, settings } = createSettingsDB({ login_password_hash: await hashPassword('right') });
    const res = await loginRequest(db, 'wrong');

    expect(res.status).toBe(400);
    expect(settings.get('login_fail_count')).toBe('1');
    expect(settings.has('login_block_until')).toBe(false);
  });

  it('locks out after 5 failures', async () => {
    const { db, settings } = createSettingsDB({ login_password_hash: await hashPassword('right') });

    for (let i = 0; i < 5; i++) await loginRequest(db, 'wrong');

    const lockedUntil = parseInt(settings.get('login_block_until') ?? '0', 10);
    expect(lockedUntil).toBeGreaterThan(Date.now());

    // While locked, even the correct password is refused
    const res = await loginRequest(db, 'right');
    const body = (await res.json()) as any;
    expect(res.status).toBe(429);
    expect(body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('clears the failure counters after a successful login', async () => {
    const { db, settings } = createSettingsDB({
      login_password_hash: await hashPassword('right'),
      login_fail_count: '3',
    });

    const res = await loginRequest(db, 'right');
    expect(res.status).toBe(200);
    expect(settings.has('login_fail_count')).toBe(false);
    expect(settings.has('login_block_until')).toBe(false);
  });
});

describe('GET /api/accounts/:id', () => {
  it('never returns the stored mailbox password', async () => {
    const { db } = createSettingsDB();
    const accounts = (await import('../src/routes/accounts')).default;

    const res = await accounts.request('/5', {}, { DB: db } as any);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.data).not.toHaveProperty('password');
    expect(body.data.has_password).toBe(true);
    expect(body.data.refresh_token).toContain('****');
    // Listed explicitly rather than by spreading the row
    expect(Object.keys(body.data).sort()).toEqual(
      expect.arrayContaining(['id', 'email', 'client_id', 'status', 'has_password'])
    );
  });
});

// ---------------------------------------------------------------------------
// Panel refresh path: GET /api/accounts/:id/emails
// ---------------------------------------------------------------------------
describe('GET /api/accounts/:id/emails (panel refresh)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createAccountDB() {
    const account = {
      id: 5,
      email: 'me@outlook.com',
      client_id: 'cid',
      refresh_token: 'rt',
      password: '',
      group_id: 1,
      remark: '',
      status: 'active',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };
    return {
      prepare: (sql: string) => ({
        sql,
        params: [] as unknown[],
        bind(...p: unknown[]) {
          this.params = p;
          return this;
        },
        async first() {
          return /FROM accounts WHERE id = \?/i.test(sql) ? account : null;
        },
        async all() {
          return { results: [], meta: {} };
        },
        async run() {
          return { results: [], meta: {} };
        },
      }),
      batch: async () => [],
    };
  }

  // Fake Graph: the inbox grows between calls, like a real mailbox receiving mail
  it('shows mail that arrived since the previous fetch', async () => {
    let inbox = [
      {
        id: 'm1',
        subject: 'old mail',
        from: { emailAddress: { name: 'a', address: 'a@x.com' } },
        receivedDateTime: '2026-01-01T00:00:00Z',
        bodyPreview: 'old',
        isRead: true,
        hasAttachments: false,
      },
    ];

    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ value: inbox }) } as any;
    }) as any;

    const emailsRoute = (await import('../src/routes/emails')).default;
    // Mount exactly like src/index.ts does, so :id is provided by the parent
    const app = new Hono();
    app.route('/accounts/:id/emails', emailsRoute);
    const env = { DB: createAccountDB() } as any;

    const first = await app.request('/accounts/5/emails?top=30&skip=0&folder=inbox', {}, env);
    expect(((await first.json()) as any).data.items.map((m: any) => m.id)).toEqual(['m1']);

    // A new message arrives
    inbox = [
      {
        id: 'm2',
        subject: 'new mail',
        from: { emailAddress: { name: 'b', address: 'b@x.com' } },
        receivedDateTime: '2026-01-02T00:00:00Z',
        bodyPreview: 'new',
        isRead: false,
        hasAttachments: false,
      },
      ...inbox,
    ];

    const second = await app.request('/accounts/5/emails?top=30&skip=0&folder=inbox', {}, env);
    const body = (await second.json()) as any;

    expect(body.data.items.map((m: any) => m.id)).toEqual(['m2', 'm1']);
  });
});

// A stale cached GET would explain "refresh shows nothing while another URL
// returns the mail", so API responses are explicitly uncacheable.
describe('API cache headers', () => {
  it('marks /api responses as no-store', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        first: async () => (/sqlite_master/i.test(sql) ? { n: 7 } : null),
        all: async () => ({ results: [], meta: {} }),
        run: async () => ({ results: [], meta: {} }),
      }),
      batch: async () => [],
    };
    const worker = (await import('../src/index')).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
    const res = await worker.fetch(
      new Request('http://example.com/api/auth/me'),
      { DB: db, COOKIE_SECRET: 'test-secret' } as any,
      ctx
    );

    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('fetchEmails folder=all', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubGraph(rows: Record<string, { id: string; receivedDateTime: string }[]>) {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      calls.push(url);
      const folder = /mailFolders\/([^/]+)\//.exec(url)?.[1] ?? 'inbox';
      // URLSearchParams encodes "$top" as "%24top"
      const top = parseInt(/(?:%24|\$)top=(\d+)/.exec(url)?.[1] ?? '20', 10);
      // Graph returns newest first ($orderby=receivedDateTime desc)
      const sorted = [...(rows[folder] ?? [])].sort((a, b) =>
        b.receivedDateTime.localeCompare(a.receivedDateTime)
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ value: sorted.slice(0, top) }),
      } as any;
    }) as any;
    return calls;
  }

  it('serves the requested window instead of repeating page 1', async () => {
    const { fetchEmails } = await import('../src/graph');

    // 10 inbox + 10 junk; merge by date desc -> i9, j9, i8, j8, ...
    const rows = {
      inbox: Array.from({ length: 10 }, (_, i) => ({
        id: `i${i}`,
        receivedDateTime: `2026-01-01T00:00:${String(10 + i).padStart(2, '0')}Z`,
      })),
      junkemail: Array.from({ length: 10 }, (_, i) => ({
        id: `j${i}`,
        receivedDateTime: `2026-01-01T00:00:${String(10 + i).padStart(2, '0')}Z`,
      })),
    };
    const calls = stubGraph(rows);

    const page1 = await fetchEmails('token', { folder: 'all', top: 2, skip: 0 });
    const page2 = await fetchEmails('token', { folder: 'all', top: 2, skip: 2 });

    expect(page1.items?.map((m) => m.id)).toEqual(['i9', 'j9']);
    // Page 2 must advance, not repeat page 1
    expect(page2.items?.map((m) => m.id)).toEqual(['i8', 'j8']);
    expect(page1.hasMore).toBe(true);

    // skip + top rows had to be requested from each folder
    expect(calls.some((u) => /mailFolders\/inbox/.test(u) && /(?:%24|\$)top=4/.test(u))).toBe(true);
  });
});
