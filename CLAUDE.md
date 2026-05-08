# restream-console — 项目指令

## 项目概述

YouTube 直播转推控制台。通过 SSH 在远端 VPS 上启动 FFmpeg，将 YouTube 直播转推至多个 RTMP 目标。

- **技术栈**：Node.js 24 / Express / SQLite / FFmpeg / Docker
- **规划目录**：`.planning/`（GSD 工作流）

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

## 关键文件

| 文件 | 说明 |
|------|------|
| `services/task-manager.js` | 核心：任务生命周期、FFmpeg、SSH |
| `services/youtube-monitor.js` | YouTube 直播状态检测 |
| `services/live-monitor.js` | 多平台直播检测轮询 |
| `db.js` | 数据库 schema 和迁移 |
| `.planning/CONCERNS.md` | 已知严重问题清单 |

## 已知严重问题（待 Phase 1 修复）

1. `db.js` 启动时静默删除 `source_channels` 数据
2. `startQueue` 无超时保护，SSH 卡住时全局冻结
3. `live-monitor.js` `getSetting` 未传 `userId`
4. `checkHealth()` 依赖脆弱文本正则解析
