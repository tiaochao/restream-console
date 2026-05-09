---
phase: 07-vps-auto-scheduling
reviewed: 2026-05-09T10:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - services/vps-scheduler.js
  - __tests__/vps-scheduler.test.js
  - services/task-manager.js
  - views/tasks.ejs
  - views/stream-keys.ejs
  - views/task-detail.ejs
  - routes/tasks.js
findings:
  critical: 3
  warning: 4
  info: 3
  total: 10
status: issues_found
---

# Phase 07: VPS 自动调度 — 代码审查报告

**审查时间：** 2026-05-09
**审查深度：** standard
**审查文件数：** 7
**状态：** issues_found

## 概述

本次审查涵盖 VPS 自动调度功能（FEAT-01）的全部新增/修改文件。调度器核心逻辑（`vps-scheduler.js`）代码质量较高，但与其交互的 `task-manager.js` 存在两处逻辑漏洞，`routes/tasks.js` 存在安全问题，多个前端 AJAX 请求缺少 CSRF token。

---

## Critical Issues（阻塞级）

### CR-01: 调度器上限与任务管理器上限计算口径不一致，导致可突破任务上限

**文件：** `services/task-manager.js:82`

**问题：**
`vps-scheduler.js` 在 SQL 的 `HAVING` 子句中计数的是全部活动状态任务（`running`、`source_retrying`、`target_lost`、`stalled`、`restarting`）；而 `task-manager.js` 在 startTask 中校验上限时只统计 `status='running'`：

```js
// task-manager.js 第 82 行：仅统计 running
const running = db.prepare(
  "SELECT COUNT(*) as n FROM tasks WHERE user_id=? AND vps_id=? AND status='running'"
).get(ownerId, task.vps_id).n;
```

`vps-scheduler.js` 第 26 行则使用：

```sql
AND t.status IN ('running', 'source_retrying', 'target_lost', 'stalled', 'restarting')
```

若某 VPS 上已有 5 个任务处于 `stalled` 状态（尚未 `running`），调度器会正确拒绝分配；但手动指定 VPS 时，`task-manager.js` 的二次校验却认为 `running=0 < maxPerVps=5`，从而放行启动——实际上这台 VPS 已经"满载"。两处口径必须统一。

**修复：**
```js
// task-manager.js 第 81-83 行，将 status='running' 改为与调度器一致
const running = db.prepare(`
  SELECT COUNT(*) as n FROM tasks
  WHERE user_id=? AND vps_id=?
  AND status IN ('running', 'source_retrying', 'target_lost', 'stalled', 'restarting')
`).get(ownerId, task.vps_id).n;
```

---

### CR-02: `writeEvent` 记录的 `from_status` 已过时（状态在写事件前已被修改）

**文件：** `services/task-manager.js:154-164`

**问题：**
`startTask` 在第 154-159 行将数据库 `status` 更新为 `'running'`，然后在第 164 行调用 `writeEvent(taskId, task.user_id, task.status, 'running', ...)`。

此时 `task.status` 是从数据库读取后、存在内存中的旧状态快照（在 `UPDATE` 之前读取的），理论上 `task.status` 确实是旧值，这是"幸运的"。**但存在一个隐蔽漏洞**：若任务 `vps_id` 为空（调度器分配路径），代码在第 71 行修改了 `task.vps_id = scheduledVps.id`，并在第 163 行才执行 `UPDATE tasks SET vps_id=?`——这意味着在第 154 行执行 `UPDATE tasks SET status='running'` 时，数据库中的 `vps_id` **仍为 NULL**。health check 在 `startTask` 返回后可能立即（30s 定时器）读到 `vps_id=NULL` 的 running 任务，并因 `!task.vps_id` 直接返回跳过检查（`checkHealth` 第 228 行），导致这个窗口期内任务无法被健康检测。

正确做法是在同一个 SQL 中同时更新 `status` 和 `vps_id`：

**修复：**
```js
// 将两条 UPDATE 合并为一条，确保原子性
db.prepare(`
  UPDATE tasks
  SET status='running', remote_pid=?, log_file=?,
      started_at=datetime('now'), last_active_at=datetime('now'),
      stall_count=0, block_count=0,
      vps_id=COALESCE(?, vps_id)
  WHERE id=?
`).run(pid, logFile, scheduledVps ? scheduledVps.id : null, taskId);
```
然后删除后面重复的 `UPDATE tasks SET vps_id=?`。

---

### CR-03: 批量操作请求缺少 CSRF token，所有批量启动/停止均无 CSRF 保护

**文件：** `views/tasks.ejs:642-651`

**问题：**
`batchAction` 函数发送的 POST 请求头中仅携带 `Content-Type: application/json`，**没有** `x-csrf-token`：

```js
const r = await fetch('/tasks/batch-' + action, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },  // 没有 csrf token！
  body: JSON.stringify({ ids }),
});
```

相比之下，同文件中 `checkYouTubeTask`（第 625 行）和上传相关函数均正确携带了 `x-csrf-token: _csrf`。`taskAction`（第 555 行）和 `toggleRestart`（第 564 行）也没有携带 CSRF token。

`/tasks/batch-start` 可批量启动任意任务，`/tasks/batch-stop` 可批量停止所有任务，属于高危操作，缺少 CSRF 保护意味着攻击者可通过诱导用户点击链接实施 CSRF 攻击。

**修复：**
```js
async function batchAction(action) {
  // ...
  const r = await fetch('/tasks/batch-' + action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': _csrf,   // 添加此行
    },
    body: JSON.stringify({ ids }),
  });
}

async function taskAction(id, action, btn) {
  // ...
  const r = await fetch('/tasks/' + id + '/' + action, {
    method: 'POST',
    headers: { 'x-csrf-token': _csrf },  // 添加此行
  });
}

async function toggleRestart(id, btn) {
  const r = await fetch('/tasks/' + id + '/toggle-restart', {
    method: 'POST',
    headers: { 'x-csrf-token': _csrf },  // 添加此行
  });
}
```

---

## Warnings（警告级）

### WR-01: `routes/tasks.js` 中删除任务时使用原始字符串 `req.params.id`，而非整数

**文件：** `routes/tasks.js:246,250`

**问题：**
路由 `POST /:id/delete` 虽然 Express 路由正则 `/:id(\\d+)` 限制了参数格式，但直接将字符串传入 `db.prepare().get()` 和 `.run()`：

```js
const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
// ...
db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
```

SQLite 会做类型转换，通常不会出错；但与同文件其他路由（如第 255 行使用 `parseInt`）不一致，且依赖框架层面的参数过滤。一旦路由正则被移除或修改，将产生潜在的类型注入风险。`toggle-restart`（第 279-282 行）同样有此问题。

**修复：**
```js
const taskId = parseInt(req.params.id, 10);
if (!taskId) return res.status(400).send('非法参数');
const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
// ...
db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(taskId, req.session.userId);
```

---

### WR-02: `getTaskRows` 在每次 GET 请求时执行全表 UPDATE，性能与语义均不合适

**文件：** `routes/tasks.js:35-50`

**问题：**
每次渲染任务列表页时，`getTaskRows` 都会先执行一个全量 UPDATE，将满足条件的任务名称回填为 `[Auto] 频道名`。这不是获取数据应有的行为——读操作不应产生写副作用。如果有多个并发请求，该 UPDATE 会并发修改同一批数据行。更严重的是，即使任务已有手动设置的名称也不会受影响（WHERE 中有保护），但将读和写混在同一个"渲染辅助函数"中，职责严重不清晰，后续难以维护，且在高并发下可能引发写入竞态。

**修复：**
将该 UPDATE 逻辑移至专门的写操作时机（如任务创建/频道状态更新时），`getTaskRows` 仅做 SELECT。

---

### WR-03: `vps-scheduler.js` 中 `getSetting` 若返回非数字字符串时静默降级为 NaN，导致没有上限

**文件：** `services/vps-scheduler.js:17`

**问题：**
```js
const maxPerVps = parseInt(getSetting('max_tasks_per_vps', userId) || '5');
```

若 `getSetting` 返回 `'abc'` 或空格等非法值，`parseInt('abc')` 返回 `NaN`。在 SQL 的 `HAVING COUNT(t.id) < ?` 中，SQLite 收到 `NaN` 时会将其视为 `0` 或者产生不确定行为，导致 `HAVING COUNT < 0` 始终为 false，即没有任何 VPS 满足条件，`selectBestVps` 返回 null，用户会收到"无可用 VPS"错误——而实际上是配置项格式错误导致的。

**修复：**
```js
const maxPerVps = parseInt(getSetting('max_tasks_per_vps', userId) || '5', 10);
if (isNaN(maxPerVps) || maxPerVps <= 0) {
  logError('selectBestVps', new Error(`max_tasks_per_vps 配置无效，使用默认值 5`));
  // fallback to 5
}
const limit = (!isNaN(maxPerVps) && maxPerVps > 0) ? maxPerVps : 5;
```

---

### WR-04: `task-manager.js` `startMonitor` 中健康检测不包含 `restarting` 状态任务

**文件：** `services/task-manager.js:314-316`

**问题：**
健康检测的定时任务只查询 `running`、`stalled`、`source_retrying`、`target_lost`：

```js
"SELECT * FROM tasks WHERE status IN ('running','stalled','source_retrying','target_lost')"
```

`restarting` 状态的任务被排除在外。如果一个任务进入 `restarting` 状态后，`startTaskQueued` 由于某种原因无法完成（比如队列串行延迟很长），该任务会在 `restarting` 状态中"僵死"，没有任何定时器会检测或处理它。而 `vps-scheduler.js` 的上限统计却包含了 `restarting`，形成不一致：调度器认为这台 VPS 占用了一个槽位，但 health check 永远不会清除这个僵死的 `restarting` 任务。

**修复：**
```js
"SELECT * FROM tasks WHERE status IN ('running','stalled','source_retrying','target_lost','restarting')"
```

---

## Info（建议级）

### IN-01: 测试用例覆盖不完整——缺少 `getSetting` 返回非法值的测试

**文件：** `__tests__/vps-scheduler.test.js`

**问题：**
测试套件覆盖了正常路径和 DB 异常，但没有测试 `getSetting` 返回空字符串 `''`、`null`、非数字字符串（如 `'abc'`）时的行为。这些边界情况对应 WR-03 描述的 NaN 问题。

**修复：**
添加以下测试用例：
```js
test('getSetting 返回非数字时应 fallback 到 5', () => {
  db.getSetting.mockReturnValue('abc');
  db.__mockGet.mockReturnValue({ id: 1, name: 'VPS-A', running_count: 0 });
  const result = selectBestVps(1);
  // 应返回有效 VPS，而非 null
  expect(result).not.toBeNull();
});
```

---

### IN-02: `views/tasks.ejs` 中 `taskDisplayName` 存在 EJS 输出未转义的隐患

**文件：** `views/tasks.ejs:132`

**问题：**
```ejs
<td style="font-weight:500;"><%= taskDisplayName(t) %></td>
```

`<%= %>` 在 EJS 中会做 HTML 转义，此处是安全的。但在第 191 行的 `confirm` 对话框中：

```ejs
onsubmit="return confirm('确认删除任务「<%= taskDisplayName(t) || t.id %>」？')"
```

`taskDisplayName` 的结果直接插入到 HTML 属性内的 JavaScript 字符串中。若任务名称包含单引号 `'`，会导致 JavaScript 语法错误或 XSS。EJS 的 `<%= %>` 转义会把 `'` 转为 `&#x27;`，在 HTML 属性上下文中是安全的，但插入到 JS 字符串（单引号）时，浏览器在解析 HTML 属性值后再执行 JS 时 `&#x27;` 仍会还原为 `'`，**破坏 JS 字符串界定符**。

**修复：**
```ejs
onsubmit="return confirm('确认删除任务「' + <%= JSON.stringify(taskDisplayName(t) || String(t.id)) %> + '」？')"
```
或将任务 ID 和 confirm 文本移至 JS 函数中处理，避免在 HTML 属性中拼接字符串。

---

### IN-03: `task-detail.ejs` 直接输出 `ev.reason` 未做长度截断的 title 属性

**文件：** `views/task-detail.ejs:86`

**问题：**
```ejs
<td ... title="<%= ev.reason || '' %>"><%= ev.reason || '--' %></td>
```

`ev.reason` 来自 `task_events.reason` 数据库字段，`task-manager.js` 多处以 `scheduler:${scheduledVps.name}(${scheduledVps.id})` 或 `start_failed: ${e.message}` 格式写入。若错误消息极长（如 SSH 堆栈跟踪），`title` 属性会携带过长内容，在浏览器中虽不构成直接安全风险（EJS 已转义），但影响用户体验，且若 reason 内容包含用户控制的数据（如恶意 VPS 名称），`<%= %>` 转义后也是安全的——此处属于信息项，无直接安全问题。

**修复：**
在后端 `SELECT` 时截断 reason 字段，或在模板中限制 title 显示长度：
```js
// routes/tasks.js 中查询 recentEvents 时加 SUBSTR
SELECT id, from_status, to_status, SUBSTR(reason, 1, 200) as reason, created_at
FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 50
```

---

_审查时间：2026-05-09_
_审查员：Claude (gsd-code-reviewer)_
_审查深度：standard_
