import { describe, it, expect, beforeEach } from 'vitest';
import { ensureSchema, schemaIsPresent, resetSchemaState, REQUIRED_TABLES } from '../src/migrate';
import { SCHEMA_STATEMENTS, SCHEMA_SOURCE_FILES } from '../src/schema';

// Minimal D1 stand-in. The probe does prepare(...).bind(...).first() and reads
// { n }: returning `tables.length` means "schema complete", a smaller number
// means "old/partial schema".
function createDB(presentTables: string[], opts: { batchThrows?: string } = {}) {
  const batches: string[][] = [];
  const state = { tables: [...presentTables] };

  function makeStmt(sql: string) {
    const stmt = {
      sql,
      bind() {
        return stmt;
      },
      first: async () => {
        if (!/sqlite_master/i.test(sql)) throw new Error('D1_ERROR: no such table: settings');
        return { n: state.tables.length };
      },
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], meta: {} }),
    };
    return stmt;
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: { sql: string }[]) => {
      if (opts.batchThrows) throw new Error(opts.batchThrows);
      batches.push(stmts.map((s) => s.sql));
      state.tables = [...REQUIRED_TABLES];
      return stmts.map(() => ({ results: [], meta: {} }));
    },
  };

  return { db, batches, state };
}

beforeEach(() => resetSchemaState());

describe('schema statements', () => {
  it('are generated from the migration files', () => {
    expect(SCHEMA_SOURCE_FILES).toEqual(['0001_init.sql', '0002_tags.sql', '0003_push_state.sql']);
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThanOrEqual(9);
  });

  // The whole auto-migration design rests on being able to re-run this safely.
  it('are all idempotent', () => {
    for (const sql of SCHEMA_STATEMENTS) {
      expect(sql).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|INSERT OR IGNORE)/);
    }
  });

  it('declare every expected table', () => {
    expect(REQUIRED_TABLES).toEqual(
      expect.arrayContaining([
        'settings',
        'groups',
        'accounts',
        'temp_emails',
        'tags',
        'account_tags',
        'push_state',
      ])
    );
  });
});

describe('schema detection', () => {
  it('reports a fresh database as not present', async () => {
    const { db } = createDB([]);
    await expect(schemaIsPresent(db as any)).resolves.toBe(false);
  });

  it('reports a complete schema as present', async () => {
    const { db } = createDB([...REQUIRED_TABLES]);
    await expect(schemaIsPresent(db as any)).resolves.toBe(true);
  });

  // Regression: an older deployment has `settings` but not `push_state`.
  // Probing only `settings` would skip the migration and later queries would
  // blow up on the missing table.
  it('treats a partial schema as incomplete', async () => {
    const { db } = createDB(['settings', 'groups', 'accounts']);
    await expect(schemaIsPresent(db as any)).resolves.toBe(false);
  });
});

describe('ensureSchema', () => {
  it('creates the schema on an empty database and reports it', async () => {
    const { db, batches } = createDB([]);

    await expect(ensureSchema(db as any)).resolves.toBe('created');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(SCHEMA_STATEMENTS.length);
    expect(batches[0][0]).toContain('CREATE TABLE IF NOT EXISTS settings');
  });

  it('repairs a partial (older) schema', async () => {
    const { db, batches } = createDB(['settings', 'accounts']);
    await expect(ensureSchema(db as any)).resolves.toBe('created');
    expect(batches).toHaveLength(1);
  });

  it('skips the work once the schema is complete', async () => {
    const { db, batches } = createDB([...REQUIRED_TABLES]);
    await expect(ensureSchema(db as any)).resolves.toBe('ok');
    expect(batches).toHaveLength(0);
  });

  it('memoises per isolate instead of querying every call', async () => {
    const { db, batches } = createDB([]);
    await ensureSchema(db as any);
    await ensureSchema(db as any);
    await ensureSchema(db as any);
    expect(batches).toHaveLength(1);
  });

  it('re-checks after a reset (e.g. new isolate)', async () => {
    const { db, batches } = createDB([]);
    await ensureSchema(db as any);
    resetSchemaState();
    // DB reports complete now, so the second pass is a no-op probe
    await expect(ensureSchema(db as any)).resolves.toBe('ok');
    expect(batches).toHaveLength(1);
  });

  it('propagates a failure so the caller can surface it', async () => {
    const { db } = createDB([], { batchThrows: 'D1_ERROR: database is locked' });
    await expect(ensureSchema(db as any)).rejects.toThrow('database is locked');
  });

  it('does not memoise a failed attempt', async () => {
    const { db } = createDB([], { batchThrows: 'D1_ERROR: database is locked' });
    await expect(ensureSchema(db as any)).rejects.toThrow();
    // A second call must retry rather than silently claim success
    await expect(ensureSchema(db as any)).rejects.toThrow();
  });
});
