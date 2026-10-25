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

function runWrangler(args, { capture = false, stdin } = {}) {
  const { cmd, prefix } = wranglerBin();
  const base = { cwd: root, encoding: 'utf8', env: process.env };

  // A child process cannot inherit stdio and also receive piped stdin.
  if (stdin !== undefined) {
    return execFileSync(cmd, [...prefix, ...args], {
      ...base,
      input: stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return execFileSync(cmd, [...prefix, ...args], {
    ...base,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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

// Worker secrets are persistent: a redeploy keeps whatever is already stored.
// They are only re-applied when the values are present in the environment
// (GitHub Actions job env, or Workers Builds build variables), which is what
// lets a repo keep them in GitHub Secrets instead of re-entering them.
const SYNCABLE_SECRETS = ['ADMIN_PASSWORD', 'COOKIE_SECRET', 'GPTMAIL_API_KEY'];

function syncSecrets() {
  const present = SYNCABLE_SECRETS.filter((name) => (process.env[name] || '').trim() !== '');
  if (!present.length) {
    log('环境里没有 ADMIN_PASSWORD / COOKIE_SECRET，跳过 Secret 同步');
    log('  Worker 上已有的 Secret 会保留（重新部署不会清空）。');
    return;
  }

  log(`同步 Secret：${present.join(', ')}`);
  // Values go through stdin: nothing is written to disk, nothing is logged.
  const payload = {};
  for (const name of present) payload[name] = process.env[name];

  try {
    runWrangler(['secret', 'bulk'], { stdin: JSON.stringify(payload) });
  } catch (e) {
    const detail = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').filter(Boolean).pop();
    console.error(`\n[deploy] Worker 已部署，但 Secret 写入失败：${detail || e.message}`);
    console.error('[deploy] Worker 现在缺密钥，登录会提示「服务端密钥未配置」。');
    console.error('[deploy] 检查 API Token 是否有 Workers Scripts:Edit 权限，或到控制台 Settings → Variables and Secrets 手动添加。\n');
    process.exit(1);
  }
  log(`已写入 ${present.length} 个 Secret（值不回显）`);
}

// Admins have been bitten by "my variables disappeared after a redeploy" — a
// dashboard Variable added as Type=Text is pruned by `wrangler deploy` unless
// the config declares it or keep_vars is set. Secret-type values are always
// inherited. Report what the Worker actually has so the state is never a guess.
const REQUIRED_SECRETS = ['ADMIN_PASSWORD', 'COOKIE_SECRET'];

function verifySecrets() {
  let names;
  try {
    const out = runWrangler(['secret', 'list'], { capture: true });
    const parsed = parseJsonArray(out);
    if (!Array.isArray(parsed)) return;
    names = parsed.map((s) => (s && (s.name || s.key)) || '').filter(Boolean);
  } catch {
    // Listing needs the same permission as deploying; if it fails, stay quiet.
    return;
  }

  const missing = REQUIRED_SECRETS.filter((n) => !names.includes(n));
  if (!missing.length) {
    log(`Worker 上的 Secret：${names.join(', ')}`);
    return;
  }

  log(`⚠️  Worker 上缺少：${missing.join(', ')}`);
  log('   登录会提示「服务端密钥未配置」。两种补法：');
  log('   1) 控制台 Worker → Settings → Variables and Secrets → Add，类型必须选 Secret（不是 Text）');
  log('   2) 在环境里提供 ADMIN_PASSWORD / COOKIE_SECRET 后重跑本脚本，会自动写入');
  log('   注意：类型选成 Text 的变量不是 Secret，虽然本仓库已设 keep_vars = true 不会再被删，');
  log('        但仍建议改用 Secret 类型，避免明文出现在控制台和构建日志里。');
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
// --keep-vars is also set in wrangler.toml, but passing it here makes the
// guarantee independent of the config file: without it wrangler "will delete
// all vars before setting those found in the Wrangler configuration", which is
// how dashboard Variables kept disappearing on every redeploy.
runWrangler(['deploy', '--keep-vars']);

// Secrets are applied after the script exists (a brand-new Worker has no
// secret store to write into). Existing secrets survive redeploys untouched.
syncSecrets();
verifySecrets();

log('完成。打开 Worker 的网址即可登录。');
if (!(process.env.ADMIN_PASSWORD || '').trim()) {
  log('提示：若 Worker 上还没有 ADMIN_PASSWORD / COOKIE_SECRET，登录会提示「服务端密钥未配置」。');
  log('  设一次就行，之后每次重新部署都会保留：控制台 Settings → Variables and Secrets，或设置环境变量后重跑本脚本。');
}
