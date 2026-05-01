const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('./ssh');
const taskManager = require('./task-manager');
const platformApi = require('./platform-api');

function dqEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
}

function buildYtDlpCmd(url, userId) {
  const isDouyin = /douyin\.com/i.test(url);
  if (isDouyin) {
    const cookies = getSetting('douyin_cookies', userId) || '';
    if (cookies) {
      return `yt-dlp --no-warnings -g --add-header "Cookie:${dqEsc(cookies)}" "${dqEsc(url)}" 2>/dev/null | grep -m1 '^https\\?://'`;
    }
  }
  return `yt-dlp --no-warnings -g "${dqEsc(url)}" 2>/dev/null | grep -m1 '^https\\?://'`;
}

function buildDouyinVpsCurlCmd(url, userId) {
  const m = url.match(/live\.douyin\.com\/(\d+)/);
  if (!m) return null;
  const roomId = m[1];
  const cookies = getSetting('douyin_cookies', userId) || '';
  const ckEsc = cookies.replace(/'/g, "'\\''");
  const ckHeader = ckEsc ? `-H 'Cookie: ${ckEsc}' ` : '';
  return `curl -s -m 30 -L ` +
    `-H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' ` +
    `-H 'Accept: text/html,*/*' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Referer: https://www.douyin.com/' ` +
    `${ckHeader}'https://live.douyin.com/${roomId}' | ` +
    `python3 -c 'import sys,re; h=sys.stdin.read(); ms=re.search("liveStatus.{0,15}?(normal|end|LIVE|live|Living|NORMAL|init)",h); mn=re.search("\\\\"liveStatus\\\\"\\\\s*:\\\\s*(\\\\d+)",h); sv=ms.group(1) if ms else None; nv=mn.group(1) if mn else None; print("normal" if sv in("normal","LIVE","live","Living","NORMAL") or nv=="2" else "")'`;
}

async function checkLive(channel) {
  const apiResult = await platformApi.checkChannel(channel).catch(() => null);
  if (apiResult !== null) return apiResult.isLive;

  const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(channel.user_id);
  if (!vps) return null;

  try {
    const isDouyinUrl = /live\.douyin\.com\/\d+/.test(channel.url);
    const curlCmd = isDouyinUrl ? buildDouyinVpsCurlCmd(channel.url, channel.user_id) : null;
    const cmd = curlCmd || buildYtDlpCmd(channel.url, channel.user_id);
    const result = await sshService.exec(vps.id, cmd);
    const out = (result.stdout || '').trim();
    return isDouyinUrl ? out === 'normal' : out.startsWith('http');
  } catch (_) {
    return null;
  }
}

async function checkAndUpdate(channel) {
  const wasLive = channel.live_status === 'live';
  const isLive = await checkLive(channel);
  if (isLive === null) return;

  const newStatus = isLive ? 'live' : 'offline';
  db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
    .run(newStatus, channel.id, channel.user_id);

  if (isLive && !wasLive && channel.auto_start && channel.auto_vps_id && channel.auto_stream_key_id) {
    try {
      const sk = db.prepare('SELECT * FROM stream_keys WHERE id=? AND user_id=?').get(channel.auto_stream_key_id, channel.user_id);
      if (!sk) return;

      const running = db.prepare(
        "SELECT id FROM tasks WHERE user_id=? AND source_url=? AND status IN ('running','stalled','restarting','waiting_live')"
      ).get(channel.user_id, channel.url);
      if (running) return;

      const info = db.prepare(
        `INSERT INTO tasks (user_id, name, vps_id, platform, source_url, rtmp_url, stream_key, auto_restart)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(channel.user_id, `[自动] ${channel.name}`, channel.auto_vps_id, sk.platform, channel.url, sk.rtmp_url, sk.stream_key);

      await taskManager.startTaskQueued(info.lastInsertRowid, channel.user_id);
      console.log(`[直播监控] 频道 ${channel.name} 开播，已自动启动任务 #${info.lastInsertRowid}`);
    } catch (e) {
      console.error('[直播监控] 自动启动失败:', e.message);
    }
  }
}

function startLiveMonitor() {
  const intervalMin = parseInt(getSetting('monitor_interval') || '5');
  const interval = intervalMin * 60 * 1000;
  let scanning = false;
  setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try {
      const channels = db.prepare('SELECT * FROM source_channels').all();
      for (const ch of channels) {
        await checkAndUpdate(ch).catch(e => console.error('[直播监控]', e.message));
      }
    } finally {
      scanning = false;
    }
  }, interval);
  console.log(`[直播监控] 已启动，每 ${intervalMin} 分钟自动检测开播状态`);
}

module.exports = { checkLive, checkAndUpdate, startLiveMonitor };
