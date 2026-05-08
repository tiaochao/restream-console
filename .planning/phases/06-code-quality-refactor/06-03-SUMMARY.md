---
plan: 06-03
phase: 06-code-quality-refactor
status: complete
completed: 2026-05-08
commit: 4510bac
---

## Summary

创建 `services/task-ssh.js`，将 `task-manager.js` 中负责 SSH 下发和文件同步的三个函数提取到独立模块，从 task-manager.js 减少约 65 行。

## Key Files Created

- `services/task-ssh.js` — 导出 `syncDouyinHelper`, `ensureRemoteRuntime`, `syncAutoRecordingMediaFile`（81 行）

## Key Files Modified

- `services/task-manager.js` — 导入 task-ssh，移除三个 SSH 相关函数的本地定义

## Self-Check: PASSED

- `node -e "require('./services/task-ssh')"` — 无报错
- `node -e "require('./services/task-manager')"` — 无报错
- `grep -c "^async function syncAutoRecordingMediaFile" services/task-manager.js` — 0
- `npm test` — 26 passed
