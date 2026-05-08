# Code Conventions

## Language & Style

- **运行时**：Node.js，使用 `node:sqlite`（Node.js 22+ 内置 DatabaseSync）而非 better-sqlite3 第三方包
- **模块系统**：全项目使用 CommonJS（`require` / `module.exports`），无 ESM
- **ES 版本**：ES2022+，大量使用 `async/await`、可选链（`?.`）、逻辑空值合并（`??`）、`Array.isArray`、`for...of` 等现代语法
- **异步风格**：路由处理器中 async 函数 + `try/catch`；后台轮询服务用 `setInterval` + 独立 async 函数；SSH 命令执行统一通过 `await sshService.exec()`
- **错误吞噬**：对非关键路径的异常广泛使用 `catch (_) {}` 静默忽略（例如辅助查询失败不影响主流程）

## Naming Conventions

| 类型 | 约定 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `task-manager.js`、`stream-keys.js`、`youtube-monitor.js` |
| 变量 / 函数 | camelCase | `getTaskRows`、`resolveTaskName`、`normalizeInput` |
| 常量 | UPPER_SNAKE_CASE | `PLATFORM_RTMP`、`HEALTH_LOG_TAIL_LINES`、`MEDIA_LIBRARY_DIR` |
| 路由路径 | kebab-case | `/stream-keys`、`/youtube-channels` |
| 数据库表名 | snake_case 复数 | `stream_keys`、`source_channels`、`yt_channels`、`yt_videos` |
| 数据库列名 | snake_case | `user_id`、`rtmp_url`、`stream_key`、`auto_restart`、`live_status` |
| EJS 模板 | kebab-case | `stream-keys.ejs`、`youtube-channels.ejs` |
| 服务层文件 | 功能描述 + `-` 分隔 | `task-manager.js`、`live-monitor.js`、`youtube-channel-sync.js` |

## Route Handler Pattern

所有路由遵循一致的分层结构：

```
1. 权限/存在性验证（SELECT ... WHERE id=? AND user_id=? → 403/404）
2. 输入归一化（normalizeInput / cleanSourceUrl 等辅助函数）
3. 业务校验（validateKeyInput → 返回错误字符串或 null）
4. 数据库写入（db.prepare(...).run(...)）
5. 响应
   - 表单提交 POST → res.redirect('/path?toast=...&type=success|error')
   - AJAX/JSON POST → res.json({ ok: true/false, msg: '...' })
   - 页面渲染 GET → res.render('view', { ... })
```

辅助函数提取模式：每个路由文件都提取 `renderPage(req, res, opts)` 或 `renderTasks(res, req, status, error)` 形式的页面渲染辅助函数，避免重复传递模板变量。

## Error Handling

根据请求类型分两种响应策略：

- **表单 POST（页面跳转流）**：
  - 成功：`res.redirect('/path?toast=消息&type=success')`
  - 失败：`renderPage(req, res, { status: 400, error: '错误说明' })` 或 `res.redirect('...?toast=...&type=error')`
- **AJAX / JSON POST**：
  - 成功：`res.json({ ok: true, msg: '...' })`
  - 失败：`res.status(4xx/5xx).json({ ok: false, msg: e.message })`
- **判断依据**：通过 `req.headers['x-csrf-token']`、`Accept: application/json` 或 `Content-Type: application/json` 判断是否为 JSON 请求（见 csrf.js）
- **未捕获异常**：路由级 try/catch 兜底，`catch (e)` 将 `e.message` 直接暴露给客户端

## Database Access Pattern

- **驱动**：`node:sqlite`（Node.js 内置）的 `DatabaseSync`，同步 API，无 callback/Promise
- **Prepared Statements**：所有 SQL 通过 `db.prepare(sql).run(...)` / `.get(...)` / `.all(...)` 执行，参数化查询防注入
- **事务**：未见显式 `db.transaction()` 调用；迁移逻辑在 `db.js` 启动时顺序执行
- **Schema 迁移**：通过 `ensureColumn(table, column, definition)` 函数按需 `ALTER TABLE ADD COLUMN`，兼容旧版数据库
- **设置读写**：统一通过 `getSetting(key, userId)` 读取，`INSERT OR REPLACE INTO settings` 写入
- **初始化**：`db.js` 在模块加载时同步完成所有建表、迁移、默认数据填充，其他模块 `require('../db')` 即可使用

## Frontend / EJS Patterns

- **模板引擎**：EJS + `express-ejs-layouts`，单一 `layout.ejs` 布局文件
- **样式**：Tailwind CSS（CDN）+ 大量内联自定义 CSS 变量（`layout.ejs` 内约 600 行 `<style>`），支持浅色/深色主题切换
- **交互库**：htmx 1.9.10（CDN）用于局部刷新；直接 `fetch()` API 用于复杂操作（批量、状态检测等）
- **CSRF 处理**：`layout.ejs` 全局拦截 `window.fetch`，对非 GET/HEAD/OPTIONS 请求自动注入 `x-csrf-token` 请求头；htmx 通过 `htmx:configRequest` 事件同步注入；HTML 表单通过 `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` 传递
- **Toast 通知**：两种触发方式：
  1. URL 参数：`?toast=消息&type=success|error|info` → 页面加载时 JS 读取并显示
  2. 响应头：`X-Toast: {"msg":"...","type":"..."}` → htmx `afterRequest` 事件读取
- **EJS 辅助函数**：在模板文件顶部 `<% function ... %>` 定义（如 `formatDuration`、`taskDisplayName`、`youtubeStatusCfg`），仅在该模板内使用
- **状态 Badge**：统一使用 `.badge .badge-green/red/yellow/blue/gray/orange` CSS 类 + `.badge-dot.pulse` 动画点

## Security Patterns

- **会话认证**：`express-session` 管理会话，`middleware/auth.js` 的 `requireAuth` 检查 `req.session.authenticated && req.session.userId`；未认证跳转 `/login`
- **角色控制**：`requireAdmin` 检查 `res.locals.currentUser.role === 'admin'`，返回 403
- **CSRF 防护**：`middleware/csrf.js` 对所有非安全方法验证 token，token 存储于 session（32 字节随机 hex），支持请求头和 body 两种提交方式
- **多用户数据隔离**：所有数据库查询均带 `WHERE ... AND user_id=?`（见下节）
- **Shell 注入防御**：`task-manager.js` / `live-monitor.js` 中定义 `dqEsc(s)`（双引号转义）和 `shSingleQuote(s)`（单引号转义）函数，用于构造 SSH 命令时对用户输入进行转义
- **密码存储**：PBKDF2-SHA256，310000 轮，16 字节随机 salt，格式 `pbkdf2$salt$hash`；比较使用 `crypto.timingSafeEqual` 防时序攻击
- **RTMP 输入校验**：`validateKeyInput` 检查 URL 格式（`/^rtmps?:\/\//i`）并过滤 `\r\n\0` 等非法字符
- **生产环境要求**：`SESSION_SECRET` 和 `ADMIN_PASSWORD` 环境变量在生产环境强制要求，否则启动报错

## Logging

- **格式**：无结构化日志库，直接使用 `console.log` / `console.warn`
- **前缀约定**：`[模块名]` 前缀，如 `[live-monitor]`、`[stream-keys]`、`[task-manager]`、`[db]`
- **日志内容**：
  - `console.log`：正常业务事件（自动关联推流码、服务启动、检测结果）
  - `console.warn`：可恢复错误（SSH 检测失败、抖音 API 失败等）
  - `console.error`：未在代码中出现（错误直接通过 HTTP 响应返回或静默忽略）
- **任务日志**：转推任务的 ffmpeg 输出写入远端 VPS 的日志文件（路径记录在 `tasks.log_file`），通过 SSH 读取

## Multi-User Isolation

所有数据表均包含 `user_id` 外键列，数据隔离完全依赖查询层显式 `user_id` 过滤：

- **查询模式**：`WHERE id=? AND user_id=?` 或 `WHERE user_id=?`，所有 SELECT/UPDATE/DELETE 操作均携带
- **`req.session.userId`**：认证中间件通过后挂载于 session，路由层直接取用
- **跨表校验**：写入前先用 `SELECT id FROM vps WHERE id=? AND user_id=?` 验证外键归属，防止越权引用他人资源（见 stream-keys.js 的 `normalizeDefaultVpsId`、tasks.js 的 VPS 校验）
- **SSH 连接池**：`ssh.js` 中连接池 key 为 `${userId}:${vpsId}`，用户间不共享 SSH 连接
- **设置隔离**：`settings` 表主键为 `(user_id, key)`，通过 `getSetting(key, userId)` 读取
