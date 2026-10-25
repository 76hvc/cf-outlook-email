# 📬 Outlook 邮件管理

<div align="center">

**基于 Cloudflare Workers 的轻量级 Outlook 邮件管理工具**

🆓 完全免费 · ☁️ 无需服务器 · 🌍 全球加速 · 🌗 深浅主题 · 🌐 中英双语

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![D1](https://img.shields.io/badge/D1-SQLite-003B57?logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/roseforyou/cf-outlook-email/pulls)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/roseforyou/cf-outlook-email)

☝️ 按钮会克隆仓库并直接构建。本仓库已自带 `wrangler.toml`，但 `database_id` 是占位符——
**按下面的「方式一 / 方式二」操作才能部署成功**，按钮只是快捷入口。

🌐 [English](./README_EN.md) · 📖 [详细部署教程](./docs/GUIDE.md) · 🔌 [对外 API 文档](./docs/API.md)

</div>

---

| 🌙 深色模式 | ☀️ 浅色模式 |
|:---:|:---:|
| ![深色模式](./docs/preview.png) | ![浅色模式](./docs/preview-light.png) |

## ✨ 特性

- 🔐 **一键授权** — 浏览器弹窗登录微软账号，自动获取凭证，无需手动复制 token
- 🔄 **Token 自动续期** — 每次读邮件自动刷新 token，只要定期使用就不会过期
- 📦 **批量管理** — 批量导入/导出/删除/移组，支持单条与选中导出、分组和状态筛选
- 📨 **邮件阅读** — 通过 Microsoft Graph API 实时读取，支持收件箱/垃圾箱/已删除文件夹切换、聚合视图、分页加载、搜索和 HTML 渲染
- 📭 **临时邮箱** — 集成 GPTMail API，一键生成临时邮箱接收邮件
- 🎨 **精致主题** — 深色/浅色/跟随系统，毛玻璃质感 + 圆形扫掠切换 + 低频呼吸光晕
- 🌐 **中英双语** — 默认中文，顶栏一键切换 English，偏好本地记忆，后端消息同步翻译
- 🆓 **完全免费** — 运行在 Cloudflare 免费层，无需信用卡
- ⚡ **连仓库即部署** — 仓库自带 `wrangler.toml`，在 Cloudflare 里「Connect to Git」即可自动构建部署；数据库表结构在首次请求时自动创建，无需手动跑迁移

## 🚀 部署

### 方式一：连接 GitHub 仓库（推荐，改代码自动重新部署）

> 全程不装任何工具，全部在网页上完成。

**1. Fork 仓库**

打开 <https://github.com/roseforyou/cf-outlook-email> → 右上角 **Fork**。

**2. 在 Cloudflare 连接仓库**

控制台 → **Workers & Pages** → **Create application** → **Workers** → **Connect to Git** → 授权 GitHub → 选中你 fork 的仓库。

**3. 填写构建设置**

| 字段 | 填什么 |
|------|--------|
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy:cf` |

`deploy:cf` 会依次完成：**自动创建 D1 数据库** → 写入 `database_id` → 应用表结构 → 部署 Worker。
（如果构建环境没有建库权限，会直接报错提示你改用手动方式，见下方「备用：手动创建数据库」。）

**4. 设置两个 Secret（部署完就能设）**

Worker 页面 → **Settings** → **Variables and Secrets** → **Add** → 类型选 **Secret**，加两条：

| 名称 | 值 |
|------|-----|
| `ADMIN_PASSWORD` | 你的登录密码 |
| `COOKIE_SECRET` | 随便一串长随机字符串（32 位以上，例如用密码管理器生成） |

> 不设也能打开登录页，但点登录会提示「服务端密钥未配置」。

**5. 打开网址登录**

形如 `https://outlook-email.<你的子域>.workers.dev`，输入 `ADMIN_PASSWORD` 即可。数据库表结构会在第一次请求时自动建好。

以后往 fork 里提交代码，Cloudflare 会自动重新构建部署。

<details>
<summary><b>备用：手动创建数据库（构建环境无建库权限时）</b></summary>

1. 控制台 → **Storage & Databases** → **D1 SQL Database** → **Create**，名字填 `outlook-email-db`
2. 进入数据库，复制 **Database ID**
3. 在你的 fork 里打开 `wrangler.toml`，把 `REPLACE_WITH_YOUR_DATABASE_ID` 替换成这个 ID，提交
4. 回到 Worker 的 Build settings，把 Deploy command 改成 `npx wrangler deploy`，重新部署

</details>

### 方式二：命令行部署（本地开发也走这套）

```bash
# 1. 克隆 & 安装
git clone https://github.com/roseforyou/cf-outlook-email.git
cd cf-outlook-email
pnpm install

# 2. 登录 Cloudflare
pnpm exec wrangler login

# 3. 一条命令建库 + 迁移 + 部署
pnpm run deploy:cf

# 4. 设置密码
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put COOKIE_SECRET
```

不想用 `deploy:cf` 自动建库，也可以手动：

```bash
pnpm exec wrangler d1 create outlook-email-db   # 把输出的 database_id 填进 wrangler.toml
pnpm exec wrangler deploy
```

### 关于数据库表结构

- **首次请求自动建表**：`src/migrate.ts` 会在第一次访问时执行 `migrations/*.sql`（全部是 `CREATE TABLE IF NOT EXISTS`，可重复执行），所以全新库不需要手动迁移。
- 想显式迁移也可以：`pnpm run db:migrate`（远程）/ `pnpm run db:migrate:local`（本地）。
- 加新版本迁移时只改 `migrations/`，`pnpm run build` 会把它同步进 `src/schema.ts`（该文件自动生成，勿手改）。

### 本地开发

```bash
pnpm install
echo 'ADMIN_PASSWORD=你的密码' > .dev.vars
echo 'COOKIE_SECRET=随便一串长随机' >> .dev.vars
pnpm run dev      # http://localhost:8787
```

`wrangler.toml` 已随仓库提供，无需再复制模板；`database_id` 保持占位符也能跑本地（本地用的是 `.wrangler/` 里的 SQLite）。

## 📮 添加邮箱

登录后点击 **添加账号** → **一键授权** → 弹出微软登录窗口 → 授权后自动填入凭证 → 保存。

支持所有 Outlook / Hotmail / Live 邮箱，也支持批量导入（格式：`邮箱----密码----client_id----refresh_token`），批量导入也可以通过 [对外 API](./docs/API.md#导入账号) 完成。

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| ⚙️ 运行时 | Cloudflare Workers (TypeScript) |
| 🧭 路由 | Hono |
| 🗄️ 数据库 | Cloudflare D1 (SQLite) |
| 🎨 前端 | 原生 HTML/CSS/JS |
| 📧 邮件 | Microsoft Graph API |
| 🚀 部署 | Wrangler / Cloudflare Workers Builds |

## 🗂️ 项目结构

```
src/                     后端源码（Worker）
├── index.ts             入口 + 路由 + 自动建表钩子
├── migrate.ts           首次请求自动建表（全新库免手动迁移）
├── schema.ts            由 migrations/*.sql 生成，勿手改
├── auth.ts              HMAC-SHA256 Cookie 鉴权
├── graph.ts             Graph API 集成
├── importAccounts.ts    账号导入（查重 + 批量写入）
├── routes/              业务路由（9 个模块）
└── utils/               加密、校验、导入解析
public/                  前端（静态 SPA）
migrations/              D1 建表 SQL（唯一事实来源）
tools/                   构建 / 部署 / i18n 检查脚本
test/                    Vitest 单元测试
wrangler.toml            部署配置（wrangler 与 Workers Builds 共用）
```

## 💰 免费额度

| 资源 | 免费额度 | 够用？ |
|------|----------|:------:|
| ⚡ Workers 请求 | 10 万/天 | ✅ |
| ⏱️ CPU 时间 | 10ms/请求 | ✅ |
| 🌐 外部请求 | 50/次 | ✅ (单账号单请求) |
| 💾 D1 存储 | 5 GB | ✅ |

> 注意：D1 免费层单次调用约 50 条查询预算，所以对外 API 的批量导入单次上限是 300 条，超出请分批。

## 🗺️ 路线图

**核心功能（已实现）**

- [x] 🔐 一键 OAuth 授权 & Token 自动续期
- [x] 👤 邮箱账号管理（增 / 删 / 改 / 查、测试连接）
- [x] 🗂️ 分组管理（自定义颜色、按分组与状态筛选）
- [x] 📦 批量导入 / 导出 / 删除 / 移组
- [x] 📤 单条 / 选中导出
- [x] 📨 邮件阅读（实时收件、搜索、HTML 渲染）
- [x] 📁 文件夹切换（收件箱 / 垃圾箱 / 已删除）
- [x] 🔀 聚合视图（收件箱 + 垃圾箱合并按时间排序，找验证码神器）
- [x] 📄 分页加载（加载更多）
- [x] 📭 临时邮箱（集成 GPTMail）
- [x] 🎨 主题切换 + 圆形扫掠过渡 + 呼吸光晕
- [x] 🔑 对外 API + API Key（免登录拉取邮件、批量导入账号、查询账号清单，自动化取验证码，见 [API 文档](./docs/API.md)）
- [x] 🗑️ 删除邮件（单条 / 批量，软删除到「已删除」）
- [x] 📎 附件下载
- [x] 🏷️ 标签系统（一个账号多标签，跨分组筛选）
- [x] ⏰ 定时刷新 Token（Cron Trigger，可配间隔/批量，自动保活账号）
- [x] 🤖 Telegram 推送新邮件（Cron 轮询，新邮件实时推送到 Telegram，可配间隔）
- [x] 🧭 界面打磨（页面级工具栏、仪表盘健康度卡片、设置页响应式网格、账号表分页、可搜索账号下拉）
- [x] 🌐 界面国际化（默认中文，一键切换 English）
- [x] 🚀 连接 GitHub 仓库即部署（自带 `wrangler.toml` + 首次请求自动建表）

**计划中（欢迎 PR）**

- [ ] 🔔 更多推送渠道（企业微信 / 钉钉等）

> ⚠️ 受 Cloudflare Workers 平台限制，以下功能无法实现：IMAP（Gmail / QQ / 163 等非微软邮箱）、SMTP 转发、HTTP/SOCKS5 代理。

## ⚠️ 免责声明

本项目仅供个人学习和管理自己的邮箱使用。请确保你对所管理的邮箱账号拥有合法授权，不得用于未授权访问他人邮箱或其他违法用途。默认 Client ID 为 Mozilla Thunderbird 公开 ID，仅供快速体验，正式使用建议[注册自己的 Azure 应用](./docs/GUIDE.md#自己注册-azure-应用)。使用者应自行承担因不当使用产生的一切法律责任，作者不承担任何责任。

## 🙏 致谢

本项目基于 [xiaozhi349/outlookEmail](https://github.com/xiaozhi349/outlookEmail) 改造而来。原项目为 Python Flask + SQLite 实现，本项目将其迁移至 Cloudflare Workers + D1，并重写了前后端代码。感谢原作者的工作。

## 友情链接

[LINUX DO](https://linux.do/) —— 新的理想型社区，技术爱好者的聚集地。

## 📜 许可证

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](./LICENSE)

基于 **GPL-3.0** 协议开源。你可以自由使用、修改和分发本项目，但任何分发的衍生作品也必须以 GPL-3.0 协议开源并提供完整源代码。
