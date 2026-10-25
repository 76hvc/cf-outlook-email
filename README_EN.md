# 📬 Outlook Email Manager

<div align="center">

**Lightweight Outlook email manager powered by Cloudflare Workers**

🆓 100% Free · ☁️ No Server Required · 🌍 Global CDN · 🌗 Dark/Light Theme · 🌐 Bilingual UI

[![License: GPL-3.0](https://img.shields.io/badge/License/GPL%203.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![D1](https://img.shields.io/badge/D1-SQLite-003B57?logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/76hvc/cf-outlook-email/pulls)
[![CI](https://github.com/76hvc/cf-outlook-email/actions/workflows/ci.yml/badge.svg)](https://github.com/76hvc/cf-outlook-email/actions/workflows/ci.yml)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/76hvc/cf-outlook-email)

☝️ The button clones the repo and builds it. This repo ships its own `wrangler.toml`, but `database_id`
is still a placeholder — follow **Option 1 / Option 2** below to get a working deployment.

🌐 [中文](./README.md) · 📖 [Deployment Guide](./docs/GUIDE.md) · 🔌 [API Docs](./docs/API.md)

</div>

---

| 🌙 Dark | ☀️ Light |
|:---:|:---:|
| ![Dark mode](./docs/preview.png) | ![Light mode](./docs/preview-light.png) |

## ✨ Features

- 🔐 **One-Click OAuth** — Authorize Outlook accounts via browser popup, no manual token copying
- 🔄 **Auto Token Refresh** — Automatically saves new refresh tokens on each use, preventing expiry
- 📦 **Batch Operations** — Import/export/delete/move in bulk, including per-row & selected export, with group & status filters
- 📨 **Email Reading** — Read inbox / junk / deleted via Microsoft Graph API with folder switching, aggregated view, paginated load-more, search and HTML rendering
- 📭 **Temp Email** — GPTMail API integration for disposable email addresses
- 🎨 **Polished Themes** — Dark / Light / Auto with glassmorphism, circle-swoop transition & ambient breathing glow
- 🌐 **Bilingual UI** — Chinese by default, one-click switch to English in the topbar, preference remembered locally, backend messages translated on display
- 🆓 **Completely Free** — Runs on Cloudflare's free tier, no credit card needed
- ⚡ **Deploy from Git** — `wrangler.toml` ships with the repo, so "Connect to Git" builds and deploys automatically; the database schema is created on the first request, no manual migration step

## 🚀 Deploy

### Option 1: Connect the GitHub repo (recommended — every push redeploys)

> No local tooling needed; everything happens in the browser.

**1. Fork the repo**

Open <https://github.com/76hvc/cf-outlook-email> → **Fork** (top right).

**2. Connect the repo in Cloudflare**

Dashboard → **Workers & Pages** → **Create application** → **Workers** → **Connect to Git** → authorize GitHub → pick your fork.

**3. Build settings**

| Field | Value |
|-------|-------|
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy:cf` |

`deploy:cf` will **create the D1 database**, write its `database_id` into `wrangler.toml`, apply the schema, and deploy the Worker.
(If the build environment lacks permission to create databases it fails with a clear message — use "Manual database setup" below instead.)

> **Already have a database for this project?** An existing database with the same name (`outlook-email-db`)
> is **reused**, never recreated — all imported accounts stay, only missing tables are added.
> The build log prints `复用已存在的数据库：…（uuid）`. If your database has another name, either set
> the Deploy command to `D1_DB_NAME=your-db pnpm run deploy:cf`, or fill `wrangler.toml` in by hand (see below).

**4. Add two Secrets**

Worker page → **Settings** → **Variables and Secrets** → **Add** → type **Secret**:

| Name | Value |
|------|-------|
| `ADMIN_PASSWORD` | the password you want to log in with |
| `COOKIE_SECRET` | any long random string (32+ characters) |

> Without these the login page still loads, but logging in reports "server secret not configured".
>
> **Reusing an old database?** If `settings.login_password_hash` already exists, that stored hash wins and
> `ADMIN_PASSWORD` is not consulted. Log in with the old password, then change it under **Settings**.

**5. Open the URL and log in**

Something like `https://outlook-email.<your-subdomain>.workers.dev` — log in with `ADMIN_PASSWORD`. Tables are created automatically on the first request.

<details>
<summary><b>These two secrets only need to be set once (no re-entering on every deploy)</b></summary>

**Know which of the two you are creating** — this is the root cause of "my variables vanished after a redeploy":

| Dashboard type | After a redeploy |
|---|---|
| **Secret** (encrypted) | ✅ always kept (wrangler hard-codes `keepSecrets: true`) |
| **Text / Variable** (plain) | ⚠️ **deleted by default** unless declared in `wrangler.toml` |

The **Add** dialog defaults to **Text**, so it is easy to add two plain variables and have every
`wrangler deploy` wipe them. This repo sets `keep_vars = true`, so plain variables now survive too —
but use the **Secret** type for credentials, or the value stays visible in the dashboard.

One thing to be clear about if you want to keep them in GitHub:

> **GitHub Secrets are not readable by Cloudflare Workers Builds.** Workers Builds runs in Cloudflare's own build
> environment and only sees the build variables configured under **Worker → Settings → Build → Variables and Secrets**.

Three options:

| Option | Setup | Re-enter each deploy? |
|--------|-------|:---:|
| **A. Set once in the dashboard** (default) | nothing | ❌ |
| **B. Build variables + `deploy:cf`** | two variables in the Worker's Build settings | ❌ (the script pushes them) |
| **C. Deploy via GitHub Actions** | 4 GitHub Secrets | ❌ |

**B**: add `ADMIN_PASSWORD` and `COOKIE_SECRET` under **Settings → Build → Variables and Secrets**; `deploy:cf`
runs `wrangler secret bulk` after deploying when it finds them in the environment.

**C**: use the bundled `.github/workflows/deploy.yml`. It runs `pnpm run deploy:cf` with secrets injected from GitHub:

| GitHub Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create Token, with **Workers Scripts:Edit** + **D1:Edit** + **Account Settings:Read** |
| `CLOUDFLARE_ACCOUNT_ID` | the Account ID shown in the dashboard |
| `ADMIN_PASSWORD` | your login password |
| `COOKIE_SECRET` | long random string |

The deploy workflow is **manual-trigger** (Actions → Deploy to Cloudflare → Run workflow).
Leave day-to-day deploys to Workers Builds — running both would deploy the same Worker twice.

> A separate `.github/workflows/ci.yml` runs **type check, unit tests and the i18n coverage check** on every
> push / PR. It never deploys, and it fails if `src/schema.ts` was not regenerated after editing `migrations/*.sql`.

</details>


<details>
<summary><b>Fallback: manual database setup</b></summary>

1. Dashboard → **Storage & Databases** → **D1 SQL Database** → **Create**, name it `outlook-email-db`
2. Open it and copy the **Database ID**
3. In your fork, open `wrangler.toml` and replace `REPLACE_WITH_YOUR_DATABASE_ID` with that ID, commit
4. In the Worker's Build settings, change the Deploy command to `npx wrangler deploy`, redeploy

</details>

### Option 2: Deploy from the CLI (also used for local dev)

```bash
# 1. Clone & install
git clone https://github.com/76hvc/cf-outlook-email.git
cd cf-outlook-email
pnpm install

# 2. Login to Cloudflare
pnpm exec wrangler login

# 3. Create DB + migrate + deploy in one step
pnpm run deploy:cf

# 4. Set secrets
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put COOKIE_SECRET
```

Prefer doing it by hand:

```bash
pnpm exec wrangler d1 create outlook-email-db   # copy database_id into wrangler.toml
pnpm exec wrangler deploy
```

### About the schema

- **Auto-created on first request**: `src/migrate.ts` runs `migrations/*.sql` when the tables are missing (all statements are `CREATE TABLE IF NOT EXISTS`, so re-running is safe). A brand-new database needs no manual migration.
- **Upgrading from an older version is safe**: the probe checks for *every* table the schema declares and adds whatever is missing (e.g. an older DB without `push_state` / `tags`); existing rows are untouched.
- Explicit migration is still available: `pnpm run db:migrate` (remote) / `pnpm run db:migrate:local` (local).
- To add a migration, only touch `migrations/` — `pnpm run build` folds it into `src/schema.ts` (generated, do not edit).

### Local development

```bash
pnpm install
echo 'ADMIN_PASSWORD=your-password' > .dev.vars
echo 'COOKIE_SECRET=any-long-random-string' >> .dev.vars
pnpm run dev      # http://localhost:8787
```

`wrangler.toml` is committed, so there is no template to copy; the placeholder `database_id` is fine locally (dev uses SQLite under `.wrangler/`).

## 📮 Adding Accounts

Login → **Add Account** → **One-Click Auth** → Microsoft login popup → Authorize → Credentials auto-filled → Save.

Works with all Outlook / Hotmail / Live accounts. Bulk import supported (format: `email----password----client_id----refresh_token`), also available through the [External API](./docs/API.md).

## 🧱 Tech Stack

| Layer | Technology |
|-------|-----------|
| ⚙️ Runtime | Cloudflare Workers (TypeScript) |
| 🧭 Router | Hono |
| 🗄️ Database | Cloudflare D1 (SQLite) |
| 🎨 Frontend | Vanilla HTML/CSS/JS |
| 📧 Email | Microsoft Graph API |
| 🚀 Deploy | Wrangler / Cloudflare Workers Builds |

## 🗂️ Project Layout

```
src/                     Worker source
├── index.ts             entry + routes + schema bootstrap hook
├── migrate.ts           creates the schema on first request
├── schema.ts            generated from migrations/*.sql — do not edit
├── auth.ts              HMAC-SHA256 cookie sessions
├── graph.ts             Microsoft Graph integration
├── importAccounts.ts    account import (dedupe + bulk insert)
├── routes/              9 business route modules
└── utils/               crypto, validation, import parsing
public/                  frontend (static SPA)
migrations/              D1 DDL — the single source of truth
tools/                   build / deploy / i18n-check scripts
test/                    Vitest unit tests
wrangler.toml            deploy config (used by wrangler and Workers Builds)
```

## 💰 Free Tier Limits

| Resource | Free Quota | Sufficient? |
|----------|-----------|:-----------:|
| ⚡ Worker Requests | 100K/day | ✅ |
| ⏱️ CPU Time | 10ms/req | ✅ |
| 🌐 Subrequests | 50/req | ✅ (single account per request) |
| 💾 D1 Storage | 5 GB | ✅ |

> D1's free plan allows roughly 50 queries per invocation, which is why the external bulk-import endpoint caps at 300 accounts per request.

## 🗺️ Roadmap

**Core features (implemented)**

- [x] 🔐 One-click OAuth & auto token refresh
- [x] 👤 Account management (CRUD, connection test)
- [x] 🗂️ Group management (custom colors, group & status filters)
- [x] 📦 Bulk import / export / delete / move
- [x] 📤 Per-row & selected export
- [x] 📨 Email reading (live fetch, search, HTML rendering)
- [x] 📁 Folder switching (Inbox / Junk / Deleted)
- [x] 🔀 Aggregated view (Inbox + Junk merged by time — great for finding codes)
- [x] 📄 Paginated load-more
- [x] 📭 Temp email (GPTMail integration)
- [x] 🎨 Theme switching + circle-swoop transition + breathing glow
- [x] 🔑 External API + API Key (login-free email fetch, **bulk account import**, account inventory, for automation — see [API Docs](./docs/API.md))
- [x] 🗑️ Delete emails (single / batch, soft-delete to Deleted Items)
- [x] 📎 Attachment download
- [x] 🏷️ Tag system (multiple tags per account, cross-group filtering)
- [x] ⏰ Scheduled token refresh (Cron Trigger, configurable interval/batch, keeps accounts alive)
- [x] 🤖 Telegram push for new emails (cron polling, near-real-time delivery, configurable interval)
- [x] 🧭 UI polish (per-page toolbars, dashboard health cards, responsive settings grid, paginated accounts table, searchable account combobox)
- [x] 🌐 UI internationalization (Chinese default, one-click English)
- [x] 🚀 Deploy straight from Git (`wrangler.toml` committed + schema created on first request)

**Planned (PRs welcome)**

- [ ] 🔔 More push channels (WeCom / DingTalk etc.)

> ⚠️ Due to Cloudflare Workers platform limits, the following are not feasible: IMAP (Gmail / QQ / 163 and other non-Microsoft mailboxes), SMTP forwarding, HTTP/SOCKS5 proxy.

## ⚠️ Disclaimer

This project is intended for personal use to manage your own email accounts. Ensure you have legal authorization for all accounts you manage. The default Client ID is Mozilla Thunderbird's public ID for quick setup only — registering your own Azure app is recommended for production use. The author assumes no liability for any misuse.

## 🙏 Origin & Credits

This repository is a fork. Lineage, newest first:

1. **[roseforyou/cf-outlook-email](https://github.com/roseforyou/cf-outlook-email)** — what this repo was forked from.
   The Cloudflare Workers + Hono + D1 architecture and nearly all features (one-click OAuth, email read/delete,
   groups & tags, bulk import/export, Telegram push, bilingual UI, external API) were built there.
2. **[xiaozhi349/outlookEmail](https://github.com/xiaozhi349/outlookEmail)** — the origin of the above,
   originally written in Python Flask + SQLite.

Changes in this fork:

- external API: bulk account import and account inventory (`POST` / `GET /api/external/accounts`)
- deploy straight from the GitHub repo: auto-create D1, create the schema on first request (and repair
  older schemas), `keep_vars` so dashboard variables survive redeploys
- matching docs (README / deployment guide / API docs) and unit tests

Credit for the features and the hard problems belongs to the two upstream authors.

## 📜 License

[![License: GPL-3.0](https://img.shields.io/badge/License/GPL%203.0-blue.svg)](./LICENSE)

Licensed under **GPL-3.0**. Free to use, modify, and distribute — but any distributed derivative must also be open-sourced under GPL-3.0 with full source code.
