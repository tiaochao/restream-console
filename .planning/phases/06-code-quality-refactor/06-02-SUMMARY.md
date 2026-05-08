---
plan: 06-02
phase: 06-code-quality-refactor
status: complete
completed: 2026-05-08
commit: fa61ac8
---

## Summary

创建 `services/ffmpeg-args.js`，将 `task-manager.js` 中的 FFmpeg 命令构建逻辑（`buildCommand` + label 辅助函数 + ffmpeg 参数函数）抽取到独立模块，从 task-manager.js 减少约 410 行。

## Key Files Created

- `services/ffmpeg-args.js` — 导出 `buildCommand`, `recordLabelForTask`, `isYoutubeTarget`, `remoteDependencyInstallCommand`, `autoRecordingCompatPath`, `autoRecordingCompatName`, `MEDIA_LIBRARY_DIR`, `LEGACY_RECORD_DIR`, `AUTO_RECORDING_PREFIX`（374 行）

## Key Files Modified

- `services/task-manager.js` — 导入 ffmpeg-args，移除约 410 行本地定义

## Self-Check: PASSED

- `node -e "require('./services/ffmpeg-args')"` — 无报错
- `node -e "const tm=require('./services/task-manager');console.log(typeof tm._buildCommand)"` — function
- `grep -c "^function buildCommand" services/task-manager.js` — 0
- `npm test` — 26 passed
