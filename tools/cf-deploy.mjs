#!/usr/bin/env node
// One-step deploy for the "connect the GitHub repo to Cloudflare" flow.
//
// Cloudflare Workers Builds runs this as the deploy command instead of a bare
// `wrangler deploy`, so a brand-new account needs no manual resource setup:
//
//   1. Make sure the D1 database exists (create it if the account has none)
//   2. Write the real database_id into wrangler.toml
//   3. Apply the SQL migrations remotely
//   4. wrangler deploy
//
// Steps 1-2 only run while wrangler.toml still holds the placeholder id, so a
// repo that has already been configured deploys straight through.
//
// An existing database with the same name is REUSED, never recreated — that is
// what makes redeploys safe and keeps previously imported accounts. The script
// prints which database it bound so this is never a surprise.
//
// Usage:  node tools/cf-deploy.mjs        (or: pnpm run deploy:cf)
//         D1_DB_NAME=my-other-db node tools/cf-deploy.mjs   # target a different DB

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(root, 'wrangler.toml');
const PLACEHOLDER = 'REPLACE_WITH_YOUR_DATABASE_ID';
// Override when the database already exists under another name.
const DB_NAME = (process.env.D1_DB_NAME || 'outlook-email-db').trim();

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

function fail(msg) {
  console.error(`\n[deploy] 失败：${msg}\n`);
  process.exit(1);
}

// Resolve the locally installed wrangler so no PATH / npx lookup is involved
// (Workers Builds runs with pnpm; pnpm's node_modules layout still exposes the
// real package folder under node_modules/wrangler).
function wranglerBin() {
  const local = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (fs.existsSync(local)) return { cmd: process.execPath, prefix: [local] };
  return { cmd: 'npx', prefix: ['--no-install', 'wrangler'] };
}

function runWrangler(args, { capture = false } = {}) {
  const { cmd, prefix } = wranglerBin();
  return execFileSync(cmd, [...prefix, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
  });
}

function readConfig() {
  if (!fs.existsSync(CONFIG)) fail('找不到 wrangler.toml');
  return fs.readFileSync(CONFIG, 'utf8');
}

function configuredId(config) {
  const m = /^\s*database_id\s*=\s*"([^"]*)"/m.exec(config);
  return m ? m[1].trim() : '';
}

// Pull a JSON array out of wrangler's stdout, which may carry banner lines.
function parseJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// { uuid, name } or null
function findExistingDatabase() {
  let out;
  try {
    out = runWrangler(['d1', 'list', '--json'], { capture: true });
  } catch (e) {
    fail(
      '无法读取 D1 数据库列表（缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，或未登录）。\n' +
        `  请在 Cloudflare 控制台创建/选择 D1 数据库，把它的 Database ID 填进 wrangler.toml 后重试。\n` +
        '  本地错误：' + (e.stderr || e.message || String(e)).trim().split('\n')[0]
    );
  }
  const list = parseJsonArray(out);
  if (!Array.isArray(list)) return null;
  const uuid = (db) => db && (db.uuid || db.database_id || '');
  const name = (db) => db && (db.name || db.database_name || '');

  const hit = list.find((db) => name(db) === DB_NAME);
  if (hit) return { uuid: uuid(hit), name: name(hit) };
  return null;
}

// { uuid, name } or null
function createDatabase() {
  log(`未找到同名数据库，创建 D1 数据库 ${DB_NAME} …`);
  let out;
  try {
    out = runWrangler(['d1', 'create', DB_NAME], { capture: true });
  } catch (e) {
    const msg = `${e.stdout || ''}\n${e.stderr || ''}`;
    // "already exists" (e.g. a parallel build won the race): look it up instead
    if (/already exists|already_exist/i.test(msg)) return findExistingDatabase();
    fail(
      `无法创建 D1 数据库。请在 Cloudflare 控制台手动创建 ${DB_NAME}，` +
        '把 Database ID 填进 wrangler.toml 后重新部署。\n  错误：' +
        msg.trim().split('\n').filter(Boolean).slice(-1)[0]
    );
  }
  const m = /database_id\s*=\s*"([^"]+)"/.exec(out) || /"uuid"\s*:\s*"([^"]+)"/.exec(out);
  if (!m) return findExistingDatabase();
  return { uuid: m[1], name: DB_NAME };
}

// Point wrangler.toml at the database we settled on (id and, if renamed, name).
function writeBinding(config, uuid, name) {
  let updated = config.replace(
    new RegExp(`(^\\s*database_id\\s*=\\s*)"[^"]*"`, 'm'),
    `$1"${uuid}"`
  );
  if (name && name !== readName(updated)) {
    updated = updated.replace(/(^\s*database_name\s*=\s*)"[^"]*"/m, `$1"${name}"`);
  }
  if (updated === config) fail('没能把 database_id 写进 wrangler.toml（占位符已变化？）');
  fs.writeFileSync(CONFIG, updated, 'utf8');
}

function readName(config) {
  const m = /^\s*database_name\s*=\s*"([^"]*)"/m.exec(config);
  return m ? m[1].trim() : '';
}

// ---- main ----

let config = readConfig();
let id = configuredId(config);

if (!id || id === PLACEHOLDER) {
  log('wrangler.toml 里还是占位符，查找可用的 D1 数据库 …');

  let target = findExistingDatabase();
  if (target) {
    log(`复用已存在的数据库：${target.name}（${target.uuid}）`);
    log('  原有数据保持不动，表结构只做增量补齐（全部语句都是 IF NOT EXISTS）。');
  } else {
    target = createDatabase();
  }
  if (!target || !target.uuid) fail(`没有拿到 ${DB_NAME} 的 database_id，请手动填入 wrangler.toml`);

  writeBinding(config, target.uuid, target.name);
  log(`已写入 wrangler.toml：database_id = ${target.uuid}`);
  config = readConfig();
} else {
  log(`wrangler.toml 已配置 database_id：${id}（不再自动查找/创建数据库）`);
  const name = readName(config);
  if (name) log(`  绑定库名：${name}`);
}

// Migrations are optional: the Worker also creates the schema on first request
// (src/migrate.ts), so a permissions hiccup here must not break the deploy.
try {
  log('应用数据库迁移 …');
  runWrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
} catch (e) {
  log('迁移未成功（不影响部署：首次请求会自动补齐表结构）');
  const detail = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').filter(Boolean).pop();
  if (detail) log(`  原因：${detail}`);
}

log('部署 Worker …');
runWrangler(['deploy']);
log('完成。首次打开页面时用 ADMIN_PASSWORD 登录（若数据库里已有旧密码哈希，则以旧密码为准，可在「系统设置」里改）。');
