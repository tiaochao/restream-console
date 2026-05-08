const { isYoutubeTarget } = require('./ffmpeg-args');

function buildHealthCheckCmd(task) {
  return [
    `kill -0 ${task.remote_pid} 2>/dev/null && echo alive || echo dead`,
    `stat -c %Y ${task.log_file} 2>/dev/null || echo 0`,
    `cat /tmp/restream_${task.id}.status 2>/dev/null || echo '{}'`,
    `if ! command -v ss >/dev/null 2>&1; then echo rtmp_unknown; else _RTMP_HIT=0; _PIDS="${task.remote_pid}"; _SID=$(ps -o sid= -p ${task.remote_pid} 2>/dev/null | tr -d ' '); if [ -n "$_SID" ]; then _PIDS="$(ps -o pid= -g "$_SID" 2>/dev/null | tr '\\n' ' ')"; elif command -v pgrep >/dev/null 2>&1; then _SCAN="${task.remote_pid}"; while [ -n "$_SCAN" ]; do _NEXT=""; for _PP in $_SCAN; do for _CP in $(pgrep -P "$_PP" 2>/dev/null); do _PIDS="$_PIDS $_CP"; _NEXT="$_NEXT $_CP"; done; done; _SCAN="$_NEXT"; done; fi; for _P in $_PIDS; do ss -tnp 2>/dev/null | grep -E ':(1935|443) ' | grep -q "pid=$_P," && _RTMP_HIT=1; done; [ "$_RTMP_HIT" = "1" ] && echo rtmp_connected || echo no_rtmp; fi`,
  ].join('; ');
}

function parseHealthResult(task, sshLines, now, stallTimeout) {
  const procStatus = sshLines[0]?.trim();
  const mtime = parseInt(sshLines[1]?.trim() || '0');
  const rtmpStatus = sshLines[3]?.trim() || 'rtmp_unknown';
  const stale = mtime > 0 && (now - mtime) > stallTimeout;

  let statusJson = {};
  try {
    const raw = (sshLines[2] || '{}').trim();
    statusJson = JSON.parse(raw);
  } catch (_) {}

  const jsState    = statusJson.state    || 'unknown';
  const jsSource   = statusJson.source   || 'unknown';
  const jsTarget   = statusJson.target   || 'unknown';
  const jsFallback = statusJson.fallback === true;

  const isFallbackActive     = jsFallback === true || jsState === 'fallback';
  const isRetryLoop          = jsState === 'source_retry' || jsSource === 'retry';
  const isSourceOffline      = jsSource === 'offline' || jsState === 'source_offline';
  const isSourceUnavailable  = isSourceOffline;
  const isTargetLost         = jsState === 'target_lost' || jsTarget === 'lost';
  const isExpiredDirectUrl   = jsState === 'expired';
  const isFfmpegNoStreamError = jsState === 'idle' && procStatus !== 'dead' && mtime > 0 && (now - mtime) < 30;

  const isLiveSource = !task.source_url.startsWith('/') &&
    /douyin\.com|live\.bilibili\.com|live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);

  const expectsRtmp1935 = /^rtmp:\/\//i.test(String(task.rtmp_url || ''));
  const isYoutubeRtmpMissing = isYoutubeTarget(task) && expectsRtmp1935 && procStatus !== 'dead' && rtmpStatus === 'no_rtmp';
  const isTargetStatus   = task.status === 'target_lost';
  const isBlocked        = false;
  const isRtmpError      = jsTarget === 'lost' && procStatus !== 'dead' && !jsFallback;
  const hasHealthyFrameAfterErrors = jsState === 'streaming';

  return {
    procStatus, mtime, statusJson, rtmpStatus, stale, now,
    isFallbackActive, isRetryLoop, isSourceOffline, isSourceUnavailable,
    isTargetLost, isExpiredDirectUrl, isFfmpegNoStreamError, isLiveSource,
    isYoutubeRtmpMissing, isTargetStatus, isBlocked, isRtmpError,
    hasHealthyFrameAfterErrors,
  };
}

function evaluateHealth(task, parsed, { blockLimit }) {
  const {
    procStatus, mtime, stale, now,
    isFallbackActive, isRetryLoop, isSourceOffline, isSourceUnavailable,
    isTargetLost, isExpiredDirectUrl, isFfmpegNoStreamError, isLiveSource,
    isYoutubeRtmpMissing, isTargetStatus, isBlocked, isRtmpError,
    hasHealthyFrameAfterErrors,
  } = parsed;

  function stall(newStallCount) {
    if (task.status !== 'stalled') {
      return { action: 'stall', newStatus: 'stalled', newStallCount,
        newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
        notifyType: 'task_stalled', notifyMsg: `任务 ${task.name || task.id} 已掉线，请检查推流状态`,
        eventToStatus: 'stalled', eventReason: 'stream_stalled', logMsg: null };
    }
    return { action: 'stall', newStatus: null, newStallCount,
      newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg: null };
  }

  function restart(newStallCount, logMsg) {
    return { action: 'restart', newStatus: null, newStallCount,
      newBlockCount: null, clearPid: false, requiresStop: true, requiresRestart: true,
      notifyType: 'task_restarting', notifyMsg: `任务 ${task.name || task.id} 自动重启中`,
      eventToStatus: 'restarting', eventReason: 'auto_restart', logMsg };
  }

  // Branch 1: ffmpeg 无流输出
  if (isFfmpegNoStreamError && !hasHealthyFrameAfterErrors) {
    const newStallCount = (task.stall_count || 0) + 1;
    const logMsg = `[health] task ${task.id} ffmpeg output has no streams, restarting to rebuild command, stall=${newStallCount}`;
    if (newStallCount >= 1) {
      return restart(newStallCount, logMsg);
    }
    return { ...stall(newStallCount), logMsg };
  }

  // Branch 2: 直链过期 + 直播源
  if (procStatus !== 'dead' && isExpiredDirectUrl && isLiveSource) {
    const newStallCount = (task.stall_count || 0) + 1;
    const logMsg = `[health] task ${task.id} source direct url expired, stall=${newStallCount}`;
    if (isFallbackActive) {
      return { action: 'setRunning', newStatus: 'running', newStallCount,
        newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
        notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg };
    }
    return { action: 'setStatus', newStatus: 'source_retrying', newStallCount,
      newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg };
  }

  // Branch 3: 重试循环 + 直播源
  if (procStatus !== 'dead' && isRetryLoop && isLiveSource) {
    const newStallCount = (task.stall_count || 0) + 1;
    return { action: 'setStatus', newStatus: 'source_retrying', newStallCount,
      newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null,
      logMsg: `[健康监控] 任务 ${task.id} 正在重试解析直播源，stall=${newStallCount}` };
  }

  // Branch 4: 目标 RTMP 断开
  if (isTargetLost || isTargetStatus) {
    const newStallCount = (task.stall_count || 0) + 1;
    const logMsg = `[health] task ${task.id} target RTMP disconnected, stall=${newStallCount}`;
    if (newStallCount >= 2 || isTargetStatus) {
      if (task.auto_restart) {
        return restart(newStallCount, logMsg);
      }
      return { action: 'error_stop', newStatus: 'target_lost', newStallCount,
        newBlockCount: null, clearPid: true, requiresStop: true, requiresRestart: false,
        notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg };
    }
    return { action: 'target_lost_warn', newStatus: 'target_lost', newStallCount,
      newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg };
  }

  // Branch 5: YouTube RTMP 缺失
  if (isYoutubeRtmpMissing && !isRetryLoop && !isExpiredDirectUrl && !isSourceUnavailable) {
    const newStallCount = (task.stall_count || 0) + 1;
    const warnLogMsg = `[健康监控] 任务 ${task.id} 未检测到 YouTube RTMP 连接，stall=${newStallCount}`;
    if (newStallCount >= 2) {
      if (task.auto_restart) {
        return restart(newStallCount, `${warnLogMsg}\n[健康监控] 任务 ${task.id} YouTube RTMP 连接丢失，自动重启`);
      }
      return { ...stall(newStallCount), logMsg: warnLogMsg, newStallCount };
    }
    return { ...stall(newStallCount), logMsg: warnLogMsg, newStallCount };
  }

  // Branch 6: 直播源不可用
  if (procStatus !== 'dead' && isSourceUnavailable && isLiveSource) {
    const newStallCount = (task.stall_count || 0) + 1;
    const logMsg = `[健康监控] 任务 ${task.id} 直播源不可用，stall=${newStallCount}`;
    if (isFallbackActive) {
      return { action: 'setRunning', newStatus: 'running', newStallCount,
        newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: false,
        notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg };
    }
    if (!isSourceOffline || newStallCount < 2) {
      return { ...stall(newStallCount), logMsg, newStallCount };
    }
    return { action: 'waiting_live', newStatus: 'waiting_live', newStallCount: 0,
      newBlockCount: null, clearPid: true, requiresStop: true, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null,
      logMsg: `${logMsg}\n[健康监控] 任务 ${task.id} 直播源持续不可用，进入等待开播` };
  }

  // Branch 7: 验证码/封锁
  if (isBlocked) {
    const newBlockCount = (task.block_count || 0) + 1;
    const warnLogMsg = `[健康监控] 任务 ${task.id} 检测到验证码/封锁，block_count=${newBlockCount}`;
    if (newBlockCount >= blockLimit) {
      return { action: 'blocked', newStatus: 'blocked', newStallCount: null, newBlockCount,
        clearPid: true, requiresStop: true, requiresRestart: false,
        notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null,
        logMsg: `[健康监控] 任务 ${task.id} 连续 ${newBlockCount} 次被封，自动停止（IP 可能被封）` };
    }
    return { action: 'blocked_warn', newStatus: null, newStallCount: null, newBlockCount,
      clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg: warnLogMsg };
  }

  // Branch 8: RTMP 推流错误
  if (isRtmpError) {
    const newStallCount = (task.stall_count || 0) + 1;
    const warnLogMsg = `[健康监控] 任务 ${task.id} 检测到 RTMP 推流错误（可能目标端断流），stall=${newStallCount}`;
    if (newStallCount >= 3) {
      if (task.auto_restart) {
        return restart(newStallCount, `${warnLogMsg}\n[健康监控] 任务 ${task.id} RTMP 持续报错，自动重启`);
      }
      return { action: 'error_stop', newStatus: 'error', newStallCount,
        newBlockCount: null, clearPid: true, requiresStop: true, requiresRestart: false,
        notifyType: 'task_error', notifyMsg: `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`,
        eventToStatus: 'error', eventReason: 'process_died',
        logMsg: `${warnLogMsg}\n[健康监控] 任务 ${task.id} RTMP 持续报错，自动停止` };
    }
    return { ...stall(newStallCount), logMsg: warnLogMsg, newStallCount };
  }

  // Branch 9: 进程已死
  if (procStatus === 'dead') {
    if (task.auto_restart) {
      return { action: 'restart', newStatus: null, newStallCount: null,
        newBlockCount: null, clearPid: false, requiresStop: false, requiresRestart: true,
        notifyType: 'task_restarting', notifyMsg: `任务 ${task.name || task.id} 自动重启中`,
        eventToStatus: 'restarting', eventReason: 'auto_restart',
        logMsg: `[健康监控] 任务 ${task.id} 进程已死，自动重启` };
    }
    return { action: 'error_stop', newStatus: 'error', newStallCount: null,
      newBlockCount: null, clearPid: true, requiresStop: false, requiresRestart: false,
      notifyType: 'task_error', notifyMsg: `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`,
      eventToStatus: 'error', eventReason: 'process_died', logMsg: null };
  }

  // Branch 10: 日志过期或重试中
  if (stale || isRetryLoop) {
    const reason = stale ? `日志 ${now - mtime}s 无更新` : '无法获取直链';
    const newStallCount = (task.stall_count || 0) + 1;
    const logMsg = `[健康监控] 任务 ${task.id} ${reason}，stall=${newStallCount}`;
    const retryThreshold = isRetryLoop && !stale ? 10 : 1;
    if (newStallCount < retryThreshold) {
      return { ...stall(newStallCount), logMsg, newStallCount };
    }
    if (task.auto_restart) {
      return restart(newStallCount, `${logMsg}\n[健康监控] 任务 ${task.id} 自动重启（${reason}）`);
    }
    return { action: 'error_stop', newStatus: 'error', newStallCount,
      newBlockCount: null, clearPid: true, requiresStop: true, requiresRestart: false,
      notifyType: 'task_error', notifyMsg: `任务 ${task.name || task.id} 已停止（持续无日志更新，无自动重启）`,
      eventToStatus: 'error', eventReason: 'no_log_update', logMsg };
  }

  // Branch 11: mtime > 0，健康运行
  if (mtime > 0) {
    return { action: 'recover', newStatus: null, newStallCount: 0, newBlockCount: 0,
      clearPid: false, requiresStop: false, requiresRestart: false,
      notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg: null };
  }

  // 默认：mtime === 0，无操作
  return { action: 'noOp', newStatus: null, newStallCount: null, newBlockCount: null,
    clearPid: false, requiresStop: false, requiresRestart: false,
    notifyType: null, notifyMsg: null, eventToStatus: null, eventReason: null, logMsg: null };
}

module.exports = { buildHealthCheckCmd, parseHealthResult, evaluateHealth };
