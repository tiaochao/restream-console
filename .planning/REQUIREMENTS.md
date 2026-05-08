# Requirements — restream-console

## v1 Requirements

### P0 — 稳定性 & 安全修复

- [ ] **BUG-01**: 修复 `db.js` 启动时静默删除 `source_channels` 表数据
  - 现象：每次 `require('../db')` 执行 `DELETE FROM source_channels`，用户无感知丢数据
  - 修复：删除该 DELETE 语句，改为 schema 迁移而非运行时清空

- [ ] **BUG-02**: 修复 `startQueue` Promise 链无超时导致自动重启机制可被永久阻塞
  - 现象：SSH 连接卡住（无超时保护）时整个队列冻结，所有任务无法自动重启
  - 修复：为队列中每个任务的 SSH 操作加超时保护（如 30s abort）

- [ ] **BUG-03**: 修复 `live-monitor.js` `getSetting('monitor_interval')` 未传 `userId`
  - 现象：多用户时非 admin 用户的检测频率始终由 admin 配置决定
  - 修复：传入正确的 `userId` 参数

- [ ] **BUG-04**: 修复健康状态机依赖脆弱文本正则（`checkHealth()`）
  - 现象：中文字符串硬编码、竖线分隔 log 行，编码偏差导致状态判断静默失效
  - 修复：改用结构化状态文件（JSON）替代文本日志解析

- [ ] **SEC-01**: SSH 私钥和平台 Cookie 明文存储于 SQLite
  - 现象：数据库文件可读即全部 VPS 访问权限和平台账号沦陷
  - 修复：加密存储敏感字段（AES-256，主密钥来自环境变量）

### P1 — 可观测性

- [ ] **OBS-01**: 任务状态变更时发送告警通知
  - 触发：任务掉线、恢复、启动失败、连续重试超限
  - 渠道：Webhook（通用）+ Telegram Bot（可选）
  - 配置：在系统设置页面配置渠道 URL/Token

- [ ] **OBS-02**: 任务历史统计报表
  - 内容：每个任务的运行时长、掉线次数、自动重启次数、成功率
  - 呈现：任务详情页内嵌时间线，可按日/周/月筛选
  - 存储：基于现有 task_logs 表扩展

- [ ] **OBS-03**: 系统仪表盘增强
  - 内容：各任务状态总览（卡片）、YouTube API Key 池健康状态、VPS 负载概览
  - 位置：现有 Dashboard 页面扩展

### P2 — 代码质量

- [ ] **QUA-01**: task-manager.js 和 youtube-monitor.js 核心逻辑单元测试
  - 框架：Jest（或 Node 内置 test runner）
  - 覆盖：`taskTargetUrl`、`classifyApiError`、`ffmpegArgs` 生成、状态机转换逻辑
  - 不 mock 数据库，用内存 SQLite 测试库

- [ ] **QUA-02**: 统一错误处理层
  - 目标：消除静默失败——所有 catch 块必须记录可检索日志
  - 方式：封装 `logError(context, err)` 工具函数，统一格式

- [ ] **QUA-03**: task-manager.js 拆分重构
  - 问题：单文件过大（700+ 行），FFmpeg 参数生成、SSH 部署、状态机混在一起
  - 拆分方向：`ffmpeg-args.js`、`task-ssh.js`、`task-state.js`

### P3 — 新功能

- [ ] **FEAT-01**: VPS 自动调度
  - 触发：新建任务时若未指定 VPS，自动选择负载最低的在线节点
  - 负载指标：当前运行中任务数 + VPS CPU/内存（已有健康检测数据）
  - UI：推流码的"默认 VPS"可设为"自动"

## v2 Requirements（延期）

- 移动端专属 UI 优化
- OAuth 社交账号登录
- API 层集成测试套件
- 实时日志 WebSocket 推送
- 多频道并发录播归档

## Out of Scope

- 自建流媒体服务器（RTMP ingest）— 定位是转推控制台，不是媒体服务器
- 直播内容分析（AI 字幕、内容审核）— 超出范围
- 付费计费系统 — 个人/小团队工具，不商业化

## Traceability

| REQ-ID | Phase |
|--------|-------|
| BUG-01, BUG-02, BUG-03, BUG-04 | Phase 1: 致命 Bug 修复 |
| SEC-01 | Phase 2: 安全加固 |
| OBS-01 | Phase 3: 可观测性 — 告警与通知 |
| OBS-02, OBS-03 | Phase 4: 可观测性 — 数据与仪表盘 |
| QUA-01, QUA-02 | Phase 5: 代码质量 — 错误处理与测试 |
| QUA-03 | Phase 6: 代码质量 — 重构与长期可维护性 |
| FEAT-01 | Phase 7: 新功能 — VPS 自动调度 |

---
*Generated: 2026-05-08*
