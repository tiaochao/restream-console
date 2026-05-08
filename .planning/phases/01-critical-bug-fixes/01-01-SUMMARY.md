---
phase: 01-critical-bug-fixes
plan: 01
status: complete
---

## Summary

修复 BUG-01 和 BUG-03。

### BUG-01: db.js 删除破坏性 DELETE

**修改文件：** db.js
**修改内容：** 删除了 `DELETE FROM source_channels WHERE id NOT IN (...)` 语句，保留了幂等的 `CREATE UNIQUE INDEX IF NOT EXISTS idx_source_channels_user_url`

### BUG-03: live-monitor.js getSetting 补传 userId

**修改文件：** services/live-monitor.js, db.js（module.exports 添加 defaultUserId）
**修改内容：** `getSetting('monitor_interval')` 改为 `getSetting('monitor_interval', defaultUserId)`，明确使用 admin 配置作为全局轮询间隔

### Self-Check

- [x] DELETE FROM source_channels 已从 db.js 删除
- [x] idx_source_channels_user_url 索引创建仍然存在
- [x] getSetting('monitor_interval', defaultUserId) 已传入 userId
- [x] 两个文件均可正常加载

## Self-Check: PASSED
