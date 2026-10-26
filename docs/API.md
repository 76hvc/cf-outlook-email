# 对外 API 使用文档

用 API Key 免登录拉取指定邮箱的邮件，适合脚本自动获取验证码、集成到其他系统。

## 1. 启用 / 获取 API Key

登录后台 → **系统设置** → **对外 API** → 点「生成 API Key」。

- 生成后会显示完整 Key 和调用示例，点「复制」即可。
- 「重新生成」会让旧 Key **立即失效**；「停用」会关闭整个对外 API。
- Key 是明文存放在你自己的 D1 里，只有后台登录后能看到。

## 2. 接口

### 获取邮件列表

```
GET /api/external/emails
```

**鉴权**（二选一）：

- 请求头：`X-API-Key: <你的Key>`
- 或查询参数：`?key=<你的Key>`

**参数**：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `email` | ✅ | 要查询的邮箱地址（必须是后台已添加的账号） |
| `folder` | ❌ | `inbox`(默认) / `junkemail` / `deleteditems` / `all`（收件箱+垃圾箱合并） |
| `top` | ❌ | 返回条数，默认 10，最大 50 |
| `keyword` | ❌ | 搜索关键词 |
| `includeBody` | ❌ | 传 `1` 时每封邮件额外返回 `body` 字段（完整纯文本正文，不截断） |

> **关于 `bodyPreview` 截断**：`bodyPreview` 是 Microsoft Graph 固定截断到 **255 字符**的预览字段，无法配置成不截断。需要完整正文时请加 `includeBody=1`，从返回的 `body` 字段取（响应体会相应变大，建议配合较小的 `top` 使用）。
>
> **关于 `folder=all`（收件箱 + 垃圾箱合并）**：合并视图在服务端把两个文件夹各自最近 50 封按时间归并后返回，
> 所以最多只能覆盖到约 100 封。返回体里的 `hasMore` 表示后面还有没有下一页；需要翻更早的邮件请指定具体 `folder`。

### 导入账号

```
POST /api/external/accounts
```

用同一个 API Key 批量导入账号，**无需登录后台**。格式与「导出」完全一致，所以导出 → 导入可以闭环。

**账号行格式**（每行一个）：

```
邮箱----密码----client_id----refresh_token
```

- 密码可以留空：`abc@outlook.com--------client_id----refresh_token`
- 必须写满 4 段。**3 段行会被判为无效**（无法判断第 2 段是密码还是 client_id，不做猜测）
- 空行、以 `#` 开头的行会被忽略
- 分隔符固定为 4 个短横线 `----`

**请求体**（三选一，按 `Content-Type` 自动判断）：

| 形式 | 说明 |
|------|------|
| `text/plain` | 正文直接放多行账号行，最省事 |
| JSON `{ "account_string": "..." }` | 与后台「批量导入」同字段 |
| JSON `{ "accounts": [ ... ] }` | 数组元素可以是账号行字符串，也可以是 `{ "email", "password", "client_id", "refresh_token" }` 对象（也接受 `clientId` / `refreshToken` 驼峰写法） |

**参数**：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `group_id` | ❌ | 目标分组 ID，默认 1（默认分组）。也可写在 JSON body 里；query 优先。分组不存在会直接报错 |
| `dry_run` | ❌ | 传 `1` 时只做解析 + 查重，**不写库**，用于导入前预检 |

**返回**（HTTP 200，逐行结果，方便只重试失败的行）：

```json
{
  "success": true,
  "message": "已导入 2 条，重复 1 条，无效 1 条",
  "data": {
    "total": 4,
    "imported": 2,
    "duplicated": 1,
    "invalid": 1,
    "group_id": 1,
    "dry_run": false,
    "results": [
      { "line": 1, "email": "a@outlook.com", "status": "imported", "id": 12 },
      { "line": 2, "email": "b@outlook.com", "status": "imported", "id": 13 },
      { "line": 3, "email": "c@outlook.com", "status": "duplicate", "reason": "该邮箱已存在" },
      { "line": 4, "status": "invalid", "reason": "字段不足：需要 4 段 ..." }
    ]
  }
}
```

`status` 取值：

| 值 | 含义 |
|------|------|
| `imported` | 已写入，`id` 是新账号的主键 |
| `would_import` | `dry_run=1` 时「本会写入」 |
| `duplicate` | 库里已有该邮箱，或**同一请求内重复**（大小写不敏感） |
| `invalid` | 格式问题，看 `reason` |

**上限**：单次最多 **300 条**。每个账号要消耗 D1 查询（查重 + 插入），免费层单次 Worker 调用约 50 条查询的预算，超量请分批提交。

### 查询账号列表

```
GET /api/external/accounts?status=&keyword=&limit=
```

导入后用来核对结果。只返回元数据，**不含任何 token**。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `status` | ❌ | `active` / `error` / `disabled` |
| `keyword` | ❌ | 按邮箱或备注模糊匹配 |
| `limit` | ❌ | 默认 200，最大 1000 |

```json
{
  "success": true,
  "data": {
    "count": 1,
    "items": [
      { "id": 12, "email": "a@outlook.com", "status": "active", "group_id": 1, "group_name": "默认分组", "remark": "", "created_at": "2026-06-08 08:00:00" }
    ]
  }
}
```


## 3. 调用示例

**浏览器 / curl（查询参数方式）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com&key=你的Key&folder=all&top=5"
```

**请求头方式（更安全，Key 不出现在 URL / 日志里）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com" \
  -H "X-API-Key: 你的Key"
```

**取完整正文（不截断，验证测试方法）**

```bash
# 只取最新 1 封并带完整正文；对比 bodyPreview（最多 255 字符）与 body（完整）
curl "https://你的域名/api/external/emails?email=abc@outlook.com&top=1&includeBody=1" \
  -H "X-API-Key: 你的Key"
```

预期：返回的每个 item 里同时有 `bodyPreview`（预览，≤255 字符）和 `body`（完整纯文本正文）；不传 `includeBody` 时没有 `body` 字段。

**导入账号（纯文本，最省事）**

```bash
curl -X POST "https://你的域名/api/external/accounts" \
  -H "X-API-Key: 你的Key" \
  -H "Content-Type: text/plain" \
  --data-binary $'abc@outlook.com----密码----client_id----refresh_token\ndef@outlook.com----密码----client_id----refresh_token'
```

**导入账号（JSON，可指定分组 / 预检）**

```bash
# 先预检，不写库
curl -X POST "https://你的域名/api/external/accounts?dry_run=1&group_id=1" \
  -H "X-API-Key: 你的Key" -H "Content-Type: application/json" \
  -d '{"accounts":[{"email":"abc@outlook.com","client_id":"cid","refresh_token":"rt"}]}'
```

**Python（导入 + 只重试失败行）**

```python
import requests

API = "https://你的域名/api/external/accounts"
KEY = "你的Key"

lines = open("accounts.txt", encoding="utf-8").read().splitlines()

# 免费层单次查询预算有限，按 300 条一批提交
for i in range(0, len(lines), 300):
    batch = "\n".join(lines[i:i + 300])
    r = requests.post(
        API,
        headers={"X-API-Key": KEY, "Content-Type": "text/plain; charset=utf-8"},
        data=batch.encode("utf-8"),
    )
    data = r.json()["data"]
    print(f"批 {i // 300 + 1}: 导入 {data['imported']}，重复 {data['duplicated']}，无效 {data['invalid']}")
    for row in data["results"]:
        if row["status"] == "invalid":
            print("  需要修:", row.get("line"), row.get("reason"))
```

**Python（取最新验证码的典型用法）**
```python
import re, requests

resp = requests.get(
    "https://你的域名/api/external/emails",
    params={"email": "abc@outlook.com", "folder": "all", "top": 5},
    headers={"X-API-Key": "你的Key"},
)
data = resp.json()
for mail in data["data"]["items"]:
    # 从主题或正文预览里提取 6 位数字验证码
    m = re.search(r"\b(\d{6})\b", mail["subject"] + " " + mail["bodyPreview"])
    if m:
        print("验证码:", m.group(1))
        break
```

## 4. 返回格式

成功（HTTP 200）：

```json
{
  "success": true,
  "data": {
    "email": "abc@outlook.com",
    "folder": "all",
    "count": 2,
    "hasMore": false,
    "items": [
      {
        "id": "AAQ...",
        "subject": "Your verification code is 123456",
        "from": { "name": "Microsoft", "address": "account@microsoft.com" },
        "receivedDateTime": "2026-06-08T08:00:00Z",
        "bodyPreview": "Use code 123456 to sign in...",
        "isRead": false
      }
    ]
  }
}
```

> 加 `includeBody=1` 时，每个 item 会多一个 `"body": "完整纯文本正文..."` 字段。
>
> `hasMore` 表示这一页之后还有没有更多；老客户端可以忽略它。
> 响应头带 `Cache-Control: no-store`，因此任何中间缓存都不会返回上一次的旧邮件。

失败：

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "API Key 无效" } }
```

## 5. 错误码

| HTTP | code | 含义 |
|:----:|------|------|
| 403 | `API_DISABLED` | 还没生成 API Key（去系统设置生成） |
| 401 | `UNAUTHORIZED` | Key 缺失或不正确 |
| 400 | `BAD_REQUEST` | 缺少 `email` 参数；或导入时：账号行格式错误 / `group_id` 不合法或分组不存在 / 超过单次 300 条 / 请求体为空 |
| 404 | `NOT_FOUND` | 该邮箱不在后台账号列表里 |
| 400 | `DISABLED` | 该账号已被停用 |
| 502 | `TOKEN_FAILED` | 该账号 Token 失效，需在后台「重新授权」 |
| 502 | `GRAPH_ERROR` | 调用 Microsoft Graph 失败 |

## 6. 安全建议

- Key 等同于这些邮箱的读取权限，**不要写进前端代码或公开仓库**；优先用 `X-API-Key` 请求头而非 URL 参数（URL 会进日志/历史记录）。
- 怀疑泄露时，到系统设置点「重新生成」即可让旧 Key 立即作废。
- 接口只能读取**后台已添加**的邮箱，无法访问任意邮箱。
