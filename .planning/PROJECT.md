# restream-console

## What This Is

一套自托管的 **YouTube 直播转推控制台**。用户在 Web 界面配置好推流码、VPS 节点和 YouTube 频道后，系统通过 SSH 在远端 VPS 上启动 FFmpeg，将 YouTube 直播源实时转推至任意 RTMP 目标（YouTube 多频道、TikTok、抖音、B站、快手等）。

**核心价值**：稳定、可观测、可托管给他人使用的直播转推平台。

## Context

- **当前状态**：Brownfield — 核心功能已跑通（转推任务、VPS 管理、YouTube 频道监控、多平台推流码）
- **使用场景**：个人自用为主，未来可能开放给小团队或他人部署
- **技术栈**：Node.js 24 / Express / SQLite / FFmpeg / SSH / Docker
- **托管方式**：VPS Docker 部署，数据持久化于 `./data/`

## Requirements

### Validated（已有功能）

- ✓ 多用户账号系统（session-based 认证）— existing
- ✓ VPS 节点管理（SSH 连接、健康检测、文件部署）— existing
- ✓ 推流码库管理（RTMP 地址 + 密钥，绑定 VPS 和 YouTube 频道）— existing
- ✓ YouTube 频道管理（添加/同步/视频记录，current_live_video_id）— existing
- ✓ 任务管理（创建/启动/停止/重启，FFmpeg 参数生成）— existing
- ✓ 多平台直播状态检测（YouTube API / 抖音 HTML / B站 / 快手）— existing
- ✓ YouTube API Key 池（多 Key 轮询、配额暂停、状态追踪）— existing
- ✓ 任务自动重启机制（source_retrying / target_lost / stalled 状态机）— existing
- ✓ FFmpeg 进程生命周期管理（后台封面兜底、HLS 重连控制）— existing
- ✓ 日志查看（任务日志、历史日志）— existing
- ✓ 媒体文件管理（VPS 上的封面/录播文件）— existing

### Active（本次要做）

**P0 — 稳定性 & 安全修复**
- [ ] **BUG-01**：修复 `db.js` 启动时静默删除 `source_channels` 表数据（每次 require 执行 DELETE）
- [ ] **BUG-02**：修复 `startQueue` Promise 链无超时保护导致整个自动重启机制可被永久阻塞
- [ ] **BUG-03**：修复 `live-monitor.js` `getSetting('monitor_interval')` 未传 `userId`，非 admin 用户检测频率失效
- [ ] **BUG-04**：修复健康状态机依赖脆弱文本正则解析远端日志（编码/措辞变化导致静默失效）
- [ ] **SEC-01**：SSH 私钥和 Cookie 明文存储于 SQLite 数据库，需要加密或安全隔离

**P1 — 可观测性**
- [ ] **OBS-01**：任务掉线/恢复/错误时发送告警通知（支持至少一种渠道：Telegram / 企业微信 / Webhook）
- [ ] **OBS-02**：任务历史统计（运行时长、掉线次数、成功率）可在界面查看
- [ ] **OBS-03**：系统层面的运行状况仪表盘（各任务状态总览、API Key 池状态）

**P2 — 代码质量**
- [ ] **QUA-01**：task-manager.js 和 youtube-monitor.js 核心逻辑单元测试（Jest）
- [ ] **QUA-02**：统一错误处理层（静默失败改为有日志记录的可观测错误）
- [ ] **QUA-03**：task-manager.js 拆分重构（文件过大、职责混杂）

**P3 — 新功能**
- [ ] **FEAT-01**：VPS 自动调度（启动任务时自动选择负载最低的可用节点）

### Out of Scope

- 移动端专属 UI 适配 — 现有响应式够用，不需专门设计
- OAuth 社交账号登录 — 自用场景无必要
- 完整集成测试套件（API 层） — 成本高，先做核心单元测试
- 实时日志流推送（WebSocket） — 现有轮询模式可接受

## Key Decisions

| 决策 | 理由 | 结论 |
|------|------|------|
| 稳定性优先于新功能 | 系统已有掉线风险，先筑牢地基 | P0 bug 必须在加新功能前完成 |
| 单元测试只覆盖核心模块 | 流媒体基础设施难以 mock，ROI 低 | 测 task-manager / youtube-monitor 业务逻辑 |
| 通知渠道优先 Telegram/Webhook | 无三方依赖限制，接入最简单 | 可配置多渠道，Webhook 作为通用出口 |
| 未来多用户开放 | 已有多用户架构，安全加固后可开放 | 设计时保持多用户隔离兼容性 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?

---
*Last updated: 2026-05-08 after initialization*
