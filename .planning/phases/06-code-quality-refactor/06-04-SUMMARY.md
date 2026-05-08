---
plan: 06-04
phase: 06-code-quality-refactor
status: complete
completed: 2026-05-09
commit: 13d76b9
---

## Summary

创建 `services/task-state.js`，将 `checkHealth` 函数中的状态机判断逻辑（~300 行）抽取为三个纯函数，`checkHealth` 精简为 55 行效果执行器。`task-manager.js` 总行数从 587 行降至 343 行（↓41%）。

## Key Files Created

- `services/task-state.js` — 导出 `buildHealthCheckCmd`, `parseHealthResult`, `evaluateHealth`（243 行，纯函数，无 DB/SSH 副作用）

## Key Files Modified

- `services/task-manager.js` — 导入 task-state，checkHealth 从 ~300 行精简为 55 行，移除未使用的 dqEsc 导入

## Self-Check: PASSED

- `node -e "require('./services/task-state')"` — 无报错
- `node -e "require('./services/task-manager')"` — 无报错
- `wc -l services/task-manager.js` — 343（≤350 ✓）
- `grep -c "^function buildCommand\|^function normalizeRecordLabel\|^async function syncDouyinHelper\|^async function syncAutoRecordingMediaFile" services/task-manager.js` — 0
- `npm test` — 26/26 passed ✓
