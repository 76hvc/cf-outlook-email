// Runtime schema bootstrap.
//
// A freshly deployed Worker (especially one deployed straight from GitHub by
// Cloudflare Workers Builds) starts with an empty D1 database. Instead of
// failing the first request with "no such table", we create the schema on
// demand. Every statement is idempotent, so this is a no-op once the tables
// exist — the cost is a single cheap query per isolate.
//
// `wrangler d1 migrations apply` still works and stays the canonical path for
// versioned changes; this only guarantees that "deploy and open the URL" works.

import { SCHEMA_STATEMENTS } from './schema';
import { chunk } from './db';

// D1 allows a bounded number of statements per batch; the schema is small, but
// chunking keeps a future large migration from blowing the limit.
const STATEMENTS_PER_BATCH = 25;

// Per-isolate memo. A fresh isolate re-checks once, which is what we want after
// a deploy that adds a migration.
let schemaVerified = false;

// Test hook: forget the memoised state.
export function resetSchemaState(): void {
  schemaVerified = false;
}

// Does the schema exist? `settings` is created by the first migration, so it is
// the cheapest reliable probe.
export async function schemaIsPresent(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT 1 FROM settings LIMIT 1').first();
    return true;
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
