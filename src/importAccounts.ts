// Account import execution — resolves the target group, filters out emails that
// already exist, and inserts the rest with as few D1 queries as possible.
//
// Query budget matters: the free plan allows ~50 queries per Worker invocation,
// so a multi-row INSERT (19 rows per statement, 5 bound params each) is used
// instead of one statement per account.

import { batchRun, chunk, first, D1_MAX_BOUND_PARAMS } from './db';
import type { ParsedAccount, ParseResult, RejectedAccount } from './utils/accountImport';

export const DEFAULT_GROUP_ID = 1;

// 5 bound params per row (email, password, client_id, refresh_token, group_id)
const PARAMS_PER_ROW = 5;
// 18 × 5 = 90 params, safely under D1's 100-bound-params-per-statement limit
const ROWS_PER_STATEMENT = 18;
// Keep each db.batch() call modest; one call per ~900 accounts would also be fine,
// but small batches give clearer partial-failure behaviour.
const STATEMENTS_PER_BATCH = 50;
// 1 param is reserved per chunk by the IN (...) list itself
const EMAIL_CHUNK = D1_MAX_BOUND_PARAMS - 1;

export type ImportStatus = 'imported' | 'would_import' | 'duplicate' | 'invalid';

export interface ImportRowResult {
  line: number;
  email?: string;
  status: ImportStatus;
  id?: number;
  reason?: string;
}

export interface ImportResult {
  total: number;
  imported: number;
  duplicated: number;
  invalid: number;
  results: ImportRowResult[];
}

// Resolve the target group. Returns null when the requested group is missing so
// the caller can answer with a real 400 instead of a foreign-key error.
export async function resolveGroupId(db: D1Database, groupId?: number): Promise<number | null> {
  if (groupId === undefined) return DEFAULT_GROUP_ID;
  if (!Number.isInteger(groupId)) return null;
  const row = await first<{ id: number }>(db, 'SELECT id FROM groups WHERE id = ?', [groupId]);
  return row ? row.id : null;
}

export async function importAccounts(
  db: D1Database,
  parsed: ParseResult,
  opts: { groupId: number; dryRun?: boolean }
): Promise<ImportResult> {
  const { accepted, rejected } = parsed;

  // 1) Which of these emails are already stored? (case-insensitive)
  const existing = new Set<string>();
  if (accepted.length) {
    const emails = [...new Set(accepted.map((a) => a.email.toLowerCase()))];
    const found = await batchRun<{ e: string }>(
      db,
      chunk(emails, EMAIL_CHUNK).map((part) => ({
        sql: `SELECT lower(email) AS e FROM accounts WHERE lower(email) IN (${part
          .map(() => '?')
          .join(',')})`,
        params: part,
      }))
    );
    for (const res of found) {
      for (const row of res.results ?? []) existing.add(row.e);
    }
  }

  // 2) Split into "to insert" and "already there"
  const toInsert: ParsedAccount[] = [];
  const results: ImportRowResult[] = [];
  for (const acc of accepted) {
    if (existing.has(acc.email.toLowerCase())) {
      results.push({
        line: acc.line,
        email: acc.email,
        status: 'duplicate',
        reason: '该邮箱已存在',
      });
      continue;
    }
    toInsert.push(acc);
  }
  for (const rej of rejected) results.push(toImportRow(rej));

  // 3) Insert. RETURNING gives us the new ids without a second round trip;
  // OR IGNORE makes a concurrent insert of the same email harmless.
  const insertedIds = new Map<string, number>();
  if (toInsert.length && !opts.dryRun) {
    const statements = chunk(toInsert, ROWS_PER_STATEMENT).map((part) => ({
      sql: `INSERT OR IGNORE INTO accounts (email, password, client_id, refresh_token, group_id) VALUES ${part
        .map(() => '(?, ?, ?, ?, ?)')
        .join(', ')} RETURNING id, lower(email) AS e`,
      params: part.flatMap((a) => [
        a.email,
        a.password,
        a.client_id,
        a.refresh_token,
        opts.groupId,
      ]),
    }));

    const batches = chunk(statements, STATEMENTS_PER_BATCH);
    for (const batch of batches) {
      const res = await batchRun<{ id: number; e: string }>(db, batch);
      for (const r of res) {
        for (const row of r.results ?? []) insertedIds.set(row.e, row.id);
      }
    }
  }

  for (const acc of toInsert) {
    const id = insertedIds.get(acc.email.toLowerCase());
    results.push({
      line: acc.line,
      email: acc.email,
      status: opts.dryRun ? 'would_import' : 'imported',
      ...(id !== undefined ? { id } : {}),
    });
  }

  results.sort((a, b) => a.line - b.line);

  const imported = results.filter((r) => r.status === 'imported' || r.status === 'would_import').length;
  const duplicated = results.filter((r) => r.status === 'duplicate').length;
  const invalid = results.filter((r) => r.status === 'invalid').length;

  return { total: results.length, imported, duplicated, invalid, results };
}

function toImportRow(rej: RejectedAccount): ImportRowResult {
  return {
    line: rej.line,
    ...(rej.email ? { email: rej.email } : {}),
    status: rej.kind === 'duplicate' ? 'duplicate' : 'invalid',
    reason: rej.reason,
  };
}
