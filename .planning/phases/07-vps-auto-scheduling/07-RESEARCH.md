# Phase 7: 新功能 — VPS 自动调度 - Research

**Researched:** 2026-05-09
**Domain:** Node.js / SQLite / Express / EJS 前端表单
**Confidence:** HIGH（基于直接代码库分析，无外部依赖查找）

---

## Summary

Phase 7 在已有完整 VPS 在线状态基础设施（`vps.status` 字段、`checkAllVpsStatus()` 定期刷新）上，新增一个调度器服务，让任务启动时自动分配负载最低的节点。

核心实现分四段：
1. `services/vps-scheduler.js`：纯查询逻辑，基于 DB 中现有数据选出最优 VPS ID
2. `stream_keys.default_vps_id` 语义扩展：NULL 值从"未绑定"复用为"自动调度"，**无需加新字段**
3. `startTask()` 入口修改：当 `task.vps_id` 为 NULL 时调用调度器填充
4. 任务列表/详情 UI：显示自动分配的 VPS 名称，详情页事件记录来源标注

关键约束：`vps.status = 'online'` 已在 DB 中持续更新（每 2 分钟），可直接作为在线判断依据。CPU/内存信息只在按需点击"Stats"时拉取并未存入 DB，因此负载指标只能使用**当前运行任务数**（可即时从 `tasks` 表查询），这是最可靠且零额外 IO 的方案。

**Primary recommendation:** NULL 语义复用（无需加字段），调度器仅用 `tasks` 表的 running 计数选 VPS，错误时抛明确消息"无可用 VPS"。

---

## 项目约束（来自 CLAUDE.md）

| 指令 | 影响范围 |
|------|---------|
| 技术栈：Node.js / Express / SQLite / EJS | 调度器用纯 Node.js，无外部依赖 |
| FFmpeg 命令兼容 Ubuntu 20.04 / FFmpeg 4.2.x | Phase 7 不涉及 FFmpeg 参数 |
| 不破坏已有功能 | `startTask()` 改动必须对手动指定 VPS 的路径零影响 |
| `node:sqlite` 实验性 API，要求 Node 22.5+ | 调度器直接使用现有 `db` 模块 |

---

## Architectural Responsibility Map

| 能力 | 主层 | 次层 | 说明 |
|------|------|------|------|
| 调度算法（选最优 VPS） | 服务层（`vps-scheduler.js`） | — | 纯 DB 查询，无 SSH |
| `stream_keys.default_vps_id = NULL` 语义 | 路由层（`routes/tasks.js`） | DB schema | 复用 NULL 即可，无需迁移 |
| `startTask()` 调度入口 | 服务层（`task-manager.js`） | — | 仅在 `vps_id` 为 NULL 时调用 |
| 任务列表 VPS 列显示 | 前端视图（`views/tasks.ejs`） | — | `vps_name` 已由 JOIN 提供，只需显示 |
| 详情页"由调度器分配"标注 | 前端视图（`views/task-detail.ejs`） | DB `task_events.reason` | 记录调度 reason，渲染时判断 |
| 新建任务弹窗"自动"选项 | 前端视图（`views/tasks.ejs`） | 路由层 | select 新增 `<option value="">自动</option>` |
| 推流码"默认 VPS"自动选项 | 前端视图（`views/stream-keys.ejs`） | 路由层 | select 新增"自动"选项，值为空字符串 |

---

<phase_requirements>
## Phase Requirements

| ID | 描述 | 研究支撑 |
|----|------|---------|
| FEAT-01 | 新建任务时若未指定 VPS，自动选择负载最低的在线节点 | `vps.status` 字段已维护；`tasks` 表可查运行数；`startTask()` 已有 `vps_id` 入参检查 |
</phase_requirements>

---

## Standard Stack

### Core（全部已在项目中存在）

| 模块 | 版本/来源 | 用途 |
|------|---------|------|
| `node:sqlite` (DatabaseSync) | Node 22.5+ 内置 | 调度器查询 VPS 状态与任务数 |
| `services/task-manager.js` | 项目内 | `startTask()` 入口修改点 |
| `db.js` | 项目内 | 导出 `db` 实例，调度器直接 require |
| `utils/log-error.js` | 项目内（Phase 5 引入）| 调度器日志记录 |

### 无需新增外部依赖

---

## 关键代码路径发现

### 1. DB Schema — VPS 表

```
vps (
  id, user_id, name, host, port, username, auth_type,
  password (加密), private_key (加密),
  status TEXT DEFAULT 'unknown',   -- 'online' | 'offline' | 'unknown'
  last_check TEXT,
  created_at TEXT
)
```
`status` 字段由 `checkAllVpsStatus()` 每 2 分钟刷新，启动后 3 秒立即执行一次。
[VERIFIED: db.js 第 25-38 行]

### 2. DB Schema — tasks 表（与调度相关字段）

```
tasks (
  id, user_id,
  vps_id INTEGER REFERENCES vps(id) ON DELETE SET NULL,   -- NULL = 自动分配（复用语义）
  status TEXT DEFAULT 'idle',
  ...
)
```
`vps_id` 删除 VPS 时已设为 NULL（`ON DELETE SET NULL`），因此 NULL 值在 DB 层已有合法语义。
[VERIFIED: db.js 第 40-60 行]

### 3. DB Schema — stream_keys 表（默认 VPS 字段）

```
stream_keys (
  id, user_id, ...,
  default_vps_id INTEGER REFERENCES vps(id) ON DELETE SET NULL   -- 迁移字段，Phase 1 前已加
)
```
`default_vps_id = NULL` 当前语义为"不绑定"，Phase 7 将其扩展为"自动调度"。
[VERIFIED: db.js ensureColumn 第 223 行]

### 4. startTask() 当前 vps_id 解析逻辑

```javascript
// routes/tasks.js POST / 处理（第 184 行）
const vps_id = req.body.vps_id || findDefaultVpsForStreamKey(req.session.userId, rtmp_url, stream_key);

// findDefaultVpsForStreamKey（第 131-137 行）
function findDefaultVpsForStreamKey(userId, rtmpUrl, streamKey) {
  return db.prepare(`
    SELECT default_vps_id FROM stream_keys
    WHERE user_id=? AND rtmp_url=? AND stream_key=? AND default_vps_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(userId, rtmpUrl, streamKey)?.default_vps_id || null;
}
```

**关键发现：** 当 `vps_id` 为 NULL 时，任务被插入 DB 时 `vps_id = NULL`。`startTask()` 检查到 `!task.vps_id` 即抛出"任务未绑定 VPS"错误（第 62 行）。Phase 7 需要在这个检查之前插入调度逻辑。
[VERIFIED: task-manager.js 第 54-63 行, routes/tasks.js 第 184-210 行]

### 5. VPS "在线" 定义

```javascript
// task-manager.js checkAllVpsStatus()
const ok = await sshService.testConnection(vps);
db.prepare("UPDATE vps SET status='online', last_check=...").run(vps.id);
// 失败时 status='offline'
```

`status = 'online'` 是唯一在线判断依据。没有 CPU/内存等"健康检测数据"持久化到 DB — `routes/vps.js` 的 `/stats` 接口只在前端点击时临时 SSH 查询，不写 DB。
[VERIFIED: task-manager.js 第 264-278 行, routes/vps.js 第 218-246 行]

### 6. 任务列表 VPS 名称已由 JOIN 提供

```javascript
// routes/tasks.js getTaskRows()
return db.prepare(`
  SELECT t.*, v.name as vps_name, ...
  FROM tasks t
  LEFT JOIN vps v ON t.vps_id = v.id
  WHERE t.user_id = ?
`).all(userId);
```

当 `vps_id = NULL` 时，`vps_name` 为 NULL。调度器分配后任务的 `vps_id` 会在 `startTask()` 中被写入，列表自然显示正确 VPS 名称。
[VERIFIED: routes/tasks.js 第 52-63 行]

### 7. 任务详情页事件记录（task_events）

```javascript
// task_events 表字段
id, task_id, user_id, from_status, to_status TEXT NOT NULL, reason TEXT, created_at

// writeEvent() 已在 startTaskQueued() 中调用
writeEvent(taskId, userId, null, 'error', `start_failed: ${e.message}`);
```

`reason` 字段可写入"由调度器分配: VPS名称(ID)"，任务详情页 `recentEvents` 已渲染 `reason` 列。
[VERIFIED: db.js 第 156-165, 289-296 行, views/task-detail.ejs 第 64-82 行]

### 8. 前端 VPS 选择下拉框

**新建任务弹窗（tasks.ejs 第 216-222 行）：**
```html
<select name="vps_id" id="task-vps-select" onchange="loadMediaFiles(this.value)" class="form-select">
  <option value="">— 选择 VPS —</option>
  <% vpsList.forEach(function(v) { %>
    <option value="<%= v.id %>"><%= v.name %></option>
  <% }); %>
</select>
```
需要在列表顶部新增 `<option value="">自动选择（负载最低）</option>`，value="" 即 NULL，与当前"未选择"完全一致，POST 行为不变。

**推流码编辑弹窗（stream-keys.ejs 第 142-147 行）：**
```html
<select id="edit-default-vps-id" class="form-select">
  <option value="">-- 不绑定 --</option>
  ...
</select>
```
需将"不绑定"改为"自动（不绑定）"并新增语义说明，或直接将 label 改为"自动调度"。

### 9. 推流码 applyStreamKey() JS 函数（tasks.ejs 第 427-443 行）

```javascript
function applyStreamKey(skId) {
  const vpsId = opt.dataset.vps || '';
  const vpsSelect = document.getElementById('task-vps-select');
  if (vpsId && vpsSelect && vpsSelect.querySelector('option[value="' + vpsId + '"]')) {
    vpsSelect.value = String(vpsId);
    loadMediaFiles(String(vpsId));
  }
```

当推流码的 `default_vps_id = NULL`（自动）时，`opt.dataset.vps = ''`，条件 `if (vpsId && ...)` 为 false，不会修改 VPS 下拉。这正是期望的行为 — 自动调度时用户可手动选 VPS 覆盖，否则保持空值（自动）。**无需修改此函数。**

---

## Architecture Patterns

### 调度器数据流

```
[用户新建任务] → [routes/tasks.js POST /]
    │
    ├─ vps_id 有值 → 正常路径（不变）
    │
    └─ vps_id = NULL → 任务写入 DB（vps_id=NULL）
           │
           [POST /:id/start 或 startTaskQueued()]
           │
           [task-manager.js startTask()]
           │
           ├─ task.vps_id 非空 → 正常路径（不变）
           │
           └─ task.vps_id 为 NULL
                  │
                  [vps-scheduler.js selectBestVps(userId)]
                  │  SELECT vps WHERE status='online'
                  │  COUNT running tasks per vps
                  │  返回 task_count 最小的 vps.id
                  │
                  ├─ 无在线 VPS → throw Error('无可用在线 VPS')
                  │
                  └─ 分配成功 → task.vps_id = 返回的 ID
                         │
                         继续 startTask() 正常流程
                         + writeEvent(reason='scheduler:VPS名(ID)')
```

### 推荐项目结构（新增文件）

```
services/
└── vps-scheduler.js        # 新增：负载最低 VPS 选择器
```

---

## 关键实现模式

### Pattern 1: vps-scheduler.js 核心查询

```javascript
// Source: 基于项目现有 db.js 和 task-manager.js 分析 [ASSUMED 具体实现]
const db = require('../db');
const { logError } = require('../utils/log-error');

/**
 * 选出负载最低的在线 VPS
 * @param {number} userId - 用户 ID，只选该用户的 VPS
 * @returns {object|null} { id, name } 或 null（无在线 VPS）
 */
function selectBestVps(userId) {
  const rows = db.prepare(`
    SELECT v.id, v.name,
      COUNT(t.id) as running_count
    FROM vps v
    LEFT JOIN tasks t
      ON t.vps_id = v.id
     AND t.user_id = v.user_id
     AND t.status IN ('running', 'source_retrying', 'target_lost', 'stalled', 'restarting')
    WHERE v.user_id = ?
      AND v.status = 'online'
    GROUP BY v.id
    ORDER BY running_count ASC, v.id ASC
    LIMIT 1
  `).get(userId);
  return rows || null;
}

module.exports = { selectBestVps };
```

**设计说明：**
- `status IN ('running', 'source_retrying', ...)` — 与 `checkHealth()` 监控口径一致（task-manager.js 第 295 行），计入所有"活跃"任务
- `ORDER BY running_count ASC, v.id ASC` — 平局时按 ID 升序（确定性）
- 只查当前用户的 VPS（`v.user_id = ?`），符合多用户隔离设计

### Pattern 2: startTask() 修改点

```javascript
// task-manager.js startTask() 修改（仅新增 ~10 行）
async function startTask(taskId, userId = null) {
  // ... 现有代码：查询 task ...

  if (!task) throw new Error('任务不存在');

  // [新增] 若 vps_id 为 NULL，调用调度器动态分配
  let scheduledVps = null;
  if (!task.vps_id) {
    const { selectBestVps } = require('./vps-scheduler');
    scheduledVps = selectBestVps(task.user_id);
    if (!scheduledVps) throw new Error('无可用在线 VPS：所有节点均离线，请先在 VPS 管理页面测试连接');
    task.vps_id = scheduledVps.id;
    task.vid = scheduledVps.id;
    console.log(`[调度器] 任务 ${taskId} 自动分配到 VPS: ${scheduledVps.name}(${scheduledVps.id})`);
  }

  if (task.status === 'running') throw new Error('任务已在运行');
  // ... 其余现有代码不变 ...

  // [新增] 启动成功后，若是自动分配则更新 DB 并写入事件
  if (scheduledVps) {
    db.prepare('UPDATE tasks SET vps_id=? WHERE id=?').run(scheduledVps.id, taskId);
    writeEvent(taskId, task.user_id, null, task.status, `scheduler:${scheduledVps.name}(${scheduledVps.id})`);
  }

  return pid;
}
```

**注意：** `startTask()` 中的 `vps_id` 检查（`if (!task.vps_id) throw new Error('任务未绑定 VPS')`）在第 62 行，必须将调度逻辑插在这行之前，然后删除/调整该检查。

### Pattern 3: 任务列表 VPS 显示（tasks.ejs）

任务列表已有 `<td><%= t.vps_name || '<span ...>未绑定</span>' %></td>`（第 133 行）。

调度器分配后任务 `vps_id` 已写入 DB，`getTaskRows()` 的 JOIN 会自动取到 `vps_name`。**列表无需修改。**

若任务还未启动（`vps_id = NULL`），显示特殊文本"待自动分配"：通过在任务 INSERT 时写入 `notes` 字段或在模板中判断 `vps_id = NULL && status != 'idle'` 决定显示内容。推荐方案：在 tasks.ejs 的 VPS 列判断：

```html
<td>
  <% if (t.vps_name) { %>
    <%= t.vps_name %>
  <% } else if (!t.vps_id) { %>
    <span style="color:var(--text-2);font-style:italic;">自动分配</span>
  <% } else { %>
    <span style="color:var(--text-2)">未绑定</span>
  <% } %>
</td>
```

### Pattern 4: 任务详情页"由调度器分配"标注（task-detail.ejs）

`task_events.reason` 格式约定：`scheduler:VPS名(ID)`

在详情页的事件历史表，`reason` 列已直接渲染，标注自然可见。

另在"基本信息"块补一行说明：
```html
<% if (task.vps_name && schedulerAssigned) { %>
  <span style="color:var(--text-2);">VPS（调度器分配）</span>
  <span><%= task.vps_name %></span>
<% } %>
```
`schedulerAssigned` 通过查询 `task_events` 中 `reason LIKE 'scheduler:%'` 得到，在路由层传入视图。

---

## Don't Hand-Roll

| 问题 | 不要自建 | 使用 | 原因 |
|------|---------|------|------|
| VPS 在线状态判断 | 重新 SSH ping | `vps.status = 'online'` 字段 | 已有定期刷新机制，额外 ping 增加延迟 |
| 任务数统计 | 远端 SSH 进程计数 | `tasks` 表 `COUNT(*)` | DB 已有准确记录，无需 SSH |
| 日志记录 | 自定义 console | `logError()` + `writeEvent()` | Phase 5 已建立统一基础设施 |
| 调度事件记录 | 新建 scheduler_log 表 | `task_events.reason` 字段 | 复用现有事件表，避免 schema 增殖 |

---

## Common Pitfalls

### Pitfall 1: max_tasks_per_vps 上限未纳入调度

**出错场景：** 调度器选出了运行任务数最少的 VPS，但该 VPS 已达到 `max_tasks_per_vps` 上限（默认 5），导致 `startTask()` 后续仍抛出"该 VPS 已有 N 个任务运行，上限 M 个"。

**根因：** 调度器和 `startTask()` 中的上限检查是两个独立逻辑。

**避免方式：** 在调度器 SQL 中加 HAVING 过滤：
```sql
HAVING COUNT(t.id) < (
  SELECT CAST(value AS INTEGER) FROM settings
  WHERE user_id = v.user_id AND key = 'max_tasks_per_vps'
)
```
或在调度器返回前做 JS 层过滤（更简单，读一次 `getSetting`）。

**推荐：** 在 `selectBestVps()` 内读取 `max_tasks_per_vps` 设置并过滤掉已满 VPS，这样错误信息也更精准（"所有 VPS 均已达上限" vs "无在线 VPS"）。

### Pitfall 2: 调度后未更新 DB 中的 vps_id

**出错场景：** 调度器在内存中给 `task.vps_id` 赋值，但忘记 `UPDATE tasks SET vps_id=?`，导致任务成功启动但 DB 仍记录 `vps_id=NULL`。健康检测轮询时 `task.vps_id = NULL` 导致 `checkHealth()` 直接 return（第 208 行：`if (!task.remote_pid || !task.vps_id) return;`）。

**结果：** 任务在运行但完全脱离健康监控，既不会被检测到掉线，也不会自动重启。

**避免方式：** `startTask()` 成功后立即执行 `UPDATE tasks SET vps_id=? WHERE id=?`，必须在返回 PID 之前完成。

### Pitfall 3: 调度竞态（多任务同时启动）

**出错场景：** 批量启动 3 个任务，全部 `vps_id=NULL`，`selectBestVps()` 三次均返回同一个 VPS（因为三次查询时 tasks 表尚未更新）。

**根因：** `startTaskQueued()` 是串行队列，一次只处理一个任务的 `startTask()`，因此实际上不存在真正并发。`startQueue` 确保串行执行，调度结果写入 DB 后下一个任务才开始选择。

**验证：** `startTaskQueued()` 第 152-173 行，每个任务都等待前一个 `then()` 完成才执行。只要 DB 写入在 `startTask()` 内同步完成，不存在竞态。

### Pitfall 4: status='unknown' VPS 被错误纳入候选

**出错场景：** VPS 刚添加（`status='unknown'`）或服务刚启动（首次 ping 未完成），调度器将其纳入候选，导致分配到实际可能离线的节点。

**避免方式：** `WHERE v.status = 'online'` — 严格只选 online，unknown 排除在外。这意味着系统启动后 3 秒内（首次 ping 完成前）可能无法自动调度，这是可接受的边界情况。

### Pitfall 5: startTask() 的 task 对象修改不影响 DB

**出错场景：** `task.vps_id = scheduledVps.id` 只修改了内存中的对象，DB 行仍是 NULL。后续代码使用 `task.vps_id`（内存值）正常执行，但 `checkHealth()` 从 DB 重新读取任务时取到 NULL，导致健康检测失效（见 Pitfall 2）。

**避免方式：** 明确分离两步：①用内存值完成 `startTask()` 执行，②成功后 UPDATE DB。

---

## 代码路径：startTask() 修改详解

```
task-manager.js startTask() 当前执行顺序：

第54行  SELECT task + VPS
第61行  if (!task)        → throw '任务不存在'
第62行  if (!task.vps_id) → throw '任务未绑定 VPS'  ← 调度逻辑插在此之前
第63行  if (running)      → throw '任务已在运行'
第66行  检查 max_tasks_per_vps
第75-132行 平台直播检测（douyin/bilibili/kuaishou）
第134行 buildCommand()
第135行 sshService.exec() → 启动进程
第136行 读取 PID
第141行 UPDATE tasks SET status='running', remote_pid=?, ...
第148行 return pid
```

**修改点：** 在第 62 行之前，当 `task.vps_id` 为 NULL 时调用调度器，赋值后继续。第 62 行改为只在调度器也找不到 VPS 时才会到达此处（或直接删掉原来那行，用调度器的错误替代）。

成功启动后（第 141 行 UPDATE 完成后），追加：
```javascript
if (scheduledVps) {
  db.prepare('UPDATE tasks SET vps_id=? WHERE id=?').run(scheduledVps.id, taskId);
  writeEvent(taskId, task.user_id, task.status, 'running', `scheduler:${scheduledVps.name}(${scheduledVps.id})`);
}
```

---

## Runtime State Inventory

> Phase 7 是纯新功能，不涉及重命名/迁移，跳过此节。

---

## Environment Availability

Phase 7 无新外部依赖，所有能力来自已有代码库：
- Node.js 22.5+: 已在 STATE.md 确认项目运行环境满足
- SQLite (`node:sqlite`): 项目核心依赖，已验证
- 无需额外安装

---

## Validation Architecture

### Test Framework

| 属性 | 值 |
|------|---|
| Framework | Jest（Phase 5 引入） |
| Config file | `package.json` `"jest"` 字段 |
| Quick run command | `npm test -- --testPathPattern=vps-scheduler` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | 行为 | 测试类型 | 自动化命令 | 文件存在？ |
|--------|------|---------|-----------|----------|
| FEAT-01 | selectBestVps() 返回 running 最少的在线 VPS | 单元 | `npm test -- --testPathPattern=vps-scheduler` | 需要在 Wave 0 创建 |
| FEAT-01 | 无在线 VPS 时返回 null | 单元 | 同上 | 同上 |
| FEAT-01 | 已满的 VPS 不被选中（max_tasks_per_vps） | 单元 | 同上 | 同上 |
| FEAT-01 | startTask() 传入 NULL vps_id 时自动分配并写入 DB | 集成 | `npm test -- --testPathPattern=task-manager` | 现有文件扩展 |
| FEAT-01 | 手动指定 vps_id 时调度器不介入 | 单元 | 同上 | 同上 |

### Sampling Rate
- **每次任务提交：** `npm test -- --testPathPattern=vps-scheduler`
- **每次 wave merge：** `npm test`
- **Phase gate：** `npm test` 全绿后 `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/vps-scheduler.test.js` — 覆盖 selectBestVps() 全部分支
- [ ] `tests/task-manager.test.js` 扩展 — 补充自动分配场景的 startTask() 测试

---

## Open Questions

1. **`stream_keys.default_vps_id = NULL` 的 UI 语义**
   - 当前：value="" 显示"-- 不绑定 --"，选择后任务不自动绑定 VPS
   - Phase 7 后：value="" 语义变为"自动调度"
   - 旧数据中 `default_vps_id = NULL` 的推流码行为一致（都是自动），无兼容性问题
   - **建议：** 将"-- 不绑定 --"改为"自动（调度器分配）"，文案说明区别

2. **调度失败时是否阻止任务创建**
   - 当前方案：任务可以在 `vps_id=NULL` 状态下创建，启动时才报错
   - 替代方案：创建时就调度，失败则拒绝创建
   - **建议：** 保持延迟调度（启动时才分配），允许用户先创建任务再确保 VPS 在线

3. **`max_tasks_per_vps` 在调度器中的处理**
   - 当前 `getSetting` 需要 userId 参数
   - 调度器 SQL 或 JS 层均可读取，JS 层更简单
   - **建议：** JS 层：`const max = parseInt(getSetting('max_tasks_per_vps', userId) || '5')`，过滤 running_count >= max 的 VPS

---

## Security Domain

| ASVS 类别 | 适用 | 控制措施 |
|-----------|------|---------|
| V4 访问控制 | 是 | 调度器只查 `user_id = ?` 的 VPS，不能跨用户分配 |
| V5 输入验证 | 否 | 调度器无外部输入，完全基于 DB 查询 |
| V6 加密 | 否 | 不涉及新敏感字段 |

---

## Assumptions Log

| # | 声明 | 所在章节 | 错误风险 |
|---|------|---------|---------|
| A1 | CPU/内存数据不持久化到 DB，负载指标只用任务计数 | Standard Stack | 若未来 DB 中新增了 vps_health 表则可扩展指标，但当前分析正确 |
| A2 | `startTaskQueued()` 串行队列消除了调度竞态 | Common Pitfalls | 已通过代码分析验证，低风险 |
| A3 | task_events.reason 字段适合存储"scheduler:VPS名(ID)"格式 | 实现模式 | 字段无长度限制（TEXT），格式为内部约定 |

---

## Sources

### Primary (HIGH confidence)
- `f:\008 工具库\YouTube直播转推\restream-console\db.js` — schema、字段验证、VPS/tasks 表结构
- `f:\008 工具库\YouTube直播转推\restream-console\services\task-manager.js` — startTask() 完整逻辑
- `f:\008 工具库\YouTube直播转推\restream-console\routes\tasks.js` — vps_id 解析链、任务创建路由
- `f:\008 工具库\YouTube直播转推\restream-console\routes\vps.js` — VPS stats 接口（确认未写 DB）
- `f:\008 工具库\YouTube直播转推\restream-console\views\tasks.ejs` — VPS 下拉、任务列表 VPS 列渲染
- `f:\008 工具库\YouTube直播转推\restream-console\views\stream-keys.ejs` — 推流码"默认 VPS"字段 UI
- `f:\008 工具库\YouTube直播转推\restream-console\views\task-detail.ejs` — 详情页结构、事件历史渲染

### Secondary (MEDIUM confidence)
- `.planning/codebase/CONCERNS.md` — 已知问题清单，确认调度竞态分析（CONCERNS #21 印证）

---

## Metadata

**Confidence breakdown:**
- 调度算法设计: HIGH — 完全基于 DB 查询，已验证字段存在
- startTask() 修改点定位: HIGH — 逐行分析代码路径
- 前端 UI 改动范围: HIGH — 直接读取 EJS 模板，定位到具体行号
- Jest 测试设计: MEDIUM — 测试框架已存在，但测试文件尚未创建

**Research date:** 2026-05-09
**Valid until:** 2026-06-08（项目内部，schema 稳定，有效期 30 天）
