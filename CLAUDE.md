# restream-console — 项目指令

## 项目概述

YouTube 直播转推控制台。通过 SSH 在远端 VPS 上启动 FFmpeg，将 YouTube 直播转推至多个 RTMP 目标。

- **技术栈**：Node.js 24 / Express / SQLite / FFmpeg / Docker
- **流程约束**：按 GSD 思路拆分、验证和记录，但仓库内不再保留 `.planning/` 运行态目录。

## GSD 工作流

本项目使用 GSD (Get Shit Done) 规范流程开发：

```
/gsd-resume-work     — 新对话开始时恢复上下文
/gsd-progress        — 查看当前进度
/gsd-plan-phase N    — 为第 N 阶段创建执行计划
/gsd-execute-phase N — 执行第 N 阶段
/gsd-fast "描述"     — 快速修复（≤3 文件）
```

**当前里程碑**：Milestone 1.0 — 稳定可信赖的转推平台

**阶段顺序（不可跳过）**：
1. Phase 1: 致命 Bug 修复（BUG-01~04）
2. Phase 2: 安全加固（SEC-01）
3. Phase 3: 可观测性 — 告警与通知（OBS-01）
4. Phase 4: 可观测性 — 数据与仪表盘（OBS-02~03）
5. Phase 5: 代码质量 — 错误处理与测试（QUA-01~02）
6. Phase 6: 代码质量 — 重构（QUA-03）
7. Phase 7: VPS 自动调度（FEAT-01）

## 开发原则

- **稳定性优先**：Phase 1+2 是硬前置，必须完成后再进入后续阶段
- **YOLO 模式**：无需每步确认，直接执行
- **不破坏已有功能**：每个 Phase 执行后运行手动验证
- **提交规范**：`type: 描述` + `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

## 直播稳定性约定

- 直播源断开或关播后，YouTube 兜底源必须优先使用当前任务、当前场次的 VPS 本地录播。
- 兜底优先级：实时直链 -> 正在录制的临时片段快照 -> 当前场次自动录播文件 -> `task_<taskId>_latest.ts` 兼容链接 -> 断流/重试。
- 不要把默认兜底改成媒体库旧文件、其他任务录播或其他主播文件，除非用户在任务中显式选择。
- 自动录播文件命名应保留日期时间、频道/主播名和 taskId，便于排查是哪一场直播。
- FFmpeg 参数必须兼容 Ubuntu 20.04 默认 FFmpeg 4.2.x；不要使用未验证的新版本专属参数。

## 故障排查

遇到问题**先查** [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)，里面有：
- 环境配置速览（VPS 列表、FFmpeg 版本、部署命令）
- 各平台已知限制（抖音 Cookie、YouTube tee muxer、FFmpeg 4.2.x 禁用参数）
- 历史修复记录（按时间排列）

**每次解决新问题后，及时追加到 `TROUBLESHOOTING.md` 的第七节"历史修复时间线"。**

## 关键文件

| 文件 | 说明 |
|------|------|
| `TROUBLESHOOTING.md` | 故障排查手册（环境配置 + 历史问题记录）|
| `services/task-manager.js` | 核心：任务生命周期、FFmpeg、SSH |
| `services/youtube-monitor.js` | YouTube 直播状态检测 |
| `services/live-monitor.js` | 多平台直播检测轮询 |
| `db.js` | 数据库 schema 和迁移 |

## 已知严重问题（待 Phase 1 修复）

1. `db.js` 启动时静默删除 `source_channels` 数据
2. `startQueue` 无超时保护，SSH 卡住时全局冻结
3. `live-monitor.js` `getSetting` 未传 `userId`
4. `checkHealth()` 依赖脆弱文本正则解析
