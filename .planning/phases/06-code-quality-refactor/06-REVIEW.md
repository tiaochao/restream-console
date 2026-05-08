---
phase: 06-code-quality-refactor
reviewed: 2026-05-09T00:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - utils/shell-escape.js
  - services/live-monitor.js
  - services/ffmpeg-args.js
  - services/task-manager.js
  - services/task-ssh.js
  - services/task-state.js
findings:
  critical: 1
  warning: 4
  info: 4
  total: 9
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-05-09  
**Depth:** standard  
**Files Reviewed:** 6  
**Status:** issues_found

## Summary

本次审查的 6 个文件是 Phase 6 重构输出，将 `task-manager.js` 中的功能分别提取到 `ffmpeg-args.js`、`task-ssh.js`、`task-state.js` 中。总体结构清晰，模块职责分离合理。

但发现 1 个 **BLOCKER**：`live-monitor.js` 读取 douyin cookies 时未解密，会将加密密文原样传递给远端命令，导致抖音直播检测和推流功能失效。此外发现 4 个 **WARNING**（死代码逻辑、未使用导入、重启时泄漏临时文件），以及 4 个 **INFO** 项（代码质量问题）。

---

## Critical Issues

### CR-01: `live-monitor.js` 读取抖音 Cookie 时未解密

**File:** `services/live-monitor.js:11`  
**Issue:** `getDouyinCookies()` 直接返回数据库中的原始值，而数据库中存储的是加密密文（经 `encrypt()` 处理，格式为 `enc:v1:...`）。这导致 `buildDouyinCheckCmd` 和 `buildYtDlpCmd` 将密文字符串直接传递给远端 Shell 命令，抖音 Cookie 鉴权永久失效。

对比 `task-manager.js:51` 的正确实现：
```javascript
// task-manager.js — 正确（有 decrypt）
return decrypt(getSetting('douyin_cookies', userId) || '') || '';

// live-monitor.js:11 — 错误（缺少 decrypt）
return getSetting('douyin_cookies', userId) || '';
```

**Fix:** 在 `live-monitor.js` 中引入 `decrypt` 并解密：
```javascript
// 顶部增加导入
const { decrypt } = require('./crypto');

// 修改 getDouyinCookies
function getDouyinCookies(userId) {
  return decrypt(getSetting('douyin_cookies', userId) || '') || '';
}
```

---

## Warnings

### WR-01: `task-state.js` Branch 1 中不可达代码（`stall()` 分支永远不执行）

**File:** `services/task-state.js:88-91`  
**Issue:** Branch 1 的条件 `if (newStallCount >= 1)` 永远为真（`newStallCount` 的最小值是 `(task.stall_count || 0) + 1`，即至少为 1）。其下的 `stall()` 返回路径（第 91 行）是死代码，设计者的原意可能是 `>= 2`。如果阈值误设，导致 ffmpeg 无流输出时「立刻重启」而非「先进入 stalled 状态」，可能导致在短暂无流时过激重启。

```javascript
// 当前代码（第 88 行）—— >= 1 永远成立
if (newStallCount >= 1) {
  return restart(newStallCount, logMsg);
}
return { ...stall(newStallCount), logMsg }; // 永远不执行
```

**Fix:** 明确设计意图。若确实要求第一次检测就立即重启，改为直接 `return restart(...)` 并删除死代码；若要先 stalled 一次再重启，改为 `>= 2`：
```javascript
// 方案 A：明确表达"立即重启"
return restart(newStallCount, logMsg);

// 方案 B：宽容一次再重启
if (newStallCount >= 2) {
  return restart(newStallCount, logMsg);
}
return { ...stall(newStallCount), logMsg };
```

---

### WR-02: `ffmpeg-args.js` 引入了从未使用的 `getSetting` 和 `decrypt`

**File:** `services/ffmpeg-args.js:2-3`  
**Issue:** 重构后 `ffmpeg-args.js` 仍保留了对 `getSetting` 和 `decrypt` 的导入，但文件中没有任何代码调用它们。这是重构遗留的幽灵导入，会误导维护者以为该模块依赖加密/设置系统，也增加了对 `crypto` 服务的不必要耦合。

```javascript
const { getSetting } = require('../db');  // 第 2 行 — 未使用
const { decrypt } = require('./crypto');   // 第 3 行 — 未使用
```

**Fix:** 删除这两行导入。

---

### WR-03: `task-manager.js` 引入了从未使用的 `fs` 和 `path`

**File:** `services/task-manager.js:5-6`  
**Issue:** 重构后文件操作相关逻辑已移至 `task-ssh.js`，但 `task-manager.js` 仍保留了 `fs` 和 `path` 的导入且从未使用。

```javascript
const fs = require('fs');    // 第 5 行 — 未使用
const path = require('path'); // 第 6 行 — 未使用
```

**Fix:** 删除这两行导入。

---

### WR-04: 进程自然死亡时（Branch 9 `auto_restart`）不清理 VPS 上的 Cookie 临时文件

**File:** `services/task-state.js:199-204` / `services/task-manager.js:234-236`  
**Issue:** 当 `procStatus === 'dead'` 且 `task.auto_restart` 为真时，`evaluateHealth` 返回 `requiresStop: false`（合理，进程已死不需要 pkill），但这也意味着 `task-manager.js` 不会调用 `stopTask`。而 `stopTask` 中负责清理抖音 Cookie 临时文件（`rm -f /tmp/dy_ck_${taskId}.txt`）的命令也不会执行。任务随后自动重启时会重新创建新的临时文件，但旧文件会在 VPS 上残留，直到 `stopTask` 被主动调用。

这在长时间运行的多轮自动重启中会逐渐积累（虽然同名文件会被覆盖，无实际危害），但对进程外死亡时的清理链存在逻辑缺口。

**Fix:** 在 `evaluateHealth` 的 Branch 9（auto_restart 路径）中，或在 `task-manager.js` 的重启分支中，针对有 cookie 文件的任务单独发一条清理命令：
```javascript
// task-manager.js checkHealth 中，requiresRestart=true 后添加
if (effect.requiresRestart) {
  db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
  // 清理可能残留的抖音 Cookie 临时文件
  sshService.exec(task.vps_id,
    `rm -f /tmp/dy_ck_${task.id}.txt 2>/dev/null; true`,
    task.user_id
  ).catch(() => {});
  startTaskQueued(task.id, task.user_id).catch(() => {});
}
```

---

## Info

### IN-01: `task-state.js` 中 `isBlocked` 硬编码为 `false`，Branch 7 是永久死代码

**File:** `services/task-state.js:43, 166`  
**Issue:** `isBlocked` 永远是 `false`，Branch 7（验证码/封锁检测）从不执行。相关的 `block_count`、`blockLimit` 配置和 `newBlockCount` 的计算逻辑均无效。如果这是有意为之（功能待实现），应加注释说明；否则可能是遗漏的实现。

```javascript
const isBlocked = false; // 永远为 false — Branch 7 为死代码
```

**Fix:** 若该功能已废弃，删除 Branch 7 及相关字段；若计划实现，添加 TODO 注释：
```javascript
// TODO: isBlocked 检测逻辑待实现（需要从 statusJson 解析验证码信号）
const isBlocked = false;
```

---

### IN-02: `task-manager.js` 中 `getSetting('start_delay', userId || undefined)` 参数不规范

**File:** `services/task-manager.js:170`  
**Issue:** 当 `userId` 为 `null` 时，`userId || undefined` 求值为 `undefined`，会被传入 SQL prepared statement。`getSetting` 函数签名有默认参数 `userId = defaultUserId`，但调用时显式传入 `undefined` 不会触发默认参数（JavaScript 中 `undefined` 会触发默认值）。这里实际上 `getSetting` 的默认值生效，行为最终正确，但代码意图不清晰。

```javascript
// 当前代码
const delay = parseInt(getSetting('start_delay', userId || undefined) || '5') * 1000;

// 更清晰的写法
const delay = parseInt(getSetting('start_delay', userId ?? defaultUserId) || '5') * 1000;
```

**Fix:** 导入 `defaultUserId` 并显式使用：
```javascript
const { getSetting, defaultUserId } = require('../db');
// ...
const delay = parseInt(getSetting('start_delay', userId ?? defaultUserId) || '5') * 1000;
```

---

### IN-03: `task-ssh.js` 中 `syncDouyinHelper` 文件读取失败时缺少错误上下文

**File:** `services/task-ssh.js:17`  
**Issue:** `fs.readFileSync(scriptPath, 'utf8')` 在 `check_douyin.py` 文件不存在时会抛出 `ENOENT` 错误。该错误会传播到 `ensureRemoteRuntime` 调用者，最终被 `startTaskQueued` 的全局 catch 处理，但错误信息（`ENOENT: no such file or directory`）没有说明是哪个文件导致任务启动失败，增加了排查难度。

**Fix:** 包一层 try-catch 提供更清晰的错误信息：
```javascript
async function syncDouyinHelper(vpsId, userId) {
  const scriptPath = path.join(__dirname, '..', 'check_douyin.py');
  let script;
  try {
    script = fs.readFileSync(scriptPath, 'utf8');
  } catch (err) {
    throw new Error(`[task-ssh] 无法读取抖音解析脚本 ${scriptPath}: ${err.message}`);
  }
  // ...
}
```

---

### IN-04: `live-monitor.js` `startLiveMonitor` 使用 admin 全局轮询间隔（已知问题）

**File:** `services/live-monitor.js:146`  
**Issue:** 代码注释已标注 `TODO(Phase 6): 重构为每用户独立定时器`，但 Phase 6 并未完成此重构。轮询间隔取自 admin 用户的 `monitor_interval` 设置，其他用户的间隔配置被忽略。这是多租户隔离缺陷。

**Fix:** Phase 7 前应创建独立 issue 跟踪；或在 `startLiveMonitor` 中按用户分组通道，分别使用各用户的 `monitor_interval`。

---

_Reviewed: 2026-05-09_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: standard_
