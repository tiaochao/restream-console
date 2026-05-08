const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('./ssh');
const { resolveDouyinStreamUrl } = require('./platform-api');
const fs = require('fs');
const path = require('path');
const { decrypt } = require('./crypto');
const notifier = require('./notifier');
const { writeEvent } = require('../db');
const { logError } = require('../utils/log-error');
const {
  buildCommand,
  recordLabelForTask,
  isYoutubeTarget,
  remoteDependencyInstallCommand,
  autoRecordingCompatPath,
  autoRecordingCompatName,
  MEDIA_LIBRARY_DIR,
  LEGACY_RECORD_DIR,
  AUTO_RECORDING_PREFIX,
} = require('./ffmpeg-args');
const { shSingleQuote } = require('../utils/shell-escape');
const { syncDouyinHelper, ensureRemoteRuntime, syncAutoRecordingMediaFile } = require('./task-ssh');
const { buildHealthCheckCmd, parseHealthResult, evaluateHealth } = require('./task-state');

const PLATFORM_RTMP = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  tiktok:  'rtmp://push.tiktokv.com/live',
};
const START_TASK_TIMEOUT_MS = 30 * 1000; // SSH 无响应时的最大等待时间

// 返回一个在 signal 触发 abort 时 reject 的 Promise
// 用于与业务 Promise 竞争，实现强制超时
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`[队列启动] 操作已超时`));
      return;
    }
    const onAbort = () => reject(new Error(`[队列启动] 操作超时（30s），SSH 无响应`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener('abort', onAbort); resolve(val); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); }
    );
  });
}

let startQueue = Promise.resolve();
function getDouyinCookies(userId) {
  return decrypt(getSetting('douyin_cookies', userId) || '') || '';
}

async function startTask(taskId, userId = null) {
  const task = db.prepare(`
    SELECT t.*, v.id as vid FROM tasks t
    LEFT JOIN vps v ON t.vps_id = v.id WHERE t.id = ?
    ${userId ? 'AND t.user_id = ?' : ''}
  `).get(...(userId ? [taskId, userId] : [taskId]));

  if (!task)          throw new Error('任务不存在');
  if (!task.vps_id)   throw new Error('任务未绑定 VPS');
  if (task.status === 'running') throw new Error('任务已在运行');

  // 检查 VPS 任务上限
  const ownerId = task.user_id;
  const maxPerVps = parseInt(getSetting('max_tasks_per_vps', ownerId) || '5');
  const running = db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE user_id=? AND vps_id=? AND status='running'"
  ).get(ownerId, task.vps_id).n;
  if (running >= maxPerVps) {
    throw new Error(`该 VPS 已有 ${running} 个任务运行，上限 ${maxPerVps} 个`);
  }

  // 需要本地检测开播状态的平台：抖音 / B站 / 快手
  const isMediaFile = task.source_url.startsWith('/');
  const isDouyin   = !isMediaFile && /douyin\.com/i.test(task.source_url);
  const isBilibili = !isMediaFile && /live\.bilibili\.com/i.test(task.source_url);
  const isKuaishou = !isMediaFile && /live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);

  if (isDouyin || isBilibili || isKuaishou) {
    const { checkDouyin, checkBilibili, checkKuaishou } = require('./platform-api');
    const cookies = getDouyinCookies(ownerId);

    // 1) 检测是否正在直播
    let isLive = true; // 默认乐观，检测失败时直接尝试推流
    try {
      let liveResult = null;
      if (isDouyin)   liveResult = await checkDouyin(task.source_url, cookies);
      if (isBilibili) liveResult = await checkBilibili(task.source_url);
      if (isKuaishou) liveResult = await checkKuaishou(task.source_url);
      if (liveResult && liveResult.isLive === false) isLive = false;
    } catch (err) { logError('startTaskQueued/liveCheck', err); }

    if (!isLive) {
      console.log(`[任务${taskId}] 主播未开播，进入等待直播状态`);
      db.prepare("UPDATE tasks SET status='waiting_live', remote_pid=NULL WHERE id=?").run(taskId);
      return null;
    }

    await ensureRemoteRuntime(task.vps_id, ownerId, { douyinHelper: isDouyin });

    // 2) 抖音额外处理：API 解析直链 / streamlink 兜底
    if (isDouyin) {
      try {
        const resolved = await resolveDouyinStreamUrl(task.source_url, cookies);
        if (resolved && resolved.url) {
          task._resolvedStreamUrl = resolved.url;
          console.log(`[任务${taskId}] 抖音流地址(${resolved.protocol}): ${resolved.url.substring(0, 60)}...`);
        }
      } catch (err) { logError('startTaskQueued/douyinResolve', err); }

      // 3) API 失败：用 streamlink + cookies
      if (cookies) {
        const ckFile = `/tmp/dy_ck_${taskId}.txt`;
        const cookiesB64 = Buffer.from(cookies).toString('base64');
        await sshService.exec(task.vps_id,
          `printf %s ${shSingleQuote(cookiesB64)} | base64 -d > ${ckFile}`,
          ownerId
        );
        task._douyinCookieFile = ckFile;
      }

      if (!task._resolvedStreamUrl) {
        if (cookies) {
          console.log(`[任务${taskId}] API 无直链，将用远端抖音解析 + yt-dlp 兜底: ${task._douyinCookieFile}`);
        } else {
          console.warn(`[任务${taskId}] ${task.name || ''} 未配置抖音 Cookie，将先尝试无 Cookie 远端解析；如持续失败请在设置页或系统设置补充 Cookie`);
        }
      }
    }
  }

  const { cmd, logFile } = buildCommand(task);
  const result = await sshService.exec(task.vps_id, cmd, ownerId);
  const pid = parseInt(result.stdout.trim());
  if (!pid || isNaN(pid)) {
    throw new Error('启动失败: ' + (result.stderr || '无法获取 PID'));
  }

  db.prepare(`
    UPDATE tasks
    SET status='running', remote_pid=?, log_file=?,
        started_at=datetime('now'), last_active_at=datetime('now'), stall_count=0, block_count=0
    WHERE id=?
  `).run(pid, logFile, taskId);

  return pid;
}

// 带错开延迟的启动（多任务连续启动时调用此方法）
function startTaskQueued(taskId, userId = null) {
  startQueue = startQueue.then(async () => {
    const signal = AbortSignal.timeout(START_TASK_TIMEOUT_MS);
    try {
      await raceAbort(startTask(taskId, userId), signal);
    } catch (e) {
      console.error(`[队列启动] 任务 ${taskId} 失败:`, e.message);
      // 启动失败时标记为 error，避免永远卡在 restarting
      db.prepare(`UPDATE tasks SET status='error', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
        .run(...(userId ? [taskId, userId] : [taskId]));
      notifier.send(userId, {
        type: 'task_start_failed',
        taskId,
        taskName: String(taskId),
        message: `任务 ${taskId} 启动失败：${e.message}`,
      }).catch(() => {});
      writeEvent(taskId, userId, null, 'error', `start_failed: ${e.message}`);
    }
    const delay = parseInt(getSetting('start_delay', userId || undefined) || '5') * 1000;
    await new Promise(r => setTimeout(r, delay));
  });
  return startQueue;
}

function _notify(task, type, message) {
  notifier.send(task.user_id, {
    type,
    taskId: task.id,
    taskName: task.name || String(task.id),
    message,
  }).catch(() => {});
}

function _record(task, fromStatus, toStatus, reason) {
  writeEvent(task.id, task.user_id, fromStatus, toStatus, reason);
}

async function stopTask(taskId, userId = null) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? ${userId ? 'AND user_id=?' : ''}`)
    .get(...(userId ? [taskId, userId] : [taskId]));
  if (!task) throw new Error('任务不存在');

  if (task.remote_pid && task.vps_id) {
    await sshService.exec(
      task.vps_id,
      `pkill -P ${task.remote_pid} 2>/dev/null; kill ${task.remote_pid} 2>/dev/null; rm -f /tmp/dy_ck_${taskId}.txt 2>/dev/null; true`,
      task.user_id
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    await syncAutoRecordingMediaFile(task).catch(() => {});
  }
  db.prepare(`UPDATE tasks SET status='stopped', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
    .run(...(userId ? [taskId, userId] : [taskId]));
}

// 健康检测：进程存活 + 日志文件活跃度 + 状态文件 + 目标端连接检测
async function checkHealth(task) {
  if (!task.remote_pid || !task.vps_id) return;

  const stallTimeout = parseInt(getSetting('stall_timeout', task.user_id) || '120');
  const blockLimit   = parseInt(getSetting('block_limit', task.user_id)   || '8');

  try {
    await syncAutoRecordingMediaFile(task).catch(() => {});

    const cmd = buildHealthCheckCmd(task);
    const result = await sshService.exec(task.vps_id, cmd, task.user_id);
    const now = Math.floor(Date.now() / 1000);
    const sshLines = result.stdout.trim().split('\n');
    const parsed = parseHealthResult(task, sshLines, now, stallTimeout);
    const effect = evaluateHealth(task, parsed, { blockLimit });

    if (effect.logMsg) console.log(effect.logMsg);
    if (effect.newStallCount !== null) {
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(effect.newStallCount, task.id);
    }
    if (effect.newBlockCount !== null) {
      db.prepare('UPDATE tasks SET block_count=? WHERE id=?').run(effect.newBlockCount, task.id);
    }
    if (effect.requiresStop) {
      await stopTask(task.id, task.user_id).catch(() => {});
    }
    if (effect.requiresRestart) {
      db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
      startTaskQueued(task.id, task.user_id).catch(() => {});
    } else if (effect.action === 'recover') {
      const statusPatch = ['stalled', 'source_retrying'].includes(task.status) ? ", status='running'" : '';
      db.prepare(`UPDATE tasks SET last_active_at=datetime('now'), stall_count=0, block_count=0${statusPatch} WHERE id=?`).run(task.id);
      if ((task.stall_count || 0) > 0 || ['stalled', 'restarting', 'source_retrying'].includes(task.status)) {
        _notify(task, 'task_recovered', `任务 ${task.name || task.id} 已恢复正常`);
        _record(task, task.status, 'running', 'recovered');
      }
    } else if (effect.newStatus) {
      if (effect.clearPid) {
        db.prepare('UPDATE tasks SET status=?, remote_pid=NULL WHERE id=?').run(effect.newStatus, task.id);
      } else if (effect.action === 'setRunning') {
        db.prepare("UPDATE tasks SET status='running', last_active_at=datetime('now') WHERE id=?").run(task.id);
      } else {
        db.prepare('UPDATE tasks SET status=? WHERE id=?').run(effect.newStatus, task.id);
      }
    }
    if (effect.notifyType) {
      _notify(task, effect.notifyType, effect.notifyMsg || `任务 ${task.name || task.id} 状态变更`);
    }
    if (effect.eventReason) {
      _record(task, task.status, effect.eventToStatus || effect.newStatus || task.status, effect.eventReason);
    }
  } catch (err) {
    logError('checkHealth', err);
  }
}

// 定期 ping 所有 VPS，自动更新在线状态
async function checkAllVpsStatus() {
  const vpsList = db.prepare('SELECT * FROM vps').all();
  await processInBatches(vpsList, 3, async (vps) => {
    try {
      const ok = await sshService.testConnection(vps);
      if (ok) {
        db.prepare("UPDATE vps SET status='online', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      } else {
        db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      }
    } catch (_) {
      db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
    }
  });
}

async function processInBatches(items, limit, handler) {
  const queue = Array.isArray(items) ? [...items] : [];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await handler(item);
    }
  });
  await Promise.all(workers);
}

function startMonitor() {
  // 任务健康检测：每 30s（运行中 + 异常/重试中的活动任务）
  setInterval(async () => {
    const active = db.prepare(
      "SELECT * FROM tasks WHERE status IN ('running','stalled','source_retrying','target_lost')"
    ).all();
    await processInBatches(active, 3, task => checkHealth(task).catch(err => logError('checkHealth', err)));
  }, 30 * 1000);

  // 等待直播监控：每 60s 检查 waiting_live 任务，开播则自动启动
  setInterval(async () => {
    const waiting = db.prepare(
      "SELECT * FROM tasks WHERE status='waiting_live'"
    ).all();
    await processInBatches(waiting, 2, task => checkAndStartIfLive(task).catch(() => {}));
  }, 60 * 1000);

  // VPS 在线状态检测：每 2 分钟
  setInterval(() => {
    checkAllVpsStatus().catch(e => console.error('[VPS心跳]', e.message));
  }, 2 * 60 * 1000);

  // 启动时立刻检测一次
  setTimeout(() => {
    checkAllVpsStatus().catch(() => {});
  }, 3000);
}

// 检查来源是否开播，若是则自动启动任务
async function checkAndStartIfLive(task) {
  const { checkDouyin, checkBilibili, checkKuaishou } = require('./platform-api');
  const url = task.source_url;

  const isDouyin   = /douyin\.com/i.test(url);
  const isBilibili = /live\.bilibili\.com/i.test(url);
  const isKuaishou = /live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(url);
  if (!isDouyin && !isBilibili && !isKuaishou) return;

  try {
    let result = null;
    if (isDouyin)   result = await checkDouyin(url, getDouyinCookies(task.user_id));
    if (isBilibili) result = await checkBilibili(url);
    if (isKuaishou) result = await checkKuaishou(url);

    if (result && result.isLive) {
      console.log(`[等待直播] 任务 ${task.id} 检测到开播，自动启动`);
      startTaskQueued(task.id, task.user_id);
    }
  } catch (err) { logError('checkAndStartIfLive', err); }
}

module.exports = { startTask, startTaskQueued, stopTask, checkHealth, startMonitor, PLATFORM_RTMP, checkAndStartIfLive, recordLabelForTask, _buildCommand: buildCommand };
