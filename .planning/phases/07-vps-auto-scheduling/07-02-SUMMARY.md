---
phase: "07"
plan: "02"
subsystem: "services/task-manager"
tags: ["scheduler", "vps", "auto-dispatch", "feat-01", "task-manager"]
dependency_graph:
  requires: ["07-01"]
  provides: ["startTask() 自动调度集成"]
  affects: ["services/task-manager.js", "db tasks.vps_id"]
tech_stack:
  added: []
  patterns: ["require() 内联动态导入 vps-scheduler", "scheduledVps 哨兵变量控制 DB 写回路径"]
key_files:
  created: []
  modified:
    - services/task-manager.js
decisions:
  - "使用 let scheduledVps = null 哨兵变量，确保手动指定 vps_id 的路径不触发 DB 写回（零副作用）"
  - "UPDATE tasks SET vps_id=? 在 return pid 之前执行，保证 checkHealth() 第 209 行的 !task.vps_id 守卫不会跳过监控"
  - "writeEvent reason 格式 scheduler:VPS名(ID) 与现有事件日志风格一致，便于排查调度记录"
metrics:
  duration: "约 5 分钟"
  completed: "2026-05-09"
  tasks_completed: 1
  tasks_total: 1
  files_created: 0
  files_modified: 1
---

# Phase 7 Plan 02: startTask() VPS 自动调度集成 Summary

**一句话总结：** 在 `startTask()` 的 vps_id 检查前插入调度块，NULL vps_id 任务通过 `selectBestVps()` 自动获得 VPS 分配，成功启动后写回 DB 并记录 task_events，全套 33 个测试全绿。

## What Was Built

### services/task-manager.js（修改）

在 `startTask()` 中精确插入两处修改：

**修改 1：调度块（约第 64-78 行）**

```javascript
// [FEAT-01] vps_id 为 NULL 时调用调度器动态分配
let scheduledVps = null;
if (!task.vps_id) {
  const { selectBestVps } = require('./vps-scheduler');
  scheduledVps = selectBestVps(task.user_id);
  if (!scheduledVps) {
    throw new Error('无可用在线 VPS：所有节点均离线或已达任务上限，请在 VPS 管理页面检查连接状态');
  }
  task.vps_id = scheduledVps.id;
  task.vid    = scheduledVps.id;
  console.log(`[调度器] 任务 ${taskId} 自动分配到 VPS: ${scheduledVps.name}(${scheduledVps.id})`);
}
```

**修改 2：成功启动后 DB 写回 + 事件记录（约第 162-164 行）**

```javascript
// [FEAT-01] 调度器分配后写回 vps_id（health check 依赖此字段，必须在 return 前完成）
if (scheduledVps) {
  db.prepare('UPDATE tasks SET vps_id=? WHERE id=?').run(scheduledVps.id, taskId);
  writeEvent(taskId, task.user_id, task.status, 'running', `scheduler:${scheduledVps.name}(${scheduledVps.id})`);
}
```

**原 `任务未绑定 VPS` 错误已移除**，替换为 `无可用在线 VPS：...` 友好提示。

## Commits

| 任务 | Commit | 类型 |
|------|--------|------|
| Task 1: startTask() 集成 VPS 自动调度 | e4a628d | feat |

## Verification Results

```
grep -c "scheduledVps" services/task-manager.js
  9（超过最低要求 4 次）

grep "任务未绑定 VPS" services/task-manager.js
  （无输出，旧错误消息已移除）

node -e "require('./services/task-manager'); console.log('OK')"
  模块加载 OK

npm test
  Test Suites: 3 passed, 3 total
  Tests: 33 passed, 33 total
```

## Deviations from Plan

无 — 计划执行完全按照 07-02-PLAN.md 中的 action 规范实施，两处精确修改均与计划一致。

## Threat Model Coverage

| Threat ID | 控制措施 | 已实现 |
|-----------|---------|--------|
| T-07-03 (Tampering) | DB 写回在 return 前完成（`UPDATE tasks SET vps_id=?`），不依赖内存值持久化 | 是 |
| T-07-04 (Denial of Service) | 调度器调用在 startTaskQueued 串行队列内，无并发竞态 | 是（设计层面，无需代码干预）|
| T-07-05 (Information Disclosure) | 错误消息仅说明"无可用 VPS"，不暴露具体 VPS 信息 | 是 |

## Known Stubs

无。

## Threat Flags

无新的安全边界。`selectBestVps` 为内部服务调用，返回值由 startTask 验证（null 检查）后使用。

## Self-Check: PASSED

- services/task-manager.js 存在: FOUND
- Commit e4a628d 存在: FOUND
- scheduledVps 出现 9 次（>= 4）: PASS
- 旧错误消息"任务未绑定 VPS"已移除: PASS
- 新错误消息"无可用在线 VPS"已插入: PASS
- npm test 全绿 (33/33): PASS
