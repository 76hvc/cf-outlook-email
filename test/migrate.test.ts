import { describe, it, expect, beforeEach } from 'vitest';
import { ensureSchema, schemaIsPresent, resetSchemaState } from '../src/migrate';
import { SCHEMA_STATEMENTS, SCHEMA_SOURCE_FILES } from '../src/schema';

// Minimal D1 stand-in: `prepare().first()` throws until the batch() call has run,
// which mirrors "empty database" -> "migrated database".
function createDB(initial: 'empty' | 'ready' = 'empty') {
  const batches: string[][] = [];
  let ready = initial === 'ready';

  const db = {
    prepare: (sql: string) => ({
      sql,
      bind() {
        return this;
      },
      first: async () => {
        if (!ready) throw new Error('D1_ERROR: no such table: settings');
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ results: [], meta: {} }),
    }),
    batch: async (stmts: { sql: string }[]) => {
      batches.push(stmts.map((s) => s.sql));
      ready = true;
      return stmts.map(() => ({ results: [], meta: {} }));
    },
  };

  return { db, batches };
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
});

describe('ensureSchema', () => {
  it('creates the schema on an empty database and reports it', async () => {
    const { db, batches } = createDB('empty');

    await expect(schemaIsPresent(db as any)).resolves.toBe(false);
    await expect(ensureSchema(db as any)).resolves.toBe('created');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(SCHEMA_STATEMENTS.length);
    expect(batches[0][0]).toContain('CREATE TABLE IF NOT EXISTS settings');
  });

  it('skips the work once the schema is present', async () => {
    const { db, batches } = createDB('ready');
    await expect(ensureSchema(db as any)).resolves.toBe('ok');
    expect(batches).toHaveLength(0);
  });

  it('memoises per isolate instead of querying every call', async () => {
    const { db, batches } = createDB('empty');
    await ensureSchema(db as any);
    await ensureSchema(db as any);
    await ensureSchema(db as any);
    expect(batches).toHaveLength(1);
  });

  it('re-checks after a reset (e.g. new isolate)', async () => {
    const { db, batches } = createDB('empty');
    await ensureSchema(db as any);
    resetSchemaState();
    // DB reports ready now, so the second pass is a no-op probe
    await expect(ensureSchema(db as any)).resolves.toBe('ok');
    expect(batches).toHaveLength(1);
  });

  it('propagates a failure so the caller can surface it', async () => {
    const db = {
      prepare: () => ({
        first: async () => {
          throw new Error('D1_ERROR: no such table: settings');
        },
      }),
      batch: async () => {
        throw new Error('D1_ERROR: database is locked');
      },
    };
    await expect(ensureSchema(db as any)).rejects.toThrow('database is locked');
  });
});
