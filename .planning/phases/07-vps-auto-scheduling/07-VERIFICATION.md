---
phase: 07-vps-auto-scheduling
verified: 2026-05-09T08:00:00Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
human_verification:
  - test: "端到端流程：新建一个未指定 VPS 的任务，点击启动，在任务详情页确认 VPS 行显示被分配的 VPS 名称及"（调度器分配）"标注"
    expected: "任务详情页 VPS 字段显示具体 VPS 名称（非"--"），旁边有小字"（调度器分配）""
    why_human: "需要在运行中的应用环境中实际触发 selectBestVps 并查看渲染结果，无法静态验证"
  - test: "将所有 VPS 设为 offline，然后尝试启动一个 vps_id=NULL 的任务"
    expected: "任务启动失败，前端显示"无可用在线 VPS：所有节点均离线或已达任务上限，请在 VPS 管理页面检查连接状态"，系统不崩溃"
    why_human: "需要在运行环境中操控 VPS 在线状态并观察 UI 报错，无法静态验证"
---

# Phase 7: VPS 自动调度 Verification Report

**Phase Goal:** 创建任务时无需手动选择 VPS，系统自动分配负载最低的可用节点。
**Verified:** 2026-05-09T08:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | selectBestVps(userId) 返回在线且 running_count 最少的 VPS 对象 { id, name } | VERIFIED | vps-scheduler.js 第19-33行：LEFT JOIN + ORDER BY running_count ASC, v.id ASC；测试用例 1、2、5 均通过 |
| 2 | 无在线 VPS 时返回 null（不抛出异常） | VERIFIED | vps-scheduler.js 第35行：`return row ? { id: row.id, name: row.name } : null`；try/catch logError 后 return null；测试用例 3 通过 |
| 3 | 已达 max_tasks_per_vps 上限的 VPS 不出现在候选列表 | VERIFIED | vps-scheduler.js 第30行：`HAVING COUNT(t.id) < ?`；测试用例 4 通过 |
| 4 | 平局时按 vps.id 升序取第一个（确定性输出） | VERIFIED | vps-scheduler.js 第31行：`ORDER BY running_count ASC, v.id ASC`；测试用例 5 通过 |
| 5 | 只查询当前用户的 VPS（多用户隔离） | VERIFIED | vps-scheduler.js 第27行：`WHERE v.user_id = ?`；测试用例 7 验证 getSetting 传入正确 userId |
| 6 | startTask() 传入 vps_id=NULL 的 taskId 时，调用 selectBestVps() 动态填充 vps_id | VERIFIED | task-manager.js 第63-74行：`if (!task.vps_id)` 块内动态 require + 调用 selectBestVps |
| 7 | 调度成功后立即执行 UPDATE tasks SET vps_id=? WHERE id=? 写回 DB | VERIFIED | task-manager.js 第162-165行：`if (scheduledVps)` 块内 `db.prepare('UPDATE tasks SET vps_id=? WHERE id=?').run(...)` |
| 8 | 无可用 VPS 时抛出明确错误消息"无可用在线 VPS" | VERIFIED | task-manager.js 第69行：`throw new Error('无可用在线 VPS：所有节点均离线或已达任务上限...')` |
| 9 | 手动指定 vps_id 的任务完全不受影响，不调用调度器 | VERIFIED | task-manager.js 第64-74行：调度块被 `if (!task.vps_id)` 完全包裹；scheduledVps 哨兵变量确保 DB 写回只在调度路径执行 |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `services/vps-scheduler.js` | 调度核心函数 selectBestVps(userId) | VERIFIED | 文件存在，43行，实现完整；模块导出验证：`node -e "require('./services/vps-scheduler')"` 无报错 |
| `__tests__/vps-scheduler.test.js` | selectBestVps() 全分支单元测试，describe('selectBestVps') | VERIFIED | 文件存在，73行，包含 describe('selectBestVps')，7个测试用例全部通过 |
| `services/task-manager.js` | 修改后的 startTask()，含 selectBestVps 调用 | VERIFIED | 文件存在，363行，包含 selectBestVps 引用9处，scheduledVps 7处，调度逻辑完整 |
| `views/tasks.ejs` | 新建任务 VPS 下拉的"自动"选项 + 任务列表 VPS 列斜体显示 | VERIFIED | 包含"自动选择（负载最低）"（第223行）；包含"自动分配"斜体渲染（第134-138行） |
| `views/stream-keys.ejs` | 推流码默认 VPS 下拉的"自动"选项文案 | VERIFIED | 包含"自动（调度器分配）"两处（第143行、第216行），覆盖编辑弹窗和新建弹窗 |
| `views/task-detail.ejs` | 基本信息 VPS 行的调度器标注，含 schedulerAssigned | VERIFIED | 第40行：`<% if (schedulerAssigned && task.vps_name) { %>` 条件渲染"（调度器分配）"标注 |
| `routes/tasks.js` | 详情路由传入 schedulerAssigned 变量 | VERIFIED | 第174行定义，第182行传入 res.render；`node -e "require('./routes/tasks')"` 无报错 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| services/vps-scheduler.js | db.js | require('../db') | WIRED | 第2-3行双重 require，db.prepare 和 getSetting 均有调用 |
| __tests__/vps-scheduler.test.js | services/vps-scheduler.js | require('../services/vps-scheduler') | WIRED | 第16行 require，7个测试调用 selectBestVps，全部通过 |
| services/task-manager.js startTask() | services/vps-scheduler.js | require('./vps-scheduler').selectBestVps | WIRED | 第66行动态 require，第67行 selectBestVps(task.user_id) 调用 |
| services/task-manager.js startTask() | db tasks 表 | UPDATE tasks SET vps_id=? | WIRED | 第163行：db.prepare('UPDATE tasks SET vps_id=? WHERE id=?').run(scheduledVps.id, taskId) |
| views/task-detail.ejs | routes/tasks.js | schedulerAssigned 模板变量 | WIRED | 路由第174行计算，第182行传模板；视图第40行消费 |
| routes/tasks.js 详情路由 | task_events 表 | 查询 reason LIKE 'scheduler:%' | WIRED | 第174行：`recentEvents.some(ev => ev.reason && ev.reason.startsWith('scheduler:'))` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| services/vps-scheduler.js | row (VPS记录) | db.prepare(LEFT JOIN SQL).get(userId, maxPerVps) | 是，真实 SQLite 查询 | FLOWING |
| services/task-manager.js | scheduledVps | selectBestVps(task.user_id) 返回值 | 是，DB 查询结果 | FLOWING |
| routes/tasks.js | schedulerAssigned | recentEvents.some(ev => ev.reason.startsWith('scheduler:')) | 是，来自 task_events 表实际记录 | FLOWING |
| views/task-detail.ejs | schedulerAssigned | 路由层传入模板变量 | 是，模板变量非硬编码 | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| vps-scheduler 模块可加载 | `node -e "const s = require('./services/vps-scheduler'); console.log(typeof s.selectBestVps)"` | function | PASS |
| task-manager 模块可加载 | `node -e "const m = require('./services/task-manager'); console.log(typeof m.startTask)"` | function | PASS |
| routes/tasks 模块可加载 | `node -e "require('./routes/tasks')"` | OK (no error) | PASS |
| vps-scheduler 单元测试（7个） | `npx jest --testPathPattern=vps-scheduler --forceExit` | 7 passed, 7 total | PASS |
| 全套测试（33个） | `npx jest --forceExit` | 3 suites, 33 passed, 0 failed | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| FEAT-01 | 07-01, 07-02, 07-03 | VPS 自动调度：新建任务时自动选择负载最低的在线节点；"默认 VPS"可设为"自动" | SATISFIED | vps-scheduler.js 实现调度核心；task-manager.js 集成调度；UI 四处更新；全套测试通过 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| views/tasks.ejs | 32 | "未绑定"文字仍存在 | Info | 该"未绑定"在 `youtubeStatusCfg()` 函数内，指 YouTube 链接未绑定状态，与 VPS 列无关；VPS 列处的"未绑定"已正确替换为"自动分配" |

无阻塞性反模式。

### Human Verification Required

#### 1. 端到端调度分配流程

**Test:** 在运行中的应用中，新建一个转推任务，在"执行 VPS"下拉中保持默认（"自动选择（负载最低）"），保存后启动该任务。
**Expected:** 任务启动后，进入任务详情页，VPS 字段显示系统选择的具体 VPS 名称，旁边有 11px 小字"（调度器分配）"；任务事件日志中出现 `scheduler:VPS名(ID)` 格式的 reason 记录。
**Why human:** 需要真实的 SSH 连接 + 在线 VPS 环境，以及实际的数据库写回，静态代码分析无法覆盖完整端到端路径。

#### 2. 无可用 VPS 时的友好错误

**Test:** 在 VPS 管理页面将所有 VPS 设为 offline（或将 VPS 表中 status 手动改为 'offline'），然后尝试启动一个未绑定 VPS 的任务。
**Expected:** 任务启动失败，前端或日志中显示"无可用在线 VPS：所有节点均离线或已达任务上限，请在 VPS 管理页面检查连接状态"，系统不崩溃不挂起。
**Why human:** 需要操控运行时数据库状态并观察 UI/API 响应行为。

### Gaps Summary

无阻塞性 Gap。所有 9 个可验证真相均在代码中找到完整实现。两个需要人工确认的项目涉及运行时行为（VPS SSH 环境、数据库写回后 UI 渲染），无法通过静态分析或本地 node 命令代替。

---

_Verified: 2026-05-09T08:00:00Z_
_Verifier: Claude (gsd-verifier)_
