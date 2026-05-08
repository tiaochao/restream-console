---
phase: "07"
plan: "03"
subsystem: "views + routes"
tags: ["ui", "ejs", "scheduler", "vps", "frontend"]
dependency_graph:
  requires: ["07-01", "07-02"]
  provides: ["VPS 自动调度用户可见 UI"]
  affects: ["views/tasks.ejs", "views/stream-keys.ejs", "views/task-detail.ejs", "routes/tasks.js"]
tech_stack:
  added: []
  patterns: ["EJS 条件块渲染", "Array.some() 检测事件历史"]
key_files:
  created: []
  modified:
    - views/tasks.ejs
    - views/stream-keys.ejs
    - views/task-detail.ejs
    - routes/tasks.js
decisions:
  - "stream-keys.ejs 两处默认 VPS 选项（编辑弹窗 + 新建弹窗）同步更新为相同文案，保持 UI 一致性"
  - "任务列表 VPS 列改用 EJS 条件块而非字符串拼接，避免 HTML 注入风险"
  - "schedulerAssigned 在路由层通过 Array.some() 计算，视图层只做展示，逻辑不进模板"
metrics:
  duration: "约 5 分钟"
  completed: "2026-05-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 4
---

# Phase 7 Plan 03: VPS 自动调度前端 UI Summary

**一句话总结：** 四处 EJS/路由改动完成 FEAT-01 用户可见层——新建任务默认自动调度、列表斜体标注未分配任务、推流码弹窗文案统一、详情页条件显示"（调度器分配）"小字。

## What Was Built

### views/tasks.ejs

两处精确修改：

1. **新建任务弹窗 VPS 下拉**（第223行）：第一选项由"— 选择 VPS —"改为"自动选择（负载最低）"，`value=""` 不变，POST 时提交空字符串触发调度器逻辑。

2. **任务列表 VPS 列**（第133行）：从 EJS 输出字符串拼接 HTML 改为 EJS 条件块——`vps_name` 有值时正常显示，为空时显示斜体"自动分配"文字，避免 HTML 注入。

### views/stream-keys.ejs

两处同步更新（编辑弹窗 + 新建弹窗的默认 VPS select）：原"-- 不绑定 --"文案改为"自动（调度器分配）"，`value=""` 不变，语义更准确。

### routes/tasks.js

详情路由（`GET /:id`）在 `res.render` 调用前新增一行：

```javascript
// [FEAT-01] 检测该任务是否曾由调度器分配（用于详情页标注）
const schedulerAssigned = recentEvents.some(ev => ev.reason && ev.reason.startsWith('scheduler:'));
```

并将 `schedulerAssigned` 传入 `task-detail` 模板。

### views/task-detail.ejs

基本信息 grid 的 VPS 行：原单行 `<%= task.vps_name || '--' %>` 改为多行结构，当 `schedulerAssigned && task.vps_name` 时在名称后追加 11px 小字"（调度器分配）"标注。

## Commits

| 任务 | Commit | 描述 |
|------|--------|------|
| Task 1: tasks.ejs | f10c385 | feat(07-03): 任务列表和新建弹窗 VPS 自动调度 UI |
| Task 2: stream-keys + task-detail + routes | 9de3a08 | feat(07-03): 推流码文案更新 + 任务详情调度器标注 |

## Verification Results

```
=== tasks.ejs ===
line 223: <option value="">自动选择（负载最低）</option>  ✓

=== stream-keys.ejs ===
line 143: <option value="">自动（调度器分配）</option>     ✓
line 216: <option value="">自动（调度器分配）</option>     ✓

=== routes/tasks.js ===
line 174: const schedulerAssigned = recentEvents.some(...)  ✓
line 182: schedulerAssigned,                                  ✓

=== task-detail.ejs ===
line 40: <% if (schedulerAssigned && task.vps_name) { %>   ✓

=== npm test ===
Test Suites: 3 passed, 3 total
Tests: 33 passed, 33 total  ✓
```

全部成功标准满足，无回归。

## Deviations from Plan

**1. [Rule 2 - 完整性] stream-keys.ejs 两处默认 VPS 选项同步更新**

- **发现于：** Task 2 执行时
- **问题：** 计划只提及 `id="edit-default-vps-id"` 的编辑弹窗，但 stream-keys.ejs 还有一处新建推流码弹窗（`name="default_vps_id"`）使用相同的"不绑定"文案
- **修复：** 两处均改为"自动（调度器分配）"，保持 UI 一致性
- **文件：** views/stream-keys.ejs（第143行 + 第216行）
- **Commit：** 9de3a08

## Threat Model Coverage

| Threat ID | 控制措施 | 已实现 |
|-----------|---------|--------|
| T-07-06 (XSS) | EJS `<%= %>` 自动 HTML 转义 reason 字段 | 是 |
| T-07-07 (Information Disclosure) | schedulerAssigned 仅在认证用户详情页展示 | 是 |

**额外安全改善：** 任务列表 VPS 列从字符串拼接 HTML 改为 EJS 条件块，消除潜在 HTML 注入路径（原来的 `|| '<span>...</span>'` 会将 HTML 字符串通过 `<%= %>` 输出，EJS 会转义，实际无漏洞；但新写法更清晰且语义正确）。

## Known Stubs

无。

## Threat Flags

无新的安全边界引入。

## Self-Check: PASSED

- views/tasks.ejs 包含"自动选择（负载最低）": FOUND
- views/tasks.ejs 包含"自动分配": FOUND
- views/stream-keys.ejs 包含"自动（调度器分配）" x2: FOUND
- views/task-detail.ejs 包含 schedulerAssigned: FOUND
- routes/tasks.js 包含 schedulerAssigned x2: FOUND
- Commit f10c385 存在: FOUND
- Commit 9de3a08 存在: FOUND
- npm test 全绿 (33/33): PASS
