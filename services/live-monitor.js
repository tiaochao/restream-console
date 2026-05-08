const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('./ssh');
const taskManager = require('./task-manager');
const platformApi = require('./platform-api');

const DOUYIN_CHECK_SCRIPT = '/opt/restream-console/check_douyin.py';

function dqEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
}

function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function getDouyinCookies(userId) {
  return getSetting('douyin_cookies', userId) || '';
}

function buildDouyinCheckCmd(url, userId) {
  const cookies = getDouyinCookies(userId);
  return `python3 ${DOUYIN_CHECK_SCRIPT} ${shSingleQuote(url)} ${shSingleQuote(cookies)}`;
}

function buildYtDlpCmd(url, userId) {
  const isDouyin = /douyin\.com/i.test(url);
  const isBilibili = /live\.bilibili\.com/i.test(url);
  const formatArgs = isBilibili
    ? `-S "vcodec:h264,res,br" -f "best[vcodec^=avc1]/best[vcodec*=h264]/best[vcodec!*=hevc][vcodec!*=h265]"`
    : `-f "best"`;

  if (isDouyin) {
    const cookies = getDouyinCookies(userId);
    const ckArg = cookies ? `--add-header "Cookie:${dqEsc(cookies)}"` : '';
    const hdrs = `--add-header "Referer: https://live.douyin.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`;
    return `yt-dlp --socket-timeout 10 --no-warnings ${ckArg} ${hdrs} ${formatArgs} -g "${dqEsc(url)}" 2>/dev/null | grep -m1 '^https\\?://'`;
  }

  return `yt-dlp --socket-timeout 10 --no-warnings ${formatArgs} -g "${dqEsc(url)}" 2>/dev/null | grep -m1 '^https\\?://'`;
}

async function checkLive(channel) {
  const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(channel.user_id);

  if (/douyin\.com/i.test(channel.url)) {
    if (vps) {
      try {
        const result = await sshService.exec(vps.id, buildDouyinCheckCmd(channel.url, channel.user_id), channel.user_id);
        const out = (result.stdout || '').trim();
        console.log(`[live-monitor] channel ${channel.id} douyin check: ${out}`);
        if (out === 'live') return true;
        if (out === 'offline') return false;
      } catch (e) {
        console.warn(`[live-monitor] channel ${channel.id} douyin check failed: ${e.message}`);
      }
    }

    const apiResult = await platformApi.checkChannel(channel).catch(() => null);
    return apiResult !== null ? apiResult.isLive : null;
  }

  const apiResult = await platformApi.checkChannel(channel).catch(() => null);
  if (apiResult !== null) return apiResult.isLive;

  if (!vps) return null;
  try {
    const result = await sshService.exec(vps.id, buildYtDlpCmd(channel.url, channel.user_id), channel.user_id);
    const out = (result.stdout || '').trim();
    return out.startsWith('http');
  } catch (e) {
    console.warn(`[live-monitor] channel ${channel.id} yt-dlp check failed: ${e.message}`);
    return null;
  }
}

async function ensureAutoStartTask(channel) {
  if (!channel.auto_start) return { started: false, reason: 'auto_start_disabled' };
  const channelName = String(channel.name || '').trim() || `直播间 ${channel.id}`;

  if (!channel.auto_stream_key_id) {
    console.warn(`[live-monitor] channel ${channel.id} auto start skipped: stream key is required`);
    return { started: false, reason: 'stream_key_required' };
  }

  const sk = db.prepare('SELECT * FROM stream_keys WHERE id=? AND user_id=?').get(channel.auto_stream_key_id, channel.user_id);
  if (!sk) {
    console.warn(`[live-monitor] channel ${channel.id} auto start failed: no available stream key`);
    return { started: false, reason: 'stream_key_not_found' };
  }

  const vps = channel.auto_vps_id
    ? db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(channel.auto_vps_id, channel.user_id)
    : (sk.default_vps_id
      ? db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(sk.default_vps_id, channel.user_id)
      : db.prepare(
        "SELECT id FROM vps WHERE user_id=? ORDER BY CASE status WHEN 'online' THEN 0 ELSE 1 END, id LIMIT 1"
      ).get(channel.user_id));
  if (!vps) {
    console.warn(`[live-monitor] channel ${channel.id} auto start failed: no available vps`);
    return { started: false, reason: 'vps_not_found' };
  }

  const active = db.prepare(
    "SELECT id FROM tasks WHERE user_id=? AND source_url=? AND status IN ('running','source_retrying','stalled','target_lost','restarting','waiting_live')"
  ).get(channel.user_id, channel.url);
  if (active) return { started: false, reason: 'active_task_exists', taskId: active.id };

  const info = db.prepare(
    `INSERT INTO tasks (user_id, name, vps_id, platform, source_url, rtmp_url, stream_key, auto_restart)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(channel.user_id, `[Auto] ${channelName}`, vps.id, sk.platform, channel.url, sk.rtmp_url, sk.stream_key);

  await taskManager.startTaskQueued(info.lastInsertRowid, channel.user_id);
  console.log(`[live-monitor] channel ${channel.id} is live, created task #${info.lastInsertRowid}`);
  return { started: true, taskId: info.lastInsertRowid };
}

async function checkAndUpdate(channel) {
  const wasLive = channel.live_status === 'live';
  const isLive = await checkLive(channel);

  if (isLive === null) {
    if (wasLive) {
      db.prepare("UPDATE source_channels SET live_status='unknown', last_check=datetime('now') WHERE id=? AND user_id=?")
        .run(channel.id, channel.user_id);
    }
    return { checked: true, live: null };
  }

  const newStatus = isLive ? 'live' : 'offline';
  db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
    .run(newStatus, channel.id, channel.user_id);

  let autoStart = { started: false, reason: 'not_live' };
  if (isLive) {
    try {
      autoStart = await ensureAutoStartTask(channel);
      if (autoStart.started && wasLive) {
        console.log(`[live-monitor] channel ${channel.id} was already live, backfilled task #${autoStart.taskId}`);
      }
    } catch (e) {
      console.error(`[live-monitor] channel ${channel.id} auto start failed: ${e.message}`);
      autoStart = { started: false, reason: 'error', error: e.message };
    }
  }

  return { checked: true, live: isLive, status: newStatus, autoStart };
}

function startLiveMonitor() {
  const intervalMin = parseInt(getSetting('monitor_interval') || '5');
  const interval = intervalMin * 60 * 1000;
  let scanning = false;

  const scanOnce = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const channels = db.prepare('SELECT * FROM source_channels').all();
      for (const ch of channels) {
        await checkAndUpdate(ch).catch(e => console.error('[live-monitor]', e.message));
      }
    } finally {
      scanning = false;
    }
  };

  setTimeout(scanOnce, 5000);
  setInterval(scanOnce, interval);
  console.log(`[live-monitor] started, interval ${intervalMin} minute(s)`);
}

module.exports = { checkLive, checkAndUpdate, ensureAutoStartTask, startLiveMonitor };
