# Plan 03-03 执行总结

## 修改文件

`services/task-manager.js`

## _notify 辅助函数

- **行 597–604**：`function _notify(task, type, message)` 定义

## Task 1：notifier 导入

- **行 8**：`const notifier = require('./notifier');`

## Task 2：task_stalled 通知（共 6 处）

| 行号 | 触发场景 |
|------|----------|
| 716  | ffmpeg 无流，不满足 auto_restart 条件时 stalled |
| 775  | YouTube RTMP 丢失，无 auto_restart，stalled |
| 779  | YouTube RTMP 丢失，stall_count < 2，stalled |
| 798  | 直播源不可用，stalled |
| 849  | RTMP 持续报错短期重试期间，stalled |
| 880  | stale/retryLoop，stall < retryThreshold，stalled |

## Task 3：task_restarting 通知（共 6 处）

| 行号 | 触发场景 |
|------|----------|
| 713  | ffmpeg 无流，newStallCount >= 1，auto_restart |
| 752  | target RTMP 断开，auto_restart |
| 772  | YouTube RTMP 丢失，auto_restart |
| 838  | RTMP 持续报错，auto_restart |
| 860  | 进程已死，auto_restart |
| 890  | stale/retryLoop，auto_restart |

## Task 4：task_error 通知（共 3 处）

| 行号 | 触发场景 |
|------|----------|
| 843  | RTMP 持续报错，无 auto_restart |
| 863  | 进程已死，无 auto_restart |
| 894  | stale/retryLoop，无 auto_restart |

## Task 4C：task_start_failed 通知（共 1 处）

| 行号 | 触发场景 |
|------|----------|
| 584  | startTaskQueued 的 catch 块，使用 `notifier.send(userId, ...)` 直接调用 |

## Task 5：task_recovered 通知（共 1 处）

| 行号 | 触发场景 |
|------|----------|
| 901  | mtime > 0 且之前有 stall 或异常状态，恢复正常运行 |

## grep 统计

| 通知类型 | 出现次数 |
|----------|----------|
| `task_stalled` | 6 |
| `task_restarting` | 6 |
| `task_error` | 3 |
| `task_start_failed` | 1 |
| `task_recovered` | 1 |

## 验证指令

请在项目根目录运行以下命令确认无报错：

```sh
node -e "require('./services/task-manager'); console.log('OK')"
node -e "const tm = require('./services/task-manager'); ['startTaskQueued','stopTask','checkHealth','startMonitor'].forEach(f => { if(typeof tm[f] !== 'function') throw new Error(f + ' missing'); }); console.log('ALL OK')"
```
