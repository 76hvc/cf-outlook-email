# 「Deploy to Cloudflare」一键部署按钮失败

- **日期**：2026-06-08
- **类型**：使用问题 / README 误导（按钮对本项目不适用）
- **影响**：用户点击 README 顶部的「Deploy to Cloudflare」按钮，Workers Builds 构建在 deploy 阶段失败。

## 现象

```
Executing user deploy command: npx wrangler deploy
...
Detected Project Settings:
  Worker Name: cf-outlook-email
  Framework: Hono
  Build Command: pnpm run build
  Output Directory: dist
? Do you want to modify these settings?
  Using fallback value in non-interactive context: no
✘ [ERROR] The detected framework ("Hono") cannot be automatically configured.
Failed: error occurred while running deploy command
```

## 根本原因

1. 仓库**没有提交 `wrangler.toml`**（已 gitignore，只留 `wrangler.toml.example`）。
   Workers Builds 找不到 wrangler 配置，退而**自动探测框架**。
2. 从 `package.json` 探测到 `hono` 依赖 → 套用「Hono」框架预设（期望 Vite 构建、输出到 `dist`）。
3. 本项目是自定义 Worker：`main = src/index.ts` + 静态资源（`[assets] directory=./public`），
   `build` 脚本是 `tsc --noEmit`（不产出 `dist`）。与 Hono 预设完全不符 →
   `The detected framework ("Hono") cannot be automatically configured` → 失败。

更根本的是：**即使框架检测通过，按钮也无法一键部署本项目**——它无法替新用户
创建 D1 数据库、回填 `database_id`、执行 migrations、设置 `ADMIN_PASSWORD` /
`COOKIE_SECRET`。这些账号专属资源与密钥必须手动配置。

## 处理

保留按钮（视觉/引流），但在 README 按钮下方**加醒目警示**，明确告知无法一键部署、
请按部署教程手动操作。中英文 README 均已添加。

- `README.md` / `README_EN.md`：按钮下新增 ⚠️ 说明 + 指向 `docs/GUIDE.md`。

## 备注 / 未做

- 未提交 `wrangler.toml`：即便提交（用占位 `database_id`），也只是把失败点从「框架检测」
  推迟到「D1 绑定不存在 / 密钥缺失」，仍非真正一键，且会泄露真实 database_id，故不做。
- 正确部署路径始终是 `docs/GUIDE.md` 的手动步骤（约 5 分钟）。

## 后续修复（2026-10-25）

上面的「未做」结论**已被推翻**：提交 `wrangler.toml` 才是正解，`database_id` 也并非秘密
（它是资源标识符，不是凭证；真正敏感的是 `CLOUDFLARE_API_TOKEN` 和两个 Secret）。

改动：

1. **提交 `wrangler.toml`**（从 `.gitignore` 移除，删除 `.example` 模板）。
   Workers Builds 一旦读到仓库里的 wrangler 配置，就不再走「框架自动探测」，
   `The detected framework ("Hono") cannot be automatically configured` 从根上消失。
2. **`tools/cf-deploy.mjs`（`pnpm run deploy:cf`）**：Deploy command 填它即可
   自动建 D1 库 → 回填 `database_id` → 应用迁移 → 部署。全新账号不用先手动建库。
   没有建库权限时给出明确提示并退回手动路径。
3. **首次请求自动建表**（`src/migrate.ts` + 生成的 `src/schema.ts`）：
   全新数据库不需要 `d1 migrations apply`，登录页第一次访问就把表建好。
   语句全部幂等（`CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE`），重复执行无副作用。
   `migrations/*.sql` 仍是唯一事实来源，`pnpm run build` 会同步进 `src/schema.ts`。

因此「一键部署」现在是真的一键：连接仓库 → Deploy command 填 `pnpm run deploy:cf` →
构建时自动建库建表 → 控制台加两个 Secret → 登录。

按钮本身仍需要 `database_id` 可用，所以 README 保留按钮但文案改为指向「方式一/方式二」，
不再说「无法一键部署」。
