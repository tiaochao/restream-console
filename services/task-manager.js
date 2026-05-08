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
const { dqEsc, shSingleQuote } = require('../utils/shell-escape');

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
async function syncDouyinHelper(vpsId, userId) {
  const scriptPath = path.join(__dirname, '..', 'check_douyin.py');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const scriptB64 = Buffer.from(script).toString('base64');
  await sshService.exec(vpsId, [
    'mkdir -p /opt/restream-console',
    `printf %s ${shSingleQuote(scriptB64)} | base64 -d > /opt/restream-console/check_douyin.py`,
    'chmod +x /opt/restream-console/check_douyin.py',
  ].join(' && '), userId);
}

async function ensureRemoteRuntime(vpsId, userId, options = {}) {
  await sshService.exec(vpsId, remoteDependencyInstallCommand(), userId);
  if (options.douyinHelper) await syncDouyinHelper(vpsId, userId);
}

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

    // 一次 SSH 同时检查进程存活 + 日志 mtime + 状态文件 + RTMP 连接
    const cmd = [
      `kill -0 ${task.remote_pid} 2>/dev/null && echo alive || echo dead`,
      `stat -c %Y ${task.log_file} 2>/dev/null || echo 0`,
      `cat /tmp/restream_${task.id}.status 2>/dev/null || echo '{}'`,
      `if ! command -v ss >/dev/null 2>&1; then echo rtmp_unknown; else _RTMP_HIT=0; _PIDS="${task.remote_pid}"; _SID=$(ps -o sid= -p ${task.remote_pid} 2>/dev/null | tr -d ' '); if [ -n "$_SID" ]; then _PIDS="$(ps -o pid= -g "$_SID" 2>/dev/null | tr '\\n' ' ')"; elif command -v pgrep >/dev/null 2>&1; then _SCAN="${task.remote_pid}"; while [ -n "$_SCAN" ]; do _NEXT=""; for _PP in $_SCAN; do for _CP in $(pgrep -P "$_PP" 2>/dev/null); do _PIDS="$_PIDS $_CP"; _NEXT="$_NEXT $_CP"; done; done; _SCAN="$_NEXT"; done; fi; for _P in $_PIDS; do ss -tnp 2>/dev/null | grep -E ':(1935|443) ' | grep -q "pid=$_P," && _RTMP_HIT=1; done; [ "$_RTMP_HIT" = "1" ] && echo rtmp_connected || echo no_rtmp; fi`,
    ].join('; ');

    const result = await sshService.exec(task.vps_id, cmd, task.user_id);
    const lines = result.stdout.trim().split('\n');
    const procStatus = lines[0]?.trim();
    const mtime = parseInt(lines[1]?.trim() || '0');
    const rtmpStatus = lines[3]?.trim() || 'rtmp_unknown';
    const now = Math.floor(Date.now() / 1000);
    const stale = mtime > 0 && (now - mtime) > stallTimeout;

    // 解析 JSON 状态文件（由 bash 脚本的 _write_status 函数写出）
    let statusJson = {};
    try {
      const raw = (lines[2] || '{}').trim();
      statusJson = JSON.parse(raw);
    } catch (_) {
      // 状态文件不存在或格式错误，降级为空对象，后续判断使用默认值
    }
    const jsState       = statusJson.state     || 'unknown';   // streaming|source_retry|source_offline|fallback|target_lost|idle|expired
    const jsSource      = statusJson.source    || 'unknown';   // live|retry|offline|unknown
    const jsTarget      = statusJson.target    || 'unknown';   // connected|lost|unknown
    const jsFallback    = statusJson.fallback  === true;       // boolean

    // === 基于 JSON 状态文件的健康判断（替代正则文本解析）===

    // 兜底录播：脚本报告 fallback 状态
    const isFallbackActive = jsFallback === true || jsState === 'fallback';

    // 直播源重试：无法获取直链
    const isRetryLoop      = jsState === 'source_retry' || jsSource === 'retry';

    // 直播源明确离线（404/not live 类）
    const isSourceOffline  = jsSource === 'offline' || jsState === 'source_offline';
    const isSourceUnavailable = isSourceOffline;

    // 目标 RTMP 断开
    const isTargetLost     = jsState === 'target_lost' || jsTarget === 'lost';

    // 直链过期（URL expire 时间戳临近）
    const isExpiredDirectUrl = jsState === 'expired';

    // ffmpeg 无流输出（状态文件首次创建前或脚本未能写出）
    const isFfmpegNoStreamError = jsState === 'idle' && procStatus !== 'dead' && mtime > 0 && (now - mtime) < 30;

    // 是否为直播类源
    const isLiveSource = !task.source_url.startsWith('/') &&
      /douyin\.com|live\.bilibili\.com|live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);

    // RTMP 连接状态（来自 ss 命令，与之前相同）
    const expectsRtmp1935   = /^rtmp:\/\//i.test(String(task.rtmp_url || ''));
    const isYoutubeRtmpMissing = isYoutubeTarget(task) && expectsRtmp1935 && procStatus !== 'dead' && rtmpStatus === 'no_rtmp';
    const isTargetStatus    = task.status === 'target_lost';

    // 验证码/封锁检测：JSON 状态文件中无法检测，降级为保守值（不触发 block 逻辑）
    // TODO(Phase 5): 可在状态文件中添加 blocked 字段
    const isBlocked = false;

    // RTMP 推流错误：从 JSON target 字段判断
    const isRtmpError = jsTarget === 'lost' && procStatus !== 'dead' && !jsFallback;

    // 空流输出（无音视频流）：从状态文件无法直接检测，保留为 false
    // 此场景在 streaming 状态下 mtime 会停止更新，stale 逻辑会捕获
    const hasHealthyFrameAfterErrors = jsState === 'streaming';

    if (procStatus !== 'dead' && isFfmpegNoStreamError && !hasHealthyFrameAfterErrors) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[health] task ${task.id} ffmpeg output has no streams, restarting to rebuild command, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (newStallCount >= 1) {
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    if (procStatus !== 'dead' && isExpiredDirectUrl && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[health] task ${task.id} source direct url expired, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (isFallbackActive) {
        db.prepare("UPDATE tasks SET status='running', last_active_at=datetime('now') WHERE id=?").run(task.id);
        return;
      }

      db.prepare("UPDATE tasks SET status='source_retrying' WHERE id=?").run(task.id);
      return;
    }

    if (procStatus !== 'dead' && isRetryLoop && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} 正在重试解析直播源，stall=${newStallCount}`);
      db.prepare("UPDATE tasks SET status='source_retrying', stall_count=? WHERE id=?").run(newStallCount, task.id);
      return;
    }

    if (isTargetLost || isTargetStatus) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[health] task ${task.id} target RTMP disconnected, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET status=?, stall_count=? WHERE id=?').run('target_lost', newStallCount, task.id);

      if (newStallCount >= 2 || isTargetStatus) {
        if (task.auto_restart) {
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='target_lost', remote_pid=NULL WHERE id=?").run(task.id);
        }
      }
      return;
    }

    if (isYoutubeRtmpMissing && !isRetryLoop && !isExpiredDirectUrl && !isSourceUnavailable) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 未检测到 YouTube RTMP 连接，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (newStallCount >= 2) {
        if (task.auto_restart) {
          console.log(`[健康监控] 任务 ${task.id} YouTube RTMP 连接丢失，自动重启`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
      } else if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    // 直播源已不可用时，优先按“源结束/未开播”处理，避免把脚本重试误显示为推流中。
    if (procStatus !== 'dead' && isSourceUnavailable && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} 直播源不可用，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (isFallbackActive) {
        db.prepare("UPDATE tasks SET status='running', last_active_at=datetime('now') WHERE id=?").run(task.id);
        return;
      }

      if (!isSourceOffline || newStallCount < 2) {
        if (task.status !== 'stalled') {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
        return;
      }

      console.log(`[健康监控] 任务 ${task.id} 直播源持续不可用，进入等待开播`);
      await stopTask(task.id, task.user_id).catch(() => {});
      db.prepare("UPDATE tasks SET status='waiting_live', remote_pid=NULL, stall_count=0 WHERE id=?").run(task.id);
      return;
    }

    // 检测抖音验证码特征词（streamlink 报错时会出现）
    // 验证码/封锁检测：JSON 状态文件中无法检测，降级为保守值（不触发 block 逻辑）
    // TODO(Phase 5): 可在状态文件中添加 blocked 字段
    if (isBlocked) {
      const newBlockCount = (task.block_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到验证码/封锁，block_count=${newBlockCount}`);
      db.prepare('UPDATE tasks SET block_count=? WHERE id=?').run(newBlockCount, task.id);

      if (newBlockCount >= blockLimit) {
        console.error(`[健康监控] 任务 ${task.id} 连续 ${newBlockCount} 次被封，自动停止（IP 可能被封）`);
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='blocked', remote_pid=NULL WHERE id=?").run(task.id);
        return;
      }
    }

    // 检测 RTMP 推流目标断开（YouTube/TikTok 主动断流、推流码失效等）
    // isRtmpError 已在 JSON 状态判断块中通过 jsTarget 字段计算
    if (isRtmpError) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到 RTMP 推流错误（可能目标端断流），stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);
      // 允许短暂断流重试（最多 3 次 ≈ 90s），超过则停止
      if (newStallCount >= 3) {
        if (task.auto_restart) {
          console.error(`[健康监控] 任务 ${task.id} RTMP 持续报错，自动重启`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          console.error(`[健康监控] 任务 ${task.id} RTMP 持续报错，自动停止`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
          _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`);
          _record(task, task.status, 'error', 'process_died');
        }
        return;
      }
      if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    if (procStatus === 'dead') {
      // 进程已死
      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 进程已死，自动重启`);
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else {
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
        _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`);
        _record(task, task.status, 'error', 'process_died');
      }
      return;
    }

    if (stale || isRetryLoop) {
      const reason = stale ? `日志 ${now - mtime}s 无更新` : '无法获取直链';
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} ${reason}，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      // 重试循环：允许最多 10 次（≈5分钟）再处理，为短暂断播留余地
      const retryThreshold = isRetryLoop && !stale ? 10 : 1;
      if (newStallCount < retryThreshold) {
        // 更新显示状态为 stalled，但暂不杀进程
        if (task.status !== 'stalled') {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
        return;
      }

      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 自动重启（${reason}）`);
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else {
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
        _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（持续无日志更新，无自动重启）`);
        _record(task, task.status, 'error', 'no_log_update');
      }
    } else if (mtime > 0) {
      // 正常运行，更新活跃时间，清零计数；若之前卡过，恢复为 running
      const statusPatch = ['stalled', 'source_retrying'].includes(task.status) ? ", status='running'" : '';
      db.prepare(`UPDATE tasks SET last_active_at=datetime('now'), stall_count=0, block_count=0${statusPatch} WHERE id=?`).run(task.id);
      if ((task.stall_count || 0) > 0 || ['stalled', 'restarting', 'source_retrying'].includes(task.status)) {
        _notify(task, 'task_recovered', `任务 ${task.name || task.id} 已恢复正常`);
        _record(task, task.status, 'running', 'recovered');
      }
    }
  } catch (err) {
    logError('checkHealth', err);
    // SSH 暂时失败，不改状态
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
