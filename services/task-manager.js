const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('./ssh');
const { resolveDouyinStreamUrl } = require('./platform-api');

const PLATFORM_RTMP = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  tiktok:  'rtmp://push.tiktokv.com/live',
};

let startQueue = Promise.resolve();

function cookiesToNetscape(cookieStr) {
  const lines = ['# Netscape HTTP Cookie File'];
  cookieStr.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.substring(0, idx).trim();
    const value = part.substring(idx + 1).trim();
    if (!name) return;
    lines.push(`.douyin.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
  });
  return lines.join('\n');
}

// Escape a string for use inside a double-quoted shell argument.
// Prevents injection via $, backticks, \, or " in user-controlled values.
function dqEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
}

function buildCommand(task) {
  const dest = `${dqEsc(task.rtmp_url)}/${dqEsc(task.stream_key)}`;
  const logFile = `/tmp/restream_${task.id}.log`;

  let inner;
  if (task.source_url.startsWith('/')) {
    // 媒体库文件：循环推送，不需要重新解析
    inner = `ffmpeg -stream_loop -1 -re -i "${dqEsc(task.source_url)}" -c:v copy -c:a copy -f flv "${dest}"`;
  } else {
    // 网络直播：循环解析直链 + 推流（直链过期或 ffmpeg 退出后自动重新获取）
    const isDouyin = /douyin\.com/i.test(task.source_url);
    const ckArg   = task._douyinCookieFile ? `--cookies "${task._douyinCookieFile}"` : '';
    const ytHdrs  = isDouyin
      ? `--add-header "Referer: https://live.douyin.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`
      : '';
    const ffmpegHdrs = isDouyin
      ? `-headers "Referer: https://live.douyin.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\n"`
      : '';

    const allUrls = [task.source_url];
    if (task.backup_urls) {
      task.backup_urls.split('\n').forEach(u => { u = u.trim(); if (u) allUrls.push(u); });
    }
    const urlsArr = allUrls.map(u => `"${dqEsc(u)}"`).join(' ');

    // 如果 API 已解析出直链，第一次优先使用它（更快），之后循环用 yt-dlp 续期
    const firstUrl = task._resolvedStreamUrl ? dqEsc(task._resolvedStreamUrl) : '';

    inner = [
      `_FIRST=1`,
      `while true; do`,
      `  if [ "$_FIRST" = "1" ] && [ -n "${firstUrl}" ]; then`,
      `    STREAM_URL="${firstUrl}"`,
      `    echo "[直链-API] ${firstUrl.substring(0, 80)}..."`,
      `    _FIRST=0`,
      `  else`,
      `    STREAM_URL=""`,
      `    for _SRC in ${urlsArr}; do`,
      `      STREAM_URL=$(yt-dlp --no-warnings ${ckArg} ${ytHdrs} -f "best" -g "$_SRC" 2>/dev/null | grep -m1 '^https\\?://')`,
      `      if [ -n "$STREAM_URL" ]; then echo "[yt-dlp] 使用源: $_SRC"; break; fi`,
      `    done`,
      `  fi`,
      `  if [ -z "$STREAM_URL" ]; then echo "[错误] 无法获取直链，15s 后重试..."; sleep 15; continue; fi`,
      `  echo "[推流] $STREAM_URL"`,
      `  ffmpeg -re ${ffmpegHdrs} -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i "$STREAM_URL" -c:v copy -c:a copy -f flv "${dest}" || true`,
      `  echo "[退出] ffmpeg 退出，3s 后重新获取直链..."`,
      `  sleep 3`,
      `done`,
    ].join('\n');
  }

  const scriptB64 = Buffer.from(inner).toString('base64');
  return { cmd: `nohup bash -c "$(echo '${scriptB64}' | base64 -d)" > ${logFile} 2>&1 & echo $!`, logFile };
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
    const cookies = getSetting('douyin_cookies', ownerId);

    // 1) 检测是否正在直播
    let isLive = true; // 默认乐观，检测失败时直接尝试推流
    try {
      let liveResult = null;
      if (isDouyin)   liveResult = await checkDouyin(task.source_url, cookies);
      if (isBilibili) liveResult = await checkBilibili(task.source_url);
      if (isKuaishou) liveResult = await checkKuaishou(task.source_url);
      if (liveResult && liveResult.isLive === false) isLive = false;
    } catch (_) {}

    if (!isLive) {
      console.log(`[任务${taskId}] 主播未开播，进入等待直播状态`);
      db.prepare("UPDATE tasks SET status='waiting_live', remote_pid=NULL WHERE id=?").run(taskId);
      return null;
    }

    // 2) 抖音额外处理：API 解析直链 / streamlink 兜底
    if (isDouyin) {
      try {
        const resolved = await resolveDouyinStreamUrl(task.source_url, cookies);
        if (resolved && resolved.url) {
          task._resolvedStreamUrl = resolved.url;
          console.log(`[任务${taskId}] 抖音流地址(${resolved.protocol}): ${resolved.url.substring(0, 60)}...`);
        }
      } catch (_) {}

      // 3) API 失败：用 streamlink + cookies
      if (!task._resolvedStreamUrl) {
        if (!cookies) throw new Error('抖音任务需要配置 Cookie（设置页面）');
        const ckFile = `/tmp/dy_ck_${taskId}.txt`;
        // Write cookie via base64 to avoid heredoc delimiter injection
        const cookiesB64 = Buffer.from(cookies).toString('base64');
        await sshService.exec(task.vps_id,
          `echo ${cookiesB64} | base64 -d > ${ckFile}`
        );
        task._douyinCookieFile = ckFile;
        console.log(`[任务${taskId}] API 无直链，将用 streamlink + cookies: ${ckFile}`);
      }
    }
  }

  const { cmd, logFile } = buildCommand(task);
  const result = await sshService.exec(task.vps_id, cmd);
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
    try {
      await startTask(taskId, userId);
    } catch (e) {
      console.error(`[队列启动] 任务 ${taskId} 失败:`, e.message);
      // 启动失败时标记为 error，避免永远卡在 restarting
      db.prepare(`UPDATE tasks SET status='error', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
        .run(...(userId ? [taskId, userId] : [taskId]));
    }
    const delay = parseInt(getSetting('start_delay', userId || undefined) || '5') * 1000;
    await new Promise(r => setTimeout(r, delay));
  });
  return startQueue;
}

async function stopTask(taskId, userId = null) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? ${userId ? 'AND user_id=?' : ''}`)
    .get(...(userId ? [taskId, userId] : [taskId]));
  if (!task) throw new Error('任务不存在');

  if (task.remote_pid && task.vps_id) {
    await sshService.exec(
      task.vps_id,
      `pkill -P ${task.remote_pid} 2>/dev/null; kill ${task.remote_pid} 2>/dev/null; true`
    ).catch(() => {});
  }
  db.prepare(`UPDATE tasks SET status='stopped', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
    .run(...(userId ? [taskId, userId] : [taskId]));
}

// 健康检测：进程存活 + 日志文件活跃度 + 验证码检测
async function checkHealth(task) {
  if (!task.remote_pid || !task.vps_id) return;

  const stallTimeout = parseInt(getSetting('stall_timeout', task.user_id) || '120');
  const blockLimit   = parseInt(getSetting('block_limit', task.user_id)   || '8');

  try {
    // 一次 SSH 同时检查进程存活 + 日志 mtime + 日志末尾（检测验证码关键词）
    const cmd = [
      `kill -0 ${task.remote_pid} 2>/dev/null && echo alive || echo dead`,
      `stat -c %Y ${task.log_file} 2>/dev/null || echo 0`,
      `tail -3 ${task.log_file} 2>/dev/null | tr '\\n' '|' || echo ''`,
    ].join('; ');

    const result = await sshService.exec(task.vps_id, cmd);
    const lines = result.stdout.trim().split('\n');
    const procStatus = lines[0]?.trim();
    const mtime = parseInt(lines[1]?.trim() || '0');
    const logTail  = (lines[2] || '').toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    const stale = mtime > 0 && (now - mtime) > stallTimeout;

    // 检测抖音验证码特征词（streamlink 报错时会出现）
    const isBlocked = /captcha|challenge|forbidden|403|verify|banned/i.test(logTail);
    if (isBlocked) {
      const newBlockCount = (task.block_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到验证码/封锁，block_count=${newBlockCount}`);
      db.prepare('UPDATE tasks SET block_count=? WHERE id=?').run(newBlockCount, task.id);

      if (newBlockCount >= blockLimit) {
        console.error(`[健康监控] 任务 ${task.id} 连续 ${newBlockCount} 次被封，自动停止（IP 可能被封）`);
        await stopTask(task.id).catch(() => {});
        db.prepare("UPDATE tasks SET status='blocked', remote_pid=NULL WHERE id=?").run(task.id);
        return;
      }
    }

    // 检测 RTMP 推流目标断开（YouTube/TikTok 主动断流、推流码失效等）
    // FFmpeg 遇到这类错误会在日志中留下特征词，连续出现说明一直在重连而推不上去
    const isRtmpError = /failed to update header|broken pipe|connection reset|rtmp.*error|error.*rtmp|av_interleaved_write_frame.*-32|end of file|error muxing a packet/i.test(logTail);
    if (isRtmpError) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到 RTMP 推流错误（可能目标端断流），stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);
      // 允许短暂断流重试（最多 3 次 ≈ 90s），超过则停止
      if (newStallCount >= 3) {
        console.error(`[健康监控] 任务 ${task.id} RTMP 持续报错，自动停止`);
        await stopTask(task.id).catch(() => {});
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
        return;
      }
      if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
      }
      return;
    }

    // 检测 yt-dlp 无法获取直链的重试循环（脚本还活着但推流已停止）
    const logLines = logTail.split('|');
    const retryErrLines = logLines.filter(l => l.includes('无法获取直链'));
    const isRetryLoop = retryErrLines.length >= 2; // 最近 3 行中 ≥2 行是重试错误

    if (procStatus === 'dead') {
      // 进程已死
      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 进程已死，自动重启`);
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
      } else {
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
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
        }
        return;
      }

      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 自动重启（${reason}）`);
        await stopTask(task.id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
      } else {
        await stopTask(task.id).catch(() => {});
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
      }
    } else if (mtime > 0) {
      // 正常运行，更新活跃时间，清零计数；若之前卡过，恢复为 running
      const statusPatch = task.status === 'stalled' ? ", status='running'" : '';
      db.prepare(`UPDATE tasks SET last_active_at=datetime('now'), stall_count=0, block_count=0${statusPatch} WHERE id=?`).run(task.id);
    }
  } catch (_) {
    // SSH 暂时失败，不改状态
  }
}

// 定期 ping 所有 VPS，自动更新在线状态
async function checkAllVpsStatus() {
  const vpsList = db.prepare('SELECT * FROM vps').all();
  for (const vps of vpsList) {
    try {
      sshService.disconnect(vps.id); // 每次用新连接，避免 isConnected() 误报
      await new Promise(r => setTimeout(r, 200));
      const ssh = await sshService.connect(vps.id);
      const r = await ssh.execCommand('echo ok');
      if (r.stdout.trim() === 'ok') {
        db.prepare("UPDATE vps SET status='online', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      } else {
        db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      }
    } catch (_) {
      db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      sshService.disconnect(vps.id);
    }
  }
}

function startMonitor() {
  // 任务健康检测：每 30s（running + stalled）
  setInterval(async () => {
    const active = db.prepare(
      "SELECT * FROM tasks WHERE status IN ('running','stalled')"
    ).all();
    for (const task of active) {
      await checkHealth(task).catch(() => {});
    }
  }, 30 * 1000);

  // 等待直播监控：每 60s 检查 waiting_live 任务，开播则自动启动
  setInterval(async () => {
    const waiting = db.prepare(
      "SELECT * FROM tasks WHERE status='waiting_live'"
    ).all();
    for (const task of waiting) {
      await checkAndStartIfLive(task).catch(() => {});
    }
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
  const { getSetting: getS } = require('../db');
  const url = task.source_url;

  const isDouyin   = /douyin\.com/i.test(url);
  const isBilibili = /live\.bilibili\.com/i.test(url);
  const isKuaishou = /live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(url);
  if (!isDouyin && !isBilibili && !isKuaishou) return;

  try {
    let result = null;
    if (isDouyin)   result = await checkDouyin(url, getS('douyin_cookies', task.user_id) || '');
    if (isBilibili) result = await checkBilibili(url);
    if (isKuaishou) result = await checkKuaishou(url);

    if (result && result.isLive) {
      console.log(`[等待直播] 任务 ${task.id} 检测到开播，自动启动`);
      startTaskQueued(task.id, task.user_id);
    }
  } catch (_) {}
}

module.exports = { startTask, startTaskQueued, stopTask, checkHealth, startMonitor, PLATFORM_RTMP, checkAndStartIfLive };
