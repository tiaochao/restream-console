# Technical Concerns & Known Issues

> 分析日期：2026-05-08
> 覆盖文件：server.js, db.js, services/task-manager.js, services/youtube-monitor.js, services/live-monitor.js, services/ssh.js, services/platform-api.js, routes/tasks.js, routes/media.js, routes/logs.js, routes/admin.js, routes/settings.js, middleware/auth.js, middleware/csrf.js, scripts/check.js

---

## Critical Issues（可能导致数据丢失、安全漏洞或系统崩溃的问题）

### 1. 数据库启动时执行破坏性 DDL（潜在数据丢失）

**文件**：`db.js` 第 243-253 行

```js
db.exec(`
  DELETE FROM source_channels WHERE id NOT IN (SELECT MIN(id) FROM source_channels GROUP BY user_id, url);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_source_channels_user_url ON source_channels(user_id, url);
`);
```

每次应用启动（`require('../db')`）都会自动执行 `DELETE` 语句，删除 `source_channels` 表中重复的频道记录，保留每组 `(user_id, url)` 中 `id` 最小的一行。这意味着：
- 如果某个频道因 bug 产生了两条记录，且用户在较新那条（较大 id）上配置了 `auto_start`、`auto_vps_id` 等字段，那条数据将在下次重启时被静默删除。
- 该操作没有事务保护，也没有日志记录，用户无感知。

### 2. `migrateSettingsPrimaryKey()` 引用了未声明的变量

**文件**：`db.js` 第 177-197 行

```js
function migrateSettingsPrimaryKey() {
  // ...
  db.prepare(`
    INSERT OR IGNORE INTO settings (user_id, key, value)
    SELECT ?, key, value FROM settings_old
  `).run(defaultUserId);  // <-- defaultUserId 在此函数定义时尚未赋值
```

`defaultUserId` 在第 234 行才被赋值，而 `migrateSettingsPrimaryKey()` 在第 236 行被调用。这依赖 JavaScript 变量提升（`var`），但 `defaultUserId` 以 `const` 声明。实际上这里能运行是因为调用点（第 236 行）在赋值之后，但函数体内使用时已经是赋值后的状态——本质是作用域时序的脆弱依赖，一旦调用顺序稍有变化便会抛 `ReferenceError`。

### 3. SSH 连接池无并发保护，可能产生重复连接

**文件**：`services/ssh.js` 第 24-48 行

`connect()` 函数先检查缓存，若无则建立连接，但整个流程不是原子操作。当多个健康检查任务（每 30s 并发 3 个）或多路上传同时触发 `sshService.exec()` 时，可能同时进入 `connect()`，对同一 `(vpsId, userId)` 发起多个 SSH 连接，最终只保留最后写入 `pool.Map` 的那个，其余连接泄露（不会被 `dispose()`）。

### 4. 单进程全局 `startQueue` Promise 链无上限增长

**文件**：`services/task-manager.js` 第 18 行，第 544-559 行

```js
let startQueue = Promise.resolve();
function startTaskQueued(...) {
  startQueue = startQueue.then(async () => { ... });
  return startQueue;
}
```

所有任务启动请求都串行追加到一个全局 Promise 链上。如果某个任务启动因 SSH 超时或 VPS 长时间无响应而卡死（`readyTimeout: 15000` 但后续 `execCommand` 无超时），整条队列会被堵塞，所有后续任务（包括健康检测触发的自动重启）都无法启动。此链永不清除，进程生命周期内会持续增长。

---

## High Priority Technical Debt（显著影响可维护性或可靠性的债务）

### 5. `checkHealth()` 的日志解析脆弱：纯正则匹配远端日志文本

**文件**：`services/task-manager.js` 第 580-823 行

健康状态完全依赖解析远端 bash 脚本输出到 `/tmp/restream_N.log` 的文本。日志格式由 `buildCommand()` 生成的 bash 脚本硬编码中文字符串（如 `[推流]`、`[兜底-录播]`）。任何编码问题（VPS 的 `LC_ALL` 未正确设置）或文本稍有变化都会导致所有正则失配，状态机判断全部失效。

- `logTail` 将 `\r\n` 替换为 `||` 后用 `split('|')` 重建行，若日志内容本身含有竖线字符（如 URL 参数或 FLV 地址中），会产生假行。
- `lastIndexMatching` 遍历全部 200 行，8 个以上的 pattern 反复调用，每次健康检查产生 ~1600 次正则测试（O(n×m)），且这些 pattern 包含回溯敏感的写法（如 `.*(?:...)`）。

### 6. `buildCommand()` 生成的 bash 脚本过于复杂，几乎无法调试

**文件**：`services/task-manager.js` 第 185-445 行

bash 脚本以 base64 编码嵌入 Node.js 字符串，通过 SSH 远端解码执行。脚本长达约 200 行，包含嵌套函数、trap 信号、子 shell 计算等高级特性。当脚本行为异常时，无法在不修改 Node.js 代码的情况下直接在 VPS 上查看或修改脚本内容。脚本内部硬编码了多个"魔法数字"：

- `_AUTO_REC_MIN_BYTES=1048576`（1 MB）
- `_AUTO_REC_MIN_FALLBACK_BYTES=65536`（64 KB）
- `_AUTO_REC_MAX_SECONDS=3600`（1 小时）
- `_AUTO_REC_MAX_BYTES=2147483648`（2 GB）
- `_FFMPEG_MAX_TIME=86400`（24 小时默认推流上限）

这些数值无法通过配置修改，改动需要重新生成整个命令字符串并重启任务。

### 7. `dqEsc` 函数在 `live-monitor.js` 中存在独立拷贝

**文件**：`services/live-monitor.js` 第 9-18 行，`services/task-manager.js` 第 22-28 行

两个文件各自定义了完全相同的 `dqEsc()` 和 `shSingleQuote()` 工具函数，没有提取为共享模块。若其中一处修复了转义漏洞而另一处未同步，会引入安全不一致。

### 8. `live-monitor.js` 的 `getSetting()` 调用不传 userId

**文件**：`services/live-monitor.js` 第 156 行

```js
const intervalMin = parseInt(getSetting('monitor_interval') || '5');
```

`getSetting` 签名为 `getSetting(key, userId = defaultUserId)`，此处未传 `userId`，始终使用 admin 的 `monitor_interval` 配置，与多用户架构不兼容——其他用户无法独立控制自己直播间的检测频率。

### 9. 无全局错误处理中间件（Express `error-handling middleware`）

**文件**：`server.js`

Express 推荐在所有路由之后注册 `(err, req, res, next)` 四参数中间件来捕获未处理异常。当前 `server.js` 没有此类中间件。路由内部的 `async` 处理函数若抛出未被 `catch` 的异常（如某些 `db.prepare().run()` 在约束冲突时），会直接触发 Express 默认错误处理（500 HTML 响应），在生产环境中可能暴露堆栈信息。

### 10. 数据库迁移方案不可逆且无版本控制

**文件**：`db.js` 第 199-253 行

使用手动 `ensureColumn()` 追加字段的方式进行 schema 变更，这些调用以数组形式写死在模块顶层，每次启动都执行。没有迁移版本号、没有回滚机制、没有迁移日志。已有 15 个 `ensureColumn` 调用，随着功能增加，此列表将持续增长，且无法判断数据库当前处于哪个"版本"。

---

## Medium Priority Issues（代码质量、缺失功能、次优模式）

### 11. `getTaskRows()` 在每次渲染时执行 UPDATE

**文件**：`routes/tasks.js` 第 35-50 行

```js
function getTaskRows(userId, ...) {
  db.prepare(`UPDATE tasks SET name = (...) WHERE user_id = ? AND ...`).run(userId);
  return db.prepare(`SELECT ...`).all(userId);
}
```

GET 请求（页面渲染）触发了数据库写操作，违反了 HTTP GET 的幂等性约定，且该 UPDATE 没有事务包裹，若 SELECT 因错误未执行，数据已被修改。

### 12. `routes/tasks.js` 中 `orderSql` 参数直接拼入 SQL

**文件**：`routes/tasks.js` 第 34 行

```js
function getTaskRows(userId, orderSql = "CASE t.status WHEN 'running' ...") {
  return db.prepare(`... ORDER BY ${orderSql}`).all(userId);
}
```

`orderSql` 以模板字符串直接拼入 SQL，虽然当前调用方均使用硬编码字符串（无外部输入），但该模式一旦被误用（如将 URL 参数传入），将导致 SQL 注入。

### 13. SSH 连接池缺少最大连接数限制

**文件**：`services/ssh.js`

`pool` 是无上限的 `Map`，每个 `(userId, vpsId)` 组合独立缓存一个 SSH 连接。当用户较多或 VPS 较多时，进程可能持有大量 SSH 长连接，消耗系统文件描述符。SSH 服务器端（如 openssh 默认 `MaxSessions 10`）也可能因连接数超限拒绝新连接。

### 14. `platform-api.js` 中的 Douyin API 参数可能过期

**文件**：`services/platform-api.js` 第 219-223 行

```js
const apiUrl = 'https://live.douyin.com/webcast/room/web/enter/' +
  `?aid=6383&app_name=douyin_web&live_id=1&device_platform=web` +
  `&browser_name=Chrome&browser_version=120.0.0.0` + ...
```

`browser_version=120.0.0.0` 和 `version_code=170400` 等参数硬编码于代码中，Chrome 120 已于 2024 年初过时。抖音后端可能已根据 UA/版本特征屏蔽旧版本请求，导致 API 检测静默失败。

### 15. YouTube 频道 handle 解析使用 `search` API，精度不稳定

**文件**：`services/youtube-monitor.js` 第 286-296 行

```js
async function resolveChannelIdByHandle(handle, apiKey) {
  const json = await youtubeApi('search', { q: `@${normalized}`, type: 'channel', maxResults: 1 }, apiKey);
  return json.items?.[0]?.snippet?.channelId || ...;
}
```

YouTube Data API v3 的 `search` 接口每次调用消耗 100 quota 单位（每日默认上限 10,000），而 `videos` 接口仅消耗 1 单位。使用 `search` 解析 handle 效率极低，且搜索结果可能返回同名的其他频道而非精确匹配。正确做法是使用 `channels` 接口的 `forHandle` 参数（消耗 1 quota）。

### 16. `checkHealth()` 的异常被整体吞掉

**文件**：`services/task-manager.js` 第 820-822 行

```js
} catch (_) {
  // SSH 暂时失败，不改状态
}
```

所有 `checkHealth` 中的异常（包括编程错误如 TypeError、ReferenceError）都被静默忽略，日志中无任何记录。这使得健康检测代码中潜藏的 bug 极难发现。

### 17. 媒体库 `fix-names` 接口在高并发时存在 TOCTOU 竞态

**文件**：`routes/media.js` 第 537-626 行

对每个文件先执行 SSH `stat` 获取 mtime，再执行 `ssh date` 格式化时间，最后执行 `ssh mv`，三次独立 SSH 调用之间存在时间窗口。若两个用户同时触发 `fix-names`，可能对同一文件发起两次 `mv`，第二次会因源文件已不存在而失败（有错误处理），但 DB 记录可能进入不一致状态。

### 18. `resolveChannelIdByHandle` 的结果没有缓存

**文件**：`services/youtube-monitor.js` 第 286-296 行

每次 YouTube 监控扫描都可能重复调用 handle 解析，消耗 quota。由于 handle 到 channelId 的映射是静态的，应该缓存到 `yt_channels` 表。

---

## Known Limitations（设计上的约束和已知边界情况）

### 19. 任务的进程存活检测依赖 `remote_pid`，进程树不完整时可能误判

bash 以 `nohup bash -c ... & echo $!` 方式启动，`remote_pid` 是 bash 解释器的 PID。内部的 `ffmpeg` 是其子进程，健康检测尝试用 `ps -o sid=` 或 `pgrep -P` 遍历进程组/子树，但在某些 VPS（如 Alpine 容器）上 `pgrep` 可能不可用，RTMP 连接检测会退化为 `rtmp_unknown`，导致 YouTube RTMP 状态无法判断。

### 20. `waiting_live` 状态下只有有限平台会自动检测

**文件**：`services/task-manager.js` 第 882-902 行

只支持 Douyin、Bilibili、Kuaishou 三个平台的自动开播检测。其他平台（如 YouTube 直播源）或自定义 RTMP 直播不会进入 `waiting_live` 流程，需要手动启动。

### 21. 每个 VPS 的任务上限 `max_tasks_per_vps` 仅限单机检查

**文件**：`services/task-manager.js` 第 460-465 行

任务数上限在 `startTask` 时做 `COUNT(*)` 查询，但这是个非原子检查——如果两个请求同时通过检查，可能超出上限。SQLite 是串行写入，但由于 Node.js 事件循环，理论上两个 `await` 间隔足以让两个请求都通过计数检查。

### 22. 录播文件最大 1 小时 / 2 GB，超出后只保留主推流

设计上有意截断，但不会通知用户，若直播超过 1 小时，录播文件自动截止，用户以为有完整录播但实际只有第一小时的内容。

---

## Security Concerns（安全漏洞）

### 23. SSH 私钥以明文存储于数据库

**文件**：`db.js` 表 `vps`，`services/ssh.js` 第 11-21 行

VPS 的 `password` 和 `private_key` 字段以明文存储在 `data/db.sqlite`。任何能读取该文件的人（如 VPS 上的其他进程、备份服务）都可获取全部远程服务器凭证。没有加密存储机制。

### 24. Cookie 以明文存储于数据库

**文件**：`db.js` 表 `settings`，key=`douyin_cookies`

抖音 Cookie 包含会话令牌，以明文存于 `settings` 表，问题同上。

### 25. `healthz` 接口无需认证即可访问

**文件**：`server.js` 第 42 行

```js
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'restream-console' }));
```

健康检查接口本身无害，但其存在未经认证即可访问的路由，且在路由列表中它位于 `requireAuth` 中间件之后的第一条，意味着任何知道此路径的人都能确认服务是否在线。如果后续开发人员误将敏感信息加入此响应，将直接暴露。

### 26. 日志路径 (`log_file`) 未做路径遍历防护

**文件**：`routes/logs.js` 第 34 行，`services/task-manager.js` 第 188 行

`log_file` 字段由 `buildCommand()` 固定生成为 `/tmp/restream_${task.id}.log`，但数据库中存储的值可以被直接修改（通过 SQLite 客户端）。`logs.js` 在执行 `tail -n 200 ${shQuote(task.log_file)}` 时虽然使用了单引号转义，但如果 `log_file` 本身是恶意路径（如 `/etc/passwd`），仍可读取服务器任意文件。路由层没有对 `log_file` 值做合法性验证（仅要求非空）。

### 27. CSRF 令牌使用字符串相等比较，而非时序安全比较

**文件**：`middleware/csrf.js` 第 11-14 行

```js
return values.some(value => value === expected);
```

JavaScript 字符串 `===` 比较不是时序安全（timing-safe）的。虽然 CSRF 令牌是随机的 hex 字符串（32 字节），理论上时序攻击的可行性极低，但按最佳实践应使用 `crypto.timingSafeEqual()`。

### 28. 会话存储使用内存（`express-session` 默认）

**文件**：`server.js` 第 27-37 行

使用 `express-session` 默认的 `MemoryStore`，官方文档明确警告此存储不适用于生产：会话数量增加时内存无限增长，进程重启后所有会话丢失（所有用户登出）。没有持久化存储（如 SQLite session store）。

---

## Scalability Concerns（用量增加时的瓶颈）

### 29. SQLite 单文件数据库限制并发写入

所有写操作在单个 SQLite 文件上串行执行。健康检测每 30s 对所有运行任务并发发起检查（批次 3），每次检查可能写入多个 `UPDATE`。当运行任务超过 30 个时，单次轮询可能需要 30s 以上，导致下一轮轮询开始前上一轮未完成，监控出现积压。

### 30. `live-monitor.js` 对所有频道串行检测

**文件**：`services/live-monitor.js` 第 163-168 行

```js
for (const ch of channels) {
  await checkAndUpdate(ch).catch(...);
}
```

频道检测完全串行，每次检测包含 1-2 个 HTTP 请求（15s 超时）。若有 20 个频道，单次扫描最多需要 600s（10 分钟），远超 5 分钟的默认检测间隔，轮询会产生积压。

### 31. SSH 连接池无跨请求共享策略

每个 `(userId, vpsId)` 维护一个连接，但健康检测批次 3 同时触发，同一 VPS 上的 3 个任务可能并发发起 3 个健康检查，这 3 个检查共用同一 SSH 连接（`pool` 复用），但每个 `execCommand` 是串行的（SSH2 channel），在网络延迟较高时可能产生排队。

---

## Operational Concerns（部署、监控、调试困难）

### 32. 没有结构化日志，所有输出混用 `console.log/warn/error`

应用无统一日志格式（如 JSON）、无日志级别过滤、无时间戳（Node.js `console` 默认不附加时间）。在生产环境中定位问题需要逐行阅读混合中英文的 `console` 输出。

### 33. 没有进程管理，无优雅停机

**文件**：`server.js`

没有 `process.on('SIGTERM', ...)` 或 `process.on('SIGINT', ...)` 处理器。进程被杀死时，正在运行的任务状态不会被更新（仍为 `running`），下次启动后这些"僵尸"任务需要手动干预，或等到健康检测发现进程已死才更新状态（最多 30s 延迟）。

### 34. `scripts/check.js` 直接初始化数据库，CI 环境中会写入数据

**文件**：`scripts/check.js` 第 24 行

```js
require('../db');
```

`check.js` 作为代码质量检查脚本，执行时会触发 `db.js` 的全部初始化逻辑（建表、迁移、创建 admin 用户）。在 CI 环境中运行 `npm run check` 会在当前目录创建 `data/db.sqlite`，如果 CI 目录在版本控制下，可能意外提交数据库文件。

### 35. 远端依赖安装每次任务启动都重新执行

**文件**：`services/task-manager.js` 第 155-163 行，`ensureRemoteRuntime()`

`remoteDependencyInstallCommand()` 生成的命令在每次 `startTask()` 时都会通过 SSH 执行。虽然使用了 `command -v` 检查，但仍会在每次任务启动时建立一次 SSH 会话。如果 VPS 的 `apt` 索引过期或网络慢，该步骤可能需要 30-120s，阻塞整个启动队列（见问题 4）。

### 36. VPS 上的 `/tmp` 目录中遗留大量临时文件

每个任务创建：
- `/tmp/restream_N.log`（日志）
- `/tmp/restream_ytdlp_N.err`（yt-dlp 错误）
- `/tmp/restream_douyin_N.err`（抖音解析错误）
- `/tmp/dy_ck_N.txt`（抖音 Cookie 临时文件）

任务停止时只清理了进程，这些文件不会被自动删除，久而久之会在 `/tmp` 中积累。特别是 `/tmp/dy_ck_N.txt` 含有 Cookie 明文，残留在 VPS 上是安全风险。

---

## Dependencies at Risk（依赖风险）

### 37. 依赖版本均为 `^` 宽松约束，无 lockfile 控制

**文件**：`package.json`

所有依赖均使用 `^` 约束（允许 minor 版本自动升级），且无 `package-lock.json`（未在 git 中提交或不存在）。`node-ssh@^13.2.0` 等依赖的一次 minor 更新可能引入 breaking change。

### 38. 依赖 `yt-dlp` 和 `streamlink` 的远端最新版本

**文件**：`services/task-manager.js` 第 161 行

```
wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN"
```

每次首次安装时拉取 `yt-dlp` 的 `latest` 版本，不固定版本号。yt-dlp 版本之间有时存在参数变化（如 `-f` 格式字符串语法），若新版改变了 `-g` 输出格式，直链解析会静默失败，任务无法获取直播流。

### 39. 使用 Node.js 内置 `node:sqlite`（实验性 API）

**文件**：`db.js` 第 1 行

```js
const { DatabaseSync } = require('node:sqlite');
```

`node:sqlite` 模块（`DatabaseSync`）是 Node.js 22.5+ 引入的实验性内置模块，不保证 API 稳定性。若部署环境的 Node.js 版本不满足要求（<22.5），应用无法启动。`package.json` 中没有 `engines` 字段声明最低版本要求。

### 40. `express-ejs-layouts@^2.5.1` 历史维护不活跃

该包最后更新于 2020 年前后，GitHub 仓库 issue 积压，部分与 Express 5 相关的兼容性问题未修复。若后续升级 Express 版本，该包可能是阻塞点。

---

## TODO/FIXME Inventory（代码中发现的 TODO/FIXME 注释）

经全代码库扫描（`grep -r "TODO\|FIXME\|HACK\|XXX\|BUG" --include="*.js"`），**未发现任何 TODO/FIXME 注释**。

这本身是一个隐患：代码库缺乏内联的技术债务标记，已知的权宜之计（如上述"魔法数字"、脆弱的正则日志解析）没有在代码中留下任何标记，维护者需要通过代码审查才能发现这些问题，而非通过搜索注释。

---

## 风险优先级汇总

| 等级 | 编号 | 问题简述 |
|------|------|----------|
| 严重 | 1 | 启动时静默删除重复频道数据 |
| 严重 | 2 | `migrateSettingsPrimaryKey` 变量时序依赖 |
| 严重 | 3 | SSH 连接池并发建立泄露连接 |
| 严重 | 4 | 全局 startQueue 无上限增长且可被阻塞 |
| 高 | 5 | 健康检测依赖脆弱文本正则解析 |
| 高 | 6 | buildCommand 生成脚本不可调试、含魔法数字 |
| 高 | 23 | SSH 私钥明文存储 |
| 高 | 24 | Cookie 明文存储 |
| 高 | 26 | log_file 路径未做合法性验证 |
| 高 | 28 | 会话使用 MemoryStore，不适用生产 |
| 高 | 29 | SQLite 在高并发写入下会产生积压 |
| 高 | 33 | 无优雅停机，重启后有僵尸任务 |
| 高 | 39 | 依赖实验性 `node:sqlite` API |
