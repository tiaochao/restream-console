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

function buildCommand(task) {
  const dest = `${task.rtmp_url}/${task.stream_key}`;
  const logFile = `/tmp/restream_${task.id}.log`;
  const ffmpegEncode = `-c:v libx264 -preset veryfast -b:v 6000k -maxrate 6500k -bufsize 12000k -c:a aac -b:a 192k -max_interleave_delta 0`;

  let inner;
  if (task.source_url.startsWith('/')) {
    // 媒体库文件：循环推送
    inner = `ffmpeg -stream_loop -1 -re -i "${task.source_url}" -c:v copy -c:a copy -f flv "${dest}"`;

  } else if (task._resolvedStreamUrl) {
    // 平台 API 已解析出直链（抖音等），直接给 FFmpeg
    // HLS 源：用 -re 保持直播时序；FLV 源：不加 -re，让 FFmpeg 按实际速率读
    const isHls = task._resolvedStreamUrl.includes('.m3u8');
    const reFlag = isHls ? '-re' : '';
    // 抖音 CDN 需要 Referer 和 UA，否则返回 403 拒绝访问
    const isDouyin = /douyincdn\.com|douyin\.com/i.test(task._resolvedStreamUrl);
    const hdrs = isDouyin
      ? `-headers "Referer: https://live.douyin.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\\r\\n"`
      : '';
    const ffmpegCmd = [
      `ffmpeg`, reFlag, hdrs,
      `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10`,
      `-i "${task._resolvedStreamUrl}"`,
      ffmpegEncode,
      `-f flv "${dest}"`,
    ].filter(Boolean).join(' ');
    inner = [
      `echo "[直链-${isHls ? 'HLS' : 'FLV'}] ${task._resolvedStreamUrl.substring(0, 80)}..."`,
      ffmpegCmd,
    ].join('; ');

  } else if (task._douyinCookieFile) {
    // 抖音直播：streamlink 获取直链，再由 FFmpeg 直连（避免 pipe:0 空管道错误）
    // 用 Python 解析 cookie 文件并传 --http-cookie 参数（streamlink 无 --http-cookie-file 选项）
    const srcUrl = task.source_url;
    const ckFile = task._douyinCookieFile;
    const logFile = `/tmp/sl_${task.id}.log`;
    const douyinHdrs = `-headers "Referer: https://live.douyin.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\\r\\n"`;
    const pyCmd = `python3 -c "import subprocess,sys; ck=open('${ckFile}').read(); args=['streamlink','--stream-url']+sum([['--http-cookie',c.strip()] for c in ck.split(';') if c.strip() and '=' in c.strip()],[])+['${srcUrl}','best']; r=subprocess.run(args,capture_output=True,text=True); open('${logFile}','w').write(r.stderr); print(r.stdout.strip(),end='')"`;
    inner = [
      `echo "[streamlink] 获取抖音直链: ${srcUrl}"`,
      `SL_URL=$(${pyCmd})`,
      `if [ -z "$SL_URL" ]; then echo "[错误] streamlink 获取直链失败，原因如下:"; cat ${logFile}; exit 1; fi`,
      `echo "[streamlink] 直链: $SL_URL"`,
      `ffmpeg -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 ${douyinHdrs} -i "$SL_URL" ${ffmpegEncode} -f flv "${dest}"`,
    ].join('; ');

  } else {
    // 通用：yt-dlp 提取直链（YouTube / B站 / 快手 / 其他平台）
    // -reconnect 保证 HLS 直播流断流后自动重连
    const allUrls = [task.source_url];
    if (task.backup_urls) {
      task.backup_urls.split('\n').forEach(u => { u = u.trim(); if (u) allUrls.push(u); });
    }
    if (allUrls.length === 1) {
      inner = [
        `STREAM_URL=$(yt-dlp --no-warnings -f "best" -g "${task.source_url}" | head -1)`,
        `echo "[yt-dlp] 直链: $STREAM_URL"`,
        `if [ -z "$STREAM_URL" ]; then echo "[错误] yt-dlp 提取失败"; exit 1; fi`,
        `ffmpeg -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i "$STREAM_URL" ${ffmpegEncode} -f flv "${dest}"`,
      ].join('; ');
    } else {
      const urlsArr = allUrls.map(u => `"${u.replace(/"/g, '\\"')}"`).join(' ');
      inner = [
        `STREAM_URL=""`,
        `for _SRC in ${urlsArr}; do STREAM_URL=$(yt-dlp --no-warnings -f "best" -g "$_SRC" 2>/dev/null | head -1); if [ -n "$STREAM_URL" ]; then echo "[yt-dlp] 使用源: $_SRC"; break; fi; done`,
        `if [ -z "$STREAM_URL" ]; then echo "[错误] 所有源均提取失败"; exit 1; fi`,
        `echo "[yt-dlp] 直链: $STREAM_URL"`,
        `ffmpeg -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -i "$STREAM_URL" ${ffmpegEncode} -f flv "${dest}"`,
      ].join('; ');
    }
  }

  return { cmd: `nohup bash -c '${inner}' > ${logFile} 2>&1 & echo $!`, logFile };
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
        // 写原始 cookie 字符串（key1=val1; key2=val2），供 buildCommand 用 Python 解析
        await sshService.exec(task.vps_id,
          `python3 -c "import sys; open('${ckFile}','w').write(sys.stdin.read())" <<'__EOFC__'\n${cookies}\n__EOFC__`
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

    if (stale) {
      // 进程活着但日志停止写入（拉流卡死）
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} 日志 ${now - mtime}s 无更新，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 自动重启（卡死）`);
        await stopTask(task.id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
      } else {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
      }
    } else if (mtime > 0) {
      // 正常运行，更新活跃时间，清零计数
      db.prepare("UPDATE tasks SET last_active_at=datetime('now'), stall_count=0, block_count=0 WHERE id=?").run(task.id);
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
