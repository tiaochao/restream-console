---
phase: "07"
plan: "01"
subsystem: "services/vps-scheduler"
tags: ["scheduler", "vps", "load-balancing", "tdd", "unit-test"]
dependency_graph:
  requires: []
  provides: ["selectBestVps(userId)"]
  affects: ["services/task-manager.js"]
tech_stack:
  added: []
  patterns: ["SQLite LEFT JOIN + HAVING 过滤", "jest.mock() 模块级 mock"]
key_files:
  created:
    - services/vps-scheduler.js
    - __tests__/vps-scheduler.test.js
  modified: []
decisions:
  - "HAVING COUNT(t.id) < maxPerVps 在 SQL 层直接过滤已满 VPS，避免调度成功后 startTask() 再报上限错误"
  - "try/catch 内 logError 后返回 null，调度失败不向上传播异常，由调用方决定如何处理"
  - "使用 jest.mock('../db') 整体 mock DB 模块，避免测试依赖真实 SQLite 文件"
metrics:
  duration: "约 5 分钟"
  completed: "2026-05-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 7 Plan 01: VPS 调度服务核心模块 Summary

**一句话总结：** 创建 `selectBestVps(userId)` 函数，通过 SQLite HAVING 过滤在线且未达上限的 VPS，返回运行任务数最少的节点；配套 7 个 Jest 单元测试覆盖全分支，全套 33 个测试通过。

## What Was Built

### services/vps-scheduler.js

VPS 自动调度服务核心模块，暴露 `selectBestVps(userId)` 函数：

- 读取 `max_tasks_per_vps` 用户设置（默认 5）
- 执行 LEFT JOIN 查询统计每个在线 VPS 的活跃任务数
- `HAVING COUNT(t.id) < maxPerVps` 直接在 SQL 层排除已满 VPS
- `ORDER BY running_count ASC, v.id ASC` 确保平局时确定性输出
- `WHERE v.user_id = ?` 保证多用户数据隔离
- `try/catch` + `logError` 防止 DB 异常崩溃调用方
- 返回 `{ id, name }` 或 `null`（无可用 VPS）

### __tests__/vps-scheduler.test.js

7 个单元测试覆盖全部分支：

| 测试 | 场景 |
|------|------|
| 1 | 有一个在线 VPS 且无运行任务时返回该 VPS |
| 2 | 有两个在线 VPS 返回任务数更少的那个 |
| 3 | 无在线 VPS 时返回 null |
| 4 | VPS 已达 max_tasks_per_vps 上限时返回 null |
| 5 | 两个 VPS 任务数相同时返回 id 较小的 |
| 6 | DB 查询抛出异常时返回 null 不崩溃 |
| 7 | 调用 getSetting 时传入正确的 userId |

## Commits

| 任务 | Commit | 类型 |
|------|--------|------|
| Task 1: 创建 vps-scheduler.js | f1c84bf | feat |
| Task 2: 编写单元测试 | ceef302 | test |

## Verification Results

```
npm test -- --testPathPattern=vps-scheduler --forceExit
  Tests: 7 passed, 7 total

npm test
  Test Suites: 3 passed, 3 total
  Tests: 33 passed, 33 total
```

全套测试（vps-scheduler + task-manager + youtube-monitor）全部通过，无回归。

## Deviations from Plan

无 — 计划执行完全按照 07-01-PLAN.md 中的 action 规范实施。

## Threat Model Coverage

| Threat ID | 控制措施 | 已实现 |
|-----------|---------|--------|
| T-07-01 (Information Disclosure) | `WHERE v.user_id = ?` 用户隔离 | 是 |
| T-07-02 (Denial of Service) | try/catch 防止异常传播 | 是 |

## Known Stubs

无。

## Threat Flags

无新的安全边界。

## Self-Check: PASSED

- services/vps-scheduler.js 存在: FOUND
- __tests__/vps-scheduler.test.js 存在: FOUND
- Commit f1c84bf 存在: FOUND
- Commit ceef302 存在: FOUND
- npm test 全绿 (33/33): PASS
