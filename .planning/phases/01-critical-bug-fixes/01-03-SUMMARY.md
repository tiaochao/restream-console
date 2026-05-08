---
phase: 01-critical-bug-fixes
plan: 03
status: complete
---

## Summary

修复 BUG-04：checkHealth 改用结构化 JSON 状态文件替代正则文本解析。

### 修改内容

**修改文件：** services/task-manager.js

**buildCommand() 修改：**
- 添加 `_STATUS_FILE="/tmp/restream_N.status"` 变量（JS 模板字符串，task.id 求值）
- 添加 `_write_status()` bash 函数（printf 输出 JSON 格式，写出到 `$_STATUS_FILE`，失败时 `|| true` 静默忽略）
- bash 初始化时写出 idle 状态：`_write_status idle unknown unknown false 0`
- 在推流节点（`echo "[推流] $STREAM_URL"` 前）添加：`_write_status streaming live connected false 0`
- 在兜底录播节点（`_push_auto_record_fallback` 函数内，`echo "[兜底-录播]..."` 前）添加：`_write_status fallback live unknown true "$_FALLBACK_ROUND"`
- 在 TARGET_LOST 节点（`echo "[TARGET_LOST]..."` 前）添加：`_write_status target_lost live lost false 0`
- 在直链失败节点（`echo "[错误] 无法获取直链..."` 前）添加：`_write_status source_retry retry unknown false 0`

**checkHealth() 修改：**
- SSH cmd 第三条命令改为 `cat /tmp/restream_${task.id}.status 2>/dev/null || echo '{}'`
- 新增 JSON.parse() 解析，降级处理（解析失败使用默认值 `{}`）
- 从 JSON 字段提取：jsState、jsSource、jsTarget、jsFallback、jsFbRound、jsTs
- 保留 `const logTail = ''` 变量名（避免引用错误），不再读取日志文本
- 删除所有旧正则变量：logLines、lastIndexMatching、sourceRetryPattern、sourceOfflinePattern、targetErrorPattern、rtmpErrorPattern 等
- 状态变量改为基于 JSON 字段计算：
  - lastPushIndex、isFallbackActive、lastFallbackIndex
  - isRetryLoop、isSourceOffline、isSourceUnavailable
  - isTargetLost、isExpiredDirectUrl、isFfmpegNoStreamError
  - lastGoodStreamIndex、isRtmpError、hasHealthyFrameAfterErrors
  - lastSourceErrorIndex、lastStrongOfflineIndex、lastTargetErrorIndex（兼容变量）
- isBlocked 降级为 `false`（TODO Phase 5 补充）
- 删除旧的 `const isBlocked = /.../.test(logTail)` 和 `const isRtmpError = lastIndexMatching(...)` 重复声明

### JSON 状态文件格式

```json
{"state":"streaming","source":"live","target":"connected","fallback":false,"fallback_round":0,"ts":1715174400,"pid":12345}
```

state 枚举：streaming | source_retry | source_offline | fallback | target_lost | idle | expired

### Self-Check

- [x] _write_status 函数已添加到 buildCommand bash 脚本（第 253-255 行）
- [x] _write_status 初始化调用（idle）已添加（第 256 行）
- [x] 推流节点调用（第 420 行）
- [x] 兜底录播节点调用（第 343 行）
- [x] TARGET_LOST 节点调用（第 349 行）
- [x] 直链失败节点调用（第 415 行）
- [x] checkHealth SSH cmd 第三条改为 cat .status（第 622 行）
- [x] JSON.parse() 解析状态文件（第 638 行）
- [x] 状态变量基于 JSON 字段（第 650-701 行）
- [x] 旧正则变量块完全删除（logLines、lastIndexMatching 等均已移除）
- [x] isBlocked 旧声明删除，保留为 false
- [x] isRtmpError 旧声明删除，改为 JSON 字段计算

### 注意事项

1. `_write_status` 使用 `printf` 而非 `echo`，避免换行和转义问题
2. 状态文件写操作使用 `>` 覆盖（原子性比 `>>` 追加更强）
3. 写失败时 `|| true` 静默忽略，不影响主流程
4. `logTail = ''` 保留空字符串声明，确保后续代码无 ReferenceError
5. 验证码检测（isBlocked）已临时降级为 false，Phase 5 时在 bash 脚本中添加 blocked 字段支持

## Self-Check: PASSED
