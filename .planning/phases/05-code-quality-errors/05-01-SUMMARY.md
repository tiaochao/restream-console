# Plan 05-01 执行摘要：结构化错误日志

## 完成时间
2026-05-08

## logError 调用总数

| 文件 | logError 调用次数 |
|------|-----------------|
| services/task-manager.js | 7 |
| services/youtube-monitor.js | 2 |
| **合计** | **9** |

## 新增文件

- `utils/log-error.js` — 结构化错误日志工具，输出格式：`[ERROR][context] message\n  at ...`

## 修复的 catch 列表

### services/task-manager.js

| 函数 | 上下文标签 | 原因 |
|------|-----------|------|
| `sourceRecordLabel` | `sourceRecordLabel` | URL 解析失败（new URL 抛出异常） |
| `channelRecordLabel` | `channelRecordLabel` | 数据库查询异常 |
| `startTask`（平台直播检测） | `startTaskQueued/liveCheck` | checkDouyin/checkBilibili/checkKuaishou 失败 |
| `startTask`（抖音流解析） | `startTaskQueued/douyinResolve` | resolveDouyinStreamUrl 失败 |
| `checkHealth`（内层 catch）| `checkHealth` | SSH 暂时失败，不改状态 |
| `checkHealth`（.catch 链）| `checkHealth` | processInBatches 中 checkHealth promise 拒绝 |
| `checkAndStartIfLive` | `checkAndStartIfLive` | 平台开播检测失败 |

### services/youtube-monitor.js

| 函数 | 上下文标签 | 原因 |
|------|-----------|------|
| `extractYouTubeVideoId` | `extractVideoId` | URL 解析失败 |
| `extractYouTubeChannelRef` | `extractChannelRef` | URL 解析失败 |

## classifyApiError 导出

- 文件：`services/youtube-monitor.js`
- 导出行号：**第 425 行**
- 已添加到 `module.exports` 块

## scripts/check.js 新增断言

1. `task-manager 导入 logError 工具` — 验证 `require('../utils/log-error')` 存在
2. `checkHealth 外层错误日志（CONCERNS #16）` — 验证 `logError('checkHealth'` 存在
3. `youtube-monitor 导出 classifyApiError` — 验证 `classifyApiError,` 在导出块中
