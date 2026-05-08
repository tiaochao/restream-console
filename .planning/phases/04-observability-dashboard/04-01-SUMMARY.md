# 04-01 SUMMARY: task_events 事件溯源表

## 执行结果

所有步骤已完成，无错误。

## db.js 变更

### task_events 表
- 行号范围：第 156–165 行（SQL 定义）
- 包含字段：id, task_id, user_id, from_status, to_status, reason, created_at
- 包含索引：idx_task_events_task ON task_events(task_id, created_at DESC)

### writeEvent 函数
- 定义行号：第 289 行
- 导出行号：第 318 行（module.exports.writeEvent = writeEvent）

## services/task-manager.js 变更

### 导入
- 第 9 行：`const { writeEvent } = require('../db');`

### _record 辅助函数
- 定义行号：第 608–610 行

### _record 调用总数
- 调用总计：**16 次**（不含函数定义行）
- 分布如下：
  - `stream_stalled`（→ stalled）：6 处
  - `auto_restart`（→ restarting）：5 处
  - `process_died`（→ error）：2 处
  - `no_log_update`（→ error）：1 处
  - `recovered`（→ running）：1 处
  - `start_failed`（直接 writeEvent）：1 处（startTaskQueued catch 块）

## 验证命令

```bash
node -e "const db = require('./db'); console.log(typeof db.writeEvent === 'function' ? 'writeEvent OK' : 'FAIL'); process.exit(0)"
node -e "const tm = require('./services/task-manager'); ['startTaskQueued','stopTask','checkHealth','startMonitor'].forEach(f => { if(typeof tm[f] !== 'function') throw new Error(f + ' missing'); }); console.log('ALL OK'); process.exit(0)"
```
