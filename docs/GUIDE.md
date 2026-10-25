# 详细部署教程

本教程面向零基础用户，一步步教你把 Outlook 邮件管理工具部署到 Cloudflare。

**两种方式，任选其一：**

- **方式 A（推荐）**：在 Cloudflare 里连接你的 GitHub 仓库，之后改代码自动重新部署。全程网页操作，不用装任何工具。
- **方式 B**：命令行 `wrangler` 部署。适合本地开发，或想完全掌控每一步的人。

## 目录

- [方式 A：连接 GitHub 仓库部署](#方式-a连接-github-仓库部署)
- [方式 B：命令行部署](#方式-b命令行部署)
  - [前置准备](#前置准备)
  - [第一步：安装工具](#第一步安装工具)
  - [第二步：获取代码](#第二步获取代码)
  - [第三步：登录 Cloudflare](#第三步登录-cloudflare)
  - [第四步：创建数据库](#第四步创建数据库)
  - [第五步：配置密码](#第五步配置密码)
  - [第六步：初始化数据库（可跳过）](#第六步初始化数据库可跳过)
  - [第七步：部署](#第七步部署)
- [添加邮箱账号](#添加邮箱账号)
- [本地开发](#本地开发)
- [关于 Client ID](#关于-client-id)
- [Token 过期处理](#token-过期处理)
- [获取 client_id 和 refresh_token](#获取-client_id-和-refresh_token)
- [API 端点](#api-端点)
- [免费版限制](#免费版限制)
- [暂不支持的功能](#暂不支持的功能)
- [常见错误](#常见错误)
- [手动测试清单](#手动测试清单)

---

## 方式 A：连接 GitHub 仓库部署

### A1. Fork 仓库

打开 <https://github.com/76hvc/cf-outlook-email>，点右上角 **Fork**，把仓库复制到你的账号下。

> 为什么不直接用原仓库？因为 Cloudflare 需要「授权你拥有的仓库」，而且构建时可能会写入配置（`deploy:cf` 会回填 `database_id`）。

### A2. 在 Cloudflare 连接仓库

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com/)
2. 左侧 **Workers & Pages** → **Create application** → **Workers** 标签 → **Connect to Git**
3. 首次使用会要求授权 GitHub，选择 **Only select repositories** 并选中你刚 fork 的仓库
4. 点 **Install & Authorize**，然后选中仓库 → **Begin setup**

### A3. 填写构建设置

页面上会出现 Build settings，按下表填写：

| 字段 | 填什么 |
|------|--------|
| Worker name | `outlook-email`（随意，和 `wrangler.toml` 的 `name` 一致最好） |
| Build command | `pnpm run build` |
| Deploy command | `pnpm run deploy:cf` |

`pnpm run deploy:cf` 会依次做四件事：

1. 检查 D1 数据库 `outlook-email-db` 是否存在，不存在就创建
2. 把真实的 `database_id` 写进 `wrangler.toml`
3. 应用 `migrations/` 里的表结构
4. 执行 `wrangler deploy`

填完点 **Deploy**，等 1～3 分钟。

> **⚠️ 账号里已经有这个项目的数据库了？**
> 脚本会**复用同名库**（`outlook-email-db`），不会新建也不会清空——原有账号数据全部保留，
> 只补齐缺失的表。构建日志会明确打印：
> `[deploy] 复用已存在的数据库：outlook-email-db（xxxx-uuid）`。
> 如果你的库叫别的名字，两种做法：
> - Deploy command 改成 `D1_DB_NAME=你的库名 pnpm run deploy:cf`
> - 或者按【备用：手动创建数据库】把 ID 直接填进 `wrangler.toml`（此时脚本不会再自动查找/建库）

> 如果这一步报「无法创建 D1 数据库」，说明构建环境没有建库权限。改用下面的【备用：手动创建数据库】，然后把 Deploy command 换成 `npx wrangler deploy` 重新部署。

### A4. 设置两个 Secret

部署成功后，进入这个 Worker 的页面 → **Settings** → **Variables and Secrets** → **Add**：

| 类型 | 名称 | 值 |
|------|------|-----|
| Secret | `ADMIN_PASSWORD` | 你的登录密码 |
| Secret | `COOKIE_SECRET` | 一串随机字符，至少 32 位，例如 `aK3mX9pQ2wE8rT6yU1iO4sD7fG0hJ5l` |

> 漏了这两条也能打开登录页，但点登录会提示「服务端密钥未配置」。Secret 保存后**立即生效**，不用重新部署。
>
> **⚠️ 类型一定要选「Secret」，别选「Text」。**
> Cloudflare 的 Add 弹窗**默认是 Text 类型**，而类型为 Text 的明文变量在每次 `wrangler deploy` 时
> 都会被**删除**（因为 `wrangler.toml` 里没声明它）。这就是「变量部署完就没了」的真正原因。
> 类型为 Secret 的则不受影响——wrangler 内部写死 `keepSecrets: true`，永远不会删。
>
> 本仓库的 `wrangler.toml` 已加 `keep_vars = true`，明文变量也不会再被清掉；
> 但密钥仍建议用 Secret 类型，避免明文显示在控制台上。

#### 想把 Secret 存在 GitHub 里？（A4 补充）

先说结论：**GitHub Secrets 传不到 Cloudflare Workers Builds。**
Workers Builds 跑在 Cloudflare 的构建环境，只能读 **Worker → Settings → Build → Variables and Secrets** 里的构建变量，
访问不了你仓库的 Actions Secrets。

所以「每次部署都不用重填」有三种做到的方式：

| 方式 | 一次配置在哪里 | 之后每次部署 |
|------|----------------|--------------|
| **A. 控制台设一次**（最简单） | Worker → Settings → Variables and Secrets | 自动保留，无需重填 |
| **B. 构建变量** | Worker → Settings → **Build** → Variables and Secrets | `deploy:cf` 自动 `wrangler secret bulk` 写回 |
| **C. GitHub Actions** | GitHub 仓库 → Settings → Secrets and variables → Actions | 工作流用 GitHub Secrets 部署 |

**方式 B**：在 Build 的那一栏加 `ADMIN_PASSWORD`、`COOKIE_SECRET`（类型 Secret）。
`deploy:cf` 发现环境里有这两个变量，会在部署完成后自动写入 Worker Secret（值不会打印到日志）。

**方式 C**：用仓库里的 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)，它执行 `pnpm run deploy:cf`。
需要 4 条 GitHub Secrets：

| 名称 | 内容 |
|------|------|
| `CLOUDFLARE_API_TOKEN` | 控制台 → My Profile → API Tokens → Create Token，权限：**Workers Scripts:Edit** + **D1:Edit** + **Account Settings:Read** |
| `CLOUDFLARE_ACCOUNT_ID` | 控制台右侧的 Account ID |
| `ADMIN_PASSWORD` | 登录密码 |
| `COOKIE_SECRET` | 随机长字符串 |

工作流是**手动触发**的（Actions → Deploy to Cloudflare → Run workflow）。
日常自动部署建议交给 Workers Builds，⚠️ **别和 Workers Builds 同时开**，会重复部署。

> 仓库里还有一个 [`ci.yml`](../.github/workflows/ci.yml)：每次 push / PR 自动跑类型检查、单元测试和 i18n 覆盖率，
> 只检查不部署。改了 `migrations/*.sql` 却没重新生成 `src/schema.ts` 的话，它也会报错拦下。


> **⚠️ 复用旧数据库时，密码可能不认 `ADMIN_PASSWORD`。**
> 登录校验的顺序是：先查 `settings` 表里的 `login_password_hash`，有就用它比对，**根本不会看 `ADMIN_PASSWORD`**。
> 所以从旧版本升级上来的库，请用**原来的密码**登录，进去后在「系统设置」里改密码（会把哈希覆盖成新的）。
> 密码忘了的话，删掉这行再重建即可：
> ```bash
> pnpm exec wrangler d1 execute outlook-email-db --remote --command "DELETE FROM settings WHERE key='login_password_hash'"
> ```
> 之后 `ADMIN_PASSWORD` 就会生效（首次成功登录时会把它的哈希写回库里）。

### A5. 打开网址登录

Worker 页面右上角会显示访问地址，形如：

```
https://outlook-email.你的子域.workers.dev
```

打开它，用 `ADMIN_PASSWORD` 登录即可。**数据库表结构会在第一次请求时自动创建**，不需要手动跑迁移。

之后你往 fork 里提交代码，Cloudflare 会自动重新构建部署。

### 备用：手动创建数据库

`deploy:cf` 建库失败时，手动来：

1. 控制台 → **Storage & Databases** → **D1 SQL Database** → **Create database**，名字填 `outlook-email-db`
2. 进入数据库详情，复制 **Database ID**（形如 `abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
3. 在你的 fork 里打开 `wrangler.toml`，把 `REPLACE_WITH_YOUR_DATABASE_ID` 换成这个 ID，提交
4. 回到 Worker → **Settings** → **Build** → 把 Deploy command 改成 `npx wrangler deploy` → 重新部署

---

## 方式 B：命令行部署

### 前置准备

你需要：

1. **一个 Cloudflare 账号**（免费注册：[dash.cloudflare.com](https://dash.cloudflare.com/)）
2. **Node.js 18+**（下载：[nodejs.org](https://nodejs.org/)）
3. **pnpm**（安装：终端运行 `npm install -g pnpm`，也可以用 npm 替代）

邮箱凭证（client_id / refresh_token）不需要提前准备，部署后可以在 Web 界面一键获取。

---

## 第一步：安装工具

确认 Node.js 和 pnpm 已安装：

```bash
node --version    # 应该显示 v18.x 或更高
pnpm --version    # 应该显示版本号
```

如果没有 pnpm，用 npm 也行，把后续命令中的 `pnpm` 替换为 `npm` 即可。

---

## 第二步：获取代码

```bash
git clone https://github.com/76hvc/cf-outlook-email.git
cd cf-outlook-email
pnpm install
```

安装完成后你会看到 `node_modules` 目录。

---

## 第三步：登录 Cloudflare

```bash
pnpm exec wrangler login
```

浏览器会弹出 Cloudflare 授权页面：
1. 点击 **"Allow"** 允许访问
2. 看到 "Successfully logged in" 就行了

> 如果提示 wrangler 命令不存在，用 `pnpm exec wrangler` 替代 `wrangler`。

---

## 第四步：创建数据库

```bash
pnpm exec wrangler d1 create outlook-email-db
```

命令会输出类似这样的内容：

```
✅ Successfully created DB 'outlook-email-db'
database_id = "abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**复制 `database_id` 的值**，然后打开仓库里已自带的 `wrangler.toml`（不需要复制模板），把 `REPLACE_WITH_YOUR_DATABASE_ID` 替换为你的 database_id。

> 偷懒做法：直接跑 `pnpm run deploy:cf`，它会自动检查/创建数据库、回填 `database_id`、应用迁移并部署（等价于下面第六、七步）。

---

## 第五步：配置密码

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD
```

提示 `Enter a secret value:` 时，输入你想设的**登录密码**（输入时不显示，直接打完回车）。

```bash
pnpm exec wrangler secret put COOKIE_SECRET
```

提示时输入一串**随机字符**（至少 32 位），例如键盘乱敲：`aK3mX9pQ2wE8rT6yU1iO4sD7fG0hJ5l`。

> 可选：如果你有 GPTMail API Key，也可以配置临时邮箱功能：
> ```bash
> pnpm exec wrangler secret put GPTMAIL_API_KEY
> ```

---

## 第六步：初始化数据库（可跳过）

```bash
pnpm exec wrangler d1 migrations apply outlook-email-db --remote
```

提示 "continue?" 时输入 `Y` 回车。

> **这一步现在可以跳过**：Worker 会在第一次请求时自动执行 `migrations/` 里的建表语句（`src/migrate.ts`，全部是 `CREATE TABLE IF NOT EXISTS`，可重复执行）。
> 手动跑一遍的好处是首次打开页面时少一次建表开销；两种做法结果一致。
> 也可以用快捷命令：`pnpm run db:migrate`。
>
> **从旧版本升级**：自动建表会检查 schema 声明的**全部**表，缺哪张补哪张（比如老库没有 `push_state` / `tags` / `account_tags`），**已有数据不动**。所以旧库也能直接跑新版本。

---

## 第七步：部署

```bash
pnpm exec wrangler deploy
# 或者一条命令搞定建库 + 迁移 + 部署：
pnpm run deploy:cf
```

部署成功后会输出你的访问地址：

```
https://outlook-email.你的用户名.workers.dev
```

打开这个地址，用第五步设的密码登录。

---

## 添加邮箱账号

### 方式一：一键授权（推荐，最简单）

1. 登录后点击 **"+ 添加账号"**
2. 点击蓝色区域的 **"一键授权"** 按钮
3. 弹出微软登录窗口，用你的 Outlook / Hotmail 邮箱登录
4. 点击 **"是"** 允许授权
5. 窗口自动关闭，**Client ID** 和 **Refresh Token** 自动填入
6. 在"邮箱"栏填入刚授权的邮箱地址
7. 点击 **"确定"** 保存

### 方式二：手动添加

如果你已经有 client_id 和 refresh_token：
1. 点击 **"+ 添加账号"**
2. 填写邮箱、Client ID、Refresh Token
3. 点击 **"确定"**

### 方式三：批量导入

1. 点击 **"批量导入"**
2. 每行一个账号，格式：`邮箱----密码----client_id----refresh_token`
3. 选择分组，点击 **"确定"**

---

## 本地开发

如果想先在本地试试再部署：

```bash
# 创建本地密钥文件
cat > .dev.vars << 'EOF'
ADMIN_PASSWORD=test123
COOKIE_SECRET=aK3mX9pQ2wE8rT6yU1iO4sD7fG0hJ5laK3mX9pQ
EOF

# 启动（数据库表结构会在首次请求时自动创建）
pnpm run dev
```

访问 http://localhost:8787，用 `test123` 登录。

- `wrangler.toml` 已随仓库提供，**不需要再复制模板**；`database_id` 保持占位符也能跑本地（本地用 `.wrangler/` 下的 SQLite，与云端无关）。
- 想手动初始化本地库：`pnpm run db:migrate:local`。
- 清空本地数据重新来过：删掉 `.wrangler/` 目录即可。

---

## 关于 Client ID

### 什么是 Client ID？

Client ID 是在 Microsoft Azure 注册应用时生成的唯一标识。它不是密码，本身不敏感。一个 Client ID 可以用来授权多个 Outlook 邮箱。

### 默认 Client ID

本项目默认使用 **Mozilla Thunderbird 的公开 Client ID**（`9e5f94bc-e8a4-4e73-b8be-63364c29d753`）：
- 公开免费，无需注册 Azure 应用
- 已配置 Graph Mail.Read 权限
- 支持所有 Outlook / Hotmail / Live 个人邮箱

> ⚠️ **重要：默认 Thunderbird ID 无法用于网页「一键授权」。**
> 它是桌面客户端用的，注册的回调地址不含你的 Worker 域名。网页一键授权时微软会拒绝并报
> `invalid_request ... redirect_uri is not valid`。
> 默认 ID 仅适用于：① **批量导入 / 手动填入**已有的 refresh_token；② 下文的 `https://localhost` 手动授权流程（**免注册 Azure**，见下）。
> 想用一步到位的网页「一键授权」，则需[注册自己的 Azure 应用](#自己注册-azure-应用)并登记 Worker 回调地址。

> ✅ **不想注册 Azure？用「方式二：手动授权」即可。**
> 因为 `https://localhost` 本就是 Thunderbird 公开应用登记过的回调地址，所以用默认 Client ID 也能授权。
> 添加账号弹窗里的「方式二」已把这个流程做成半自动：点「打开授权页」登录 → 复制跳转后
> `https://localhost?code=...` 的完整网址粘回 → 点「获取 Token」自动填入。无需注册任何应用。

### 可以使用其他 Client ID 吗？

可以。只要该应用在 Azure 注册时配置了 `Mail.Read` 权限就行。

**注意：** 仅有 IMAP 权限的 Client ID 会导致"测试连接成功但查看邮件报 401"。遇到这种情况，编辑账号 → 点"重新授权此邮箱"即可。

| 权限类型 | 测试连接 | 读邮件 |
|----------|:--------:|:------:|
| Graph Mail.Read | ✅ | ✅ |
| 仅 IMAP | ✅ | ❌ (401) |

---

## Token 过期处理

- 系统会**自动续期**：每次读邮件时自动保存新 refresh_token
- 只要定期使用（如每周看一次邮件），token 不会过期
- 长期未用导致过期（状态变 error）→ 编辑账号 → 点"重新授权此邮箱"

### 定时刷新 Token（可选，保活长期不用的号）

系统设置 → 「定时刷新 Token」→ 启用 + 设间隔/每批数量。Cloudflare 每 5 分钟唤醒一次，
是否真正执行由「间隔」控制（worker 内按上次执行时间判断，默认 24 小时，远低于唤醒频率时大多数唤醒会直接跳过）。也可点「立即刷新一批」手动跑。

> **部署相关**：定时任务依赖 `wrangler.toml` 里的 `[triggers] crons`（仓库里的 `wrangler.toml` 已写好）。
> 从旧版本升级的话，确认你的配置里有这段并**重新部署**才会注册定时触发器。

⚠️ **频率别设太高（真实风险）**：

- **微软风控（最关键）**：refresh_token 每次刷新会被微软轮换，高频自动刷新可能触发 Graph 限流（429），
  对「领来的」账号还可能被判定异常活动而**锁号**。Token 只要每隔几天被用到就不过期，**建议间隔 ≥ 12 小时，默认 24 小时足够**。
- **子请求上限**：免费层单次最多 50 个子请求，每账号刷新占 1 个，故「每批」上限 40，超出的下一轮再刷。
- **账号多时**按「最久未刷新」优先，分多轮轮换，不会一次刷完。
- 免费层每账号最多 5 个 Cron 触发器，本功能只用 1 个。

---

## Telegram 推送新邮件（可选）

新邮件到达时推送到 Telegram，适合实时收验证码。通过 Cron **轮询**实现（非微软实时推送）。
Cloudflare 每 5 分钟唤醒一次，推送延迟取决于邮件到达时刻与下一次唤醒的间隔，
**平均约 2~3 分钟、最长约 5 分钟**；设置页的「间隔（分钟）」默认 1（每次唤醒都推，即最快），
设得比 5 大则在此基础上进一步拉长。

### 1. 创建机器人，拿 Bot Token

1. Telegram 搜索 **@BotFather**（认准官方蓝勾），发送 `/newbot`
2. 按提示起「名称」和「用户名」（用户名必须以 `bot` 结尾且全局唯一）
3. 创建成功后会回一行 **token**，形如 `123456789:AAH...` —— 这就是「Bot Token」

### 2. 拿 Chat ID（最可靠：浏览器直接查）

1. 在 Telegram 里搜索你**刚创建的机器人**，给它**发任意一条消息**（如 `hi`）。
   > 自建机器人不会回复你，这是正常的 —— 发消息只是为了「激活对话」，让它日后能给你发推送。
2. 浏览器打开下面的地址（把 `<TOKEN>` 换成你的 Bot Token）：
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. 返回的 JSON 里找 `"chat":{"id":123456789,...}`，那个 **id 就是 Chat ID**。
   > 若返回 `{"ok":true,"result":[]}`（result 为空），说明还没给机器人发过消息 ——
   > 回 Telegram 给机器人发一条，再刷新该网址即可。

   备选：搜 `@getidsbot` 或 `@RawDataBot`（认准官方/高粉号）发 `/start`，它会回你的数字 Id。

### 3. 在系统设置里启用

系统设置 → 「Telegram 推送新邮件」→ 填 Bot Token、Chat ID，勾选「启用推送」→ 保存。
- 点「发送测试消息」验证连通（机器人会给你发一条 `✅ 测试消息`）。
- 点「立即推送一轮」即时跑一次（绕过间隔）。
- **首轮只为每个账号记录水位、不补推历史邮件**，之后才推新到达的邮件。

⚠️ **行为与限制**：

- 受子请求上限，每轮最多扫描 **8 个账号**、每账号最多推 **3 条**；账号多时按「最久未扫」优先轮换。
- 与定时刷新共用每 5 分钟的 Cron 唤醒；未启用时唤醒后直接跳过，不产生任何外部请求。
- Bot Token 等同密码，保存后页面再显示时已脱敏；填入时若仍是脱敏值（含 `*`）则不会覆盖原值。

---

## 获取 client_id 和 refresh_token

> 推荐使用 Web 界面的"一键授权"功能，无需手动操作以下步骤。

### 使用已有的 Client ID

如果你有现成的 client_id（如 Thunderbird 的），可以直接手动授权：

**1. 浏览器打开（替换 YOUR_CLIENT_ID）：**

```
https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://localhost&scope=Mail.Read%20offline_access&response_mode=query
```

**2. 登录并授权后，浏览器跳转到 `https://localhost?code=xxx...`（页面报错正常）**

**3. 复制 `code=` 后面的值，用 curl 换 token：**

```bash
curl -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "grant_type=authorization_code" \
  -d "code=复制的code" \
  -d "redirect_uri=https://localhost" \
  -d "scope=Mail.Read offline_access"
```

返回的 `refresh_token` 就是你需要的值。

### 大多数人不需要注册 Azure 应用 ✅

**首选做法：直接用默认的 Thunderbird Client ID + 「方式二：手动授权」**，免注册、免 Client Secret：

添加账号弹窗 →「方式二：手动授权」→ ① 点「打开授权页」登录授权 → ② 复制跳转后打不开的
`https://localhost?code=...` 完整网址 → ③ 点「获取 Token」自动填入。

这条路对绝大多数人都够用（包括重新授权、获取读写权限删邮件）。**只有当你想用「网页一键授权」
那个弹窗自动回填的流程时，才需要自己注册应用**（因为一键授权用的是你 Worker 的回调地址，
默认 Thunderbird ID 没登记它）。

### 自己注册 Azure 应用（仅当你要用网页一键授权）

> ⚠️ **平台千万别选「Web」！** Web 属于机密客户端，微软会**强制要求 Client Secret**，
> 而本工具用的是公共客户端流程（不传 secret），选 Web 会导致授权失败。

1. 加入 [M365 开发者计划](https://developer.microsoft.com/en-us/microsoft-365/dev-program)（免费）或注册 [Azure 免费账号](https://azure.microsoft.com/free/)
2. 打开 [Azure 应用注册](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
3. 新注册 → 名称随意 → 账户类型选"任何组织目录和个人账户"（**必须包含个人账户**，否则 outlook.com / hotmail 无法登录）
4. **身份验证 → 添加平台 → 选「移动和桌面应用程序」**（**不是 Web**），重定向 URI 填你部署的 Worker 回调地址：
   ```
   https://<你的-worker-域名>/api/oauth/callback
   ```
   例如 `https://outlook-email.xxx.workers.dev/api/oauth/callback`（也可在添加账号弹窗里点"复制回调地址"直接拿到）。
5. 同页把**「允许公共客户端流」(Allow public client flows) 设为「是」**——这样才不需要 Client Secret。
6. 注册后在"概述"页面复制 **应用程序(客户端) ID**，填到添加账号弹窗的 **Client ID** 框
7. 左侧 "API 权限" → 添加 Microsoft Graph → 委托权限 → 勾选 `Mail.ReadWrite` 和 `offline_access`

> 如果嫌注册麻烦，回到上面的「方式二：手动授权」即可，效果一样。

---

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录 |
| `/api/auth/logout` | POST | 退出 |
| `/api/auth/me` | GET | 登录状态 |
| `/api/groups` | GET/POST | 分组列表/新增 |
| `/api/groups/:id` | PUT/DELETE | 修改/删除分组 |
| `/api/accounts` | GET/POST | 账号列表/添加 |
| `/api/accounts/export` | GET | 导出账号 |
| `/api/accounts/batch` | POST | 批量操作 |
| `/api/accounts/:id` | GET/PUT/DELETE | 账号详情/修改/删除 |
| `/api/accounts/:id/test` | POST | 测试连接 |
| `/api/accounts/:id/emails` | GET | 邮件列表 |
| `/api/accounts/:id/emails/:msgId` | GET | 邮件详情 |
| `/api/settings` | GET/PUT | 系统设置 |
| `/api/temp-emails` | GET/POST | 临时邮箱 |
| `/api/temp-emails/:id` | DELETE | 删除临时邮箱 |
| `/api/temp-emails/:id/messages` | GET | 临时邮件列表 |
| `/api/temp-emails/:id/messages/:msgId` | GET | 临时邮件详情 |
| `/api/oauth/authorize` | GET | 获取授权 URL |
| `/api/oauth/callback` | GET | OAuth 回调 |

---

## 免费版限制

| 资源 | 免费额度 | 对本项目影响 |
|------|----------|-------------|
| Workers 请求 | 10 万/天 | 单人远用不完 |
| Workers CPU | 10ms/请求 | Graph 走 JSON fetch，安全 |
| 外部 subrequest | 50/次请求 | 单账号单请求，不会超 |
| 并发出站连接 | 6 | 顺序读取不受影响 |
| D1 存储 | 5GB | 远超所需 |
| D1 读/写 | 500 万读、10 万写/天 | 远超所需 |

---

## 暂不支持的功能

- **IMAP 邮件读取** — Workers 不支持 TCP 长连接，已由 Graph API 替代
- **refresh_token 加密** — 当前明文存储在 D1（TODO）
- **邮件附件下载** — 仅显示附件标识
- **邮件缓存** — 每次实时获取，不缓存到数据库

---

## 常见错误

### 部署时报 `The detected framework ("Hono") cannot be automatically configured`

仓库里**没有 `wrangler.toml`** 时，Cloudflare Workers Builds 会退化成「框架自动探测」：从 `package.json` 看到 `hono` 依赖 → 套用 Hono 预设（期望 Vite 构建、输出 `dist/`）→ 和本项目（`main = src/index.ts` + 静态资源）完全不符 → 报这个错。

**本仓库已提交 `wrangler.toml`，正常不会遇到。** 如果你是用旧 fork 部署的，把上游的 `wrangler.toml` 同步过来（或在 Worker 的 Build settings 里显式指定 Build command `pnpm run build`、Deploy command `pnpm run deploy:cf`）即可。

### 构建成功但打开页面报「数据库未就绪」

`database_id` 还是占位符，或 D1 绑定指向不存在的库。用 `pnpm run deploy:cf` 部署会自动处理；手动部署的话按[第四步](#第四步创建数据库)把 ID 填进 `wrangler.toml`。

### 部署后变量/密钥没了

典型症状：在控制台加好了 `ADMIN_PASSWORD`、`COOKIE_SECRET`，登录正常；重新部署一次后，
登录又提示「服务端密钥未配置」，回控制台一看——变量不见了。

**原因**：那两个东西是**类型选错了**。

| 类型 | `wrangler deploy` 之后 |
|---|---|
| **Secret** | ✅ 保留（wrangler 内部 `keepSecrets: true`，写死） |
| **Text / Variable** | ❌ **被删除**，除非 `wrangler.toml` 里声明了同名 `[vars]`，或设了 `keep_vars = true` |

Cloudflare 的 **Add** 弹窗默认就是 **Text**，手一快就中招。

**修法（任选）**：

1. 重新添加时**把类型下拉框切到 Secret**（推荐，值不再明文显示）
2. 本仓库 `wrangler.toml` 已含 `keep_vars = true`，明文变量也会保留——但明文密码会一直显示在页面上
3. 一劳永逸：让 `deploy:cf` 每次部署后自动写入。设置环境变量 `ADMIN_PASSWORD`、`COOKIE_SECRET`
   后重跑 `pnpm run deploy:cf`（GitHub Actions 方式见 [A4 补充](#想把-secret-存在-github-里a4-补充)）

`deploy:cf` 部署完会执行 `wrangler secret list` 并打印 Worker 上实际有哪些 Secret，
再缺就直接提示缺哪个——不用再靠猜。

### `invalid_grant` / `grant is expired`

Token 已过期。编辑账号 → 点"重新授权此邮箱"获取新 token。

### 测试连接成功但读邮件 401

Client ID 只有 IMAP 权限。编辑账号 → "重新授权"切换到 Thunderbird 授权。

### 一键授权报 `invalid_request ... redirect_uri is not valid`

**最常见的问题。** 你在用默认 Thunderbird Client ID 做网页一键授权，但 Thunderbird 应用没有登记你的 Worker 回调地址，微软直接拒绝。

最省事的解决办法：**改用「方式二：手动授权」**（默认 Thunderbird ID + `https://localhost`），免注册、免改 Azure。

若坚持用网页一键授权：[注册自己的 Azure 应用](#自己注册-azure-应用)，平台选「**移动和桌面应用程序**」（**不要选 Web**），
重定向 URI 填 `https://<你的-worker-域名>/api/oauth/callback`（弹窗里可一键复制），再把你的 Client ID 填进 **Client ID** 框。

> 默认 Thunderbird ID 只适合「批量导入 / 手动填入已有 token」，不适合网页一键授权。

### 授权时提示"这不是正确的页面"

`redirect_uri` 与 Client ID 注册的不匹配。手动 `curl` 流程使用 `https://localhost`。

### Azure 无法注册应用

个人 Outlook 账号需要先加入 [M365 开发者计划](https://developer.microsoft.com/en-us/microsoft-365/dev-program)（免费）。

### 本地正常，部署后接口 500（登录就报 500）

**最常见的部署问题。** 登录接口第一步就要读数据库，生产环境少配东西就会抛异常变成 500。
按概率排查这几项：

1. **密钥没设**（最常见。生产必须单独设，本地的 `.dev.vars` 不会带上去）：
   - 命令行：`pnpm exec wrangler secret put ADMIN_PASSWORD` / `pnpm exec wrangler secret put COOKIE_SECRET`
   - 或控制台：Worker → **Settings** → **Variables and Secrets** → **Add** → Secret
   缺 `COOKIE_SECRET` 会在签发登录 Cookie 时抛异常。页面此时会提示「服务端密钥未配置：请用 wrangler secret put 设置 COOKIE_SECRET」——`wrangler secret put` 那句提示是命令行方案的写法，用控制台设也一样。
2. **`wrangler.toml` 里 `database_id` 填错或仍是占位符** `REPLACE_WITH_YOUR_DATABASE_ID`
   → D1 绑定无效 → 查询报错 → 500。
3. **远程数据库没迁移**（信息：新版已不需要，首次请求会自动建表）：
   如果表结构是老版本遗留、缺新表，手动跑一次：
   ```bash
   pnpm run db:migrate
   ```

> 以上改动都作用于**线上**资源，本地无需启动 `pnpm run dev`。设完直接访问线上 URL 重新登录即可（secret 改动下次请求即生效，无需重新部署）。
> 拿不准是哪一项时，先看真实报错（见下方「想看线上接口的真实报错」），错误码会直接告诉你：`CONFIG_MISSING` = 缺密钥，`DB_NOT_READY` / `DB_ERROR` = 数据库绑定或表结构问题。

### 加了 `--remote` 却仍显示 `Resource location: local`（迁移没生效）

用 `npm exec wrangler ... --remote` 时，**`npm exec` 会把 `--remote` 当成给自己的参数吃掉**，
没透传给 wrangler，于是仍跑本地、报 `No migrations to apply!`。这是 `npm exec` 的行为，
**与终端无关**（bash / cmd / PowerShell 都一样），`npx` 与 `pnpm exec` 不受影响。三种写法可解决：

```bash
# 方式一：用 npx
npx wrangler d1 migrations apply outlook-email-db --remote

# 方式二：npm exec 加 -- 分隔，后面的参数才会原样传给 wrangler
npm exec -- wrangler d1 migrations apply outlook-email-db --remote

# 用 pnpm 则没有这个问题
pnpm exec wrangler d1 migrations apply outlook-email-db --remote
```

成功时**不再出现** `Resource location: local`，而是列出并执行迁移。

> 另一个坑：别从文档/聊天里**复制** `--remote`，有些编辑器会把 `--` 自动转成长破折号 `—`，
> wrangler 不认 → 当没传。手动敲两个连字符最稳。

### 想看线上接口的真实报错

```bash
pnpm exec wrangler tail   # 保持开着，再点一次出错的操作，终端会打印异常
```

> ⚠️ 国内网络下 `wrangler tail` 常报 `connect ETIMEDOUT ...:443`——tail 会话已创建，但拉取
> 日志流的长连接连不通（被墙）。两个办法：① 挂代理 `HTTPS_PROXY=http://127.0.0.1:端口 pnpm exec wrangler tail`；
> ② **改用网页版**：Cloudflare 控制台 → Workers & Pages → 你的 worker → **Logs** → **Begin log stream**，
> 浏览器直连，国内基本能用。

### 登录后跳回登录页

确认 `COOKIE_SECRET` 已配置，浏览器允许 Cookie。

### wrangler 命令不存在 / `npx: command not found`

不需要全局安装，也不用 `npx`，本项目用 pnpm，统一用 `pnpm exec wrangler ...` 即可。

### Telegram 给机器人发 `/start` 或 `hi` 没任何反应

正常现象。你自建的机器人背后没有程序应答，**不会回复任何消息**。给它发消息的唯一目的是「激活对话」，
让它日后能主动给你推送。不用等回复，直接进行下一步拿 Chat ID 即可。

### `@userinfobot` 不回复 / 拿不到 Chat ID

多半是搜到了仿冒机器人。改用最可靠的浏览器方式：先给你自己的机器人发一条消息，再访问
`https://api.telegram.org/bot<TOKEN>/getUpdates`（`<TOKEN>` 换成你的 Bot Token），
在返回 JSON 里找 `"chat":{"id":...}`。详见上文「Telegram 推送新邮件 → 拿 Chat ID」。

### 启用了 Telegram 推送却收不到新邮件

依次排查：① 点「发送测试消息」是否成功——失败说明 Token/Chat ID 不对；
② 是否已勾选「启用推送」并保存；③ **首轮不补推历史邮件**，要在启用后**新到达**的邮件才会推；
④ 每轮最多扫 8 个账号，账号多时该账号可能还没轮到，可点「立即推送一轮」或等下一轮；
⑤ 看设置页「上次执行」的结果摘要。

---

## 手动测试清单

1. 访问登录页 → 输入错误密码 → 提示错误
2. 输入正确密码 → 登录成功 → 跳转主页
3. 新建分组 → 编辑分组 → 删除分组
4. 一键授权添加账号 → 测试连接
5. 批量导入账号
6. 邮件查看 → 选择账号 → 查看列表 → 查看详情
7. 导出账号 → 复制/下载
8. 批量选中 → 移动分组/停用/删除
9. 修改设置 → 退出 → 用新密码登录
10. 切换深色/浅色/自动主题
