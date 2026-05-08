---
plan: 06-01
phase: 06-code-quality-refactor
status: complete
completed: 2026-05-08
commit: d47eed3
---

## Summary

创建 `utils/shell-escape.js`，统一管理 `dqEsc` 和 `shSingleQuote` 两个 shell 转义工具函数，消除 `live-monitor.js` 中的重复定义。

## Key Files Created

- `utils/shell-escape.js` — 导出 `dqEsc(s)` 和 `shSingleQuote(s)`

## Key Files Modified

- `services/live-monitor.js` — 移除本地定义，改用 `require('../utils/shell-escape')`

## Self-Check: PASSED

- `node -e "require('./utils/shell-escape')"` — 无报错
- `node -e "require('./services/live-monitor')"` — 无报错
- `grep -c "require.*shell-escape" services/live-monitor.js` — 1
- `grep -c "^function dqEsc" services/live-monitor.js` — 0
