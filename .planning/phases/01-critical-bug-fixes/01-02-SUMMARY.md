---
phase: 01-critical-bug-fixes
plan: 02
status: complete
---

## Summary

修复 BUG-02：startTaskQueued SSH 超时保护。

### 修改内容

**修改文件：** services/task-manager.js

1. 新增 `START_TASK_TIMEOUT_MS = 30 * 1000` 常量
2. 新增 `raceAbort(promise, signal)` 辅助函数（带事件监听器清理，防内存泄漏）
3. `startTaskQueued` 中 `startTask` 调用改为 `raceAbort(startTask(taskId, userId), AbortSignal.timeout(START_TASK_TIMEOUT_MS))`

### 技术说明

- `AbortSignal.timeout(ms)` — Node.js 17.3+ API，项目使用 Node 24，兼容
- 超时后 catch 块捕获错误，任务标记为 `error`，队列继续推进
- `startTask` 本身仍在后台运行直到 SSH 连接自然超时（readyTimeout: 15000）

### Self-Check

- [x] raceAbort 函数已定义（含监听器清理）
- [x] START_TASK_TIMEOUT_MS 常量已定义
- [x] startTaskQueued 使用 AbortSignal.timeout + raceAbort
- [x] 模块加载成功，startTaskQueued 类型为 function

## Self-Check: PASSED
