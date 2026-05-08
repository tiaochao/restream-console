# Testing

## Test Framework

项目**没有安装任何测试框架**（package.json 中无 jest、mocha、vitest、tap 等依赖，devDependencies 字段不存在）。

所有"测试"能力由项目自带的两个脚本提供：
- `npm run check` → `scripts/check.js`（静态检查 + 关键行为断言）
- `npm run smoke` → `scripts/smoke.js`（端到端冒烟测试）

## Existing Tests

| 文件 | 类型 | 说明 |
|------|------|------|
| `scripts/check.js` | 静态 + 断言 | JS 语法检查 + 关键模块加载 + Shell 脚本内容断言 |
| `scripts/smoke.js` | 端到端 | 启动真实服务器，验证注册/登录/页面可访问性 |

无任何 `*.test.js`、`*.spec.js` 或 `test/` 目录。

## Manual Testing

### scripts/check.js — 详细说明

这是项目最核心的自动化验证脚本，分三个阶段：

**阶段 1：JS 语法检查**

遍历项目所有 `.js` 文件（排除 `node_modules` 和 `data` 目录），对每个文件执行 `node --check`，有语法错误则立即退出。

**阶段 2：关键模块加载验证**

`require()` 所有核心模块（middleware、routes、services），确保：
- 模块可正常加载（无循环依赖、无缺失依赖）
- 数据库初始化（建表、迁移、默认数据）无异常
- 服务层单例（task-manager、live-monitor 等）初始化无异常

**阶段 3：Shell 脚本内容断言（最关键部分）**

通过调用 `taskManager._buildCommand(mockTask)` 生成完整的 SSH 推流 Shell 脚本（Base64 编码），解码后对生成脚本进行字符串包含/不包含断言，覆盖约 25 个关键行为点，包括：

- 录播临时文件收尾逻辑（`_finalize_auto_record_tmp`）
- 录播文件名生成（含时间戳、主播名、任务 ID）
- 软链接兼容旧路径（`ln -sfn`）
- 录播兜底快照机制（`_AUTO_REC_FALLBACK`）
- 短直播录播留存判断
- 统一兜底推送函数（`_push_auto_record_fallback`）
- ffmpeg 参数正确性（`-reconnect`、`-map`、`-fs`、`-t`、`-flush_packets`）
- 不存在已废弃的独立录播进程模式（`_start_auto_record`、`_AUTO_REC_PID_FILE`）

同时对源文件（`task-manager.js`、`db.js`、`youtube-monitor.js`、`settings.js`）进行文本断言，验证健康检测逻辑、YouTube API Key 池、配置项等关键实现的存在性。

```bash
npm run check  # 通过时输出: OK: checked N JavaScript files, loaded key modules, bootstrapped database, and verified auto-record fallback script
```

### scripts/smoke.js — 详细说明

端到端冒烟测试，流程：

1. 启动独立服务器进程（`NODE_ENV=test`、`ALLOW_REGISTRATION=true`）
2. 轮询 `/healthz` 等待服务就绪（最多 10 秒）
3. 用随机用户名注册新账号，验证响应为 302 重定向
4. 用注册返回的 Cookie 访问所有主要页面：`/dashboard`、`/vps`、`/tasks`、`/channels`、`/stream-keys`、`/media`、`/logs`、`/settings`
5. 验证每个页面返回 200，否则抛出带页面路径的错误

```bash
npm run smoke  # 通过时输出: OK: smoke test passed
```

## Test Gaps

以下关键功能区域**完全没有自动化测试覆盖**：

| 区域 | 未覆盖内容 |
|------|-----------|
| **数据库层** | CRUD 操作正确性、user_id 隔离边界条件、迁移后数据完整性 |
| **认证流程** | 密码哈希/验证、会话失效、重复登录、CSRF token 验证逻辑 |
| **多用户隔离** | 跨用户 ID 越权访问（A 用户能否操作 B 用户的任务/VPS） |
| **任务管理业务逻辑** | 任务状态机转换（idle→running→stalled→restarting）、auto_restart 行为 |
| **Shell 命令生成（参数变体）** | 不同平台（bilibili vs douyin）、备用 URL、媒体文件路径 source 的命令差异 |
| **输入校验** | RTMP URL 格式边界、非法字符过滤、超长输入截断 |
| **YouTube API 集成** | API Key 轮换、配额耗尽处理、频道 ID 解析 |
| **SSH 连接池** | 断线重连、连接复用、用户隔离 |
| **抖音平台 API** | 直播状态检测、速率限制队列行为 |
| **路由 CSRF 保护** | 缺少 token 时是否正确返回 403 |
| **媒体库上传** | 分块上传、会话过期、VPS 路径校验 |

## Testing Approach for This Project

鉴于本项目的特殊性（强依赖 SSH + 远端 VPS + 外部直播平台 API），建议分层测试策略：

### 第 1 层：单元测试（最高优先级，无需外部依赖）

优先为以下**纯函数**编写单元测试（可直接 require 后调用，无副作用）：

- `task-manager.js` 中的 Shell 命令构建函数（`dqEsc`、`shSingleQuote`、`normalizeRecordLabel`、`recordLabelForTask`）
- `routes/stream-keys.js` 中的 `validateKeyInput`、`normalizeInput`、`buildVerifyCommand`
- `routes/tasks.js` 中的 `fallbackTaskName`、`cleanSourceUrl`、`validateSourceForVps`
- `db.js` 中的 `hashPassword` / `verifyPassword`
- `middleware/csrf.js` 中的 `tokenMatches`

推荐工具：Node.js 内置 `node:test` 模块（无需安装额外依赖），或 `uvu`（极轻量）。

### 第 2 层：集成测试（需要真实 SQLite，无需网络）

使用内存 SQLite 或临时文件数据库，测试：

- 用户注册/登录、user_id 数据隔离（A 不能读取 B 的任务）
- 任务 CRUD、stream_key CRUD
- 设置读写隔离

### 第 3 层：HTTP 集成测试（扩展现有 smoke.js）

在现有 smoke.js 基础上增加：

- CSRF 保护验证（POST 不带 token → 403）
- 认证保护验证（未登录访问保护页面 → 重定向 /login）
- 跨用户越权访问（注册两个用户，验证 A 无法操作 B 的资源）

### 第 4 层：契约测试（SSH / 外部 API 的 Mock）

对 `services/ssh.js`、`services/platform-api.js`、`services/youtube-monitor.js` 等 I/O 密集型服务，通过 Mock 测试其业务逻辑（如 API Key 轮换算法、断线重试机制），而无需真实外部连接。

### 当前方案的合理性

现有 `check.js` 的文本断言方式虽然非传统，但对于**Shell 脚本生成**这类"输出即契约"的场景非常有效：任何对 `_buildCommand` 的改动若破坏了已知的 Shell 片段，check 会立即失败。这相当于对核心业务逻辑（录播兜底推流）的回归测试，在没有测试框架的前提下实现了可接受的安全网。
