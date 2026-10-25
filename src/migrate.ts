// Runtime schema bootstrap.
//
// A freshly deployed Worker (especially one deployed straight from GitHub by
// Cloudflare Workers Builds) starts with an empty D1 database. Instead of
// failing the first request with "no such table", we create the schema on
// demand. Every statement is idempotent, so this is a no-op once the tables
// exist — the cost is a single cheap query per isolate.
//
// It also repairs *partially* migrated databases: a deployment from an older
// version may have `settings` but no `push_state`, so the probe checks for every
// table the schema declares, not just the first one.
//
// `wrangler d1 migrations apply` still works and stays the canonical path for
// versioned changes; this only guarantees that "deploy and open the URL" works.

import { SCHEMA_STATEMENTS } from './schema';
import { chunk } from './db';

// D1 allows a bounded number of statements per batch; the schema is small, but
// chunking keeps a future large migration from blowing the limit.
const STATEMENTS_PER_BATCH = 25;

// Every table the migrations create, derived from the generated schema so this
// list cannot drift out of sync when a migration is added.
export const REQUIRED_TABLES: readonly string[] = [
  ...new Set(
    SCHEMA_STATEMENTS.map(
      (sql) => /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/i.exec(sql)?.[1]
    ).filter((name): name is string => typeof name === 'string' && name.length > 0)
  ),
];

// Per-isolate memo. A fresh isolate re-checks once, which is what we want after
// a deploy that adds a migration.
let schemaVerified = false;

// Test hook: forget the memoised state.
export function resetSchemaState(): void {
  schemaVerified = false;
}

// True only when *all* declared tables exist (catches old/partial schemas).
export async function schemaIsPresent(db: D1Database): Promise<boolean> {
  if (!REQUIRED_TABLES.length) return false;
  try {
    const placeholders = REQUIRED_TABLES.map(() => '?').join(',');
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
      )
      .bind(...REQUIRED_TABLES)
      .first<{ n: number }>();
    const found = Number((row as { n?: number } | null)?.n ?? 0);
    return found >= REQUIRED_TABLES.length;
  } catch {
    return false;
  }
}

// Ensure the tables exist. Returns 'created' when this call built the schema,
// which the caller can log once.
export async function ensureSchema(db: D1Database): Promise<'ok' | 'created'> {
  if (schemaVerified) return 'ok';

  if (await schemaIsPresent(db)) {
    schemaVerified = true;
    return 'ok';
  }

  for (const part of chunk([...SCHEMA_STATEMENTS], STATEMENTS_PER_BATCH)) {
    await db.batch(part.map((sql) => db.prepare(sql)));
  }

  schemaVerified = true;
  console.log('D1 schema created (auto-migration on first request)');
  return 'created';
}
