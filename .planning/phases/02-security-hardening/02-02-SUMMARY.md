# 02-02 执行摘要：stopTask 停止任务时清除 VPS Cookie 临时文件

## 修改信息

- **文件**：`services/task-manager.js`
- **修改行号**：第 598 行
- **函数**：`stopTask(taskId, userId = null)`

## 新的完整 SSH 命令字符串

```javascript
`pkill -P ${task.remote_pid} 2>/dev/null; kill ${task.remote_pid} 2>/dev/null; rm -f /tmp/dy_ck_${taskId}.txt 2>/dev/null; true`
```

## 变更说明

在原有的进程终止命令之后，新增了 `rm -f /tmp/dy_ck_${taskId}.txt 2>/dev/null` 子命令。

- 当任务停止时，同步删除 VPS 上由任务写入的 Cookie 明文临时文件 `/tmp/dy_ck_<taskId>.txt`
- 使用 `2>/dev/null` 抑制错误输出（文件不存在时不报错）
- `taskId` 为 `stopTask` 函数的参数，可直接在模板字符串中引用
- 末尾保留 `true` 确保整体命令以成功状态退出

## 安全意义（SEC-01）

Cookie 明文文件在任务结束后继续驻留 VPS 磁盘是一个安全风险。此修改确保每次任务正常停止时，对应的临时文件都会被及时清除，降低 VPS 被入侵后 Cookie 泄漏的风险。
