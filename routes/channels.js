const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('../services/ssh');
const platformApi = require('../services/platform-api');
const { ensureAutoStartTask } = require('../services/live-monitor');

const TITLE = '频道监控 - 转推控制台';
const DOUYIN_CHECK_SCRIPT = '/opt/restream-console/check_douyin.py';
const syncedDouyinHelpers = new Set();

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function dqEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
}

function getDouyinCookies(userId) {
  return getSetting('douyin_cookies', userId) || '';
}

function normalizeChannelUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return raw;

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    const u = new URL(withProtocol);
    const host = u.hostname.toLowerCase();

    if (host === 'live.douyin.com') {
      const roomId = u.pathname.match(/\/(\d+)/)?.[1];
      if (roomId) return `https://live.douyin.com/${roomId}`;
    }

    if (/douyin\.com$/i.test(host)) {
      const secUserId = u.pathname.match(/\/user\/([A-Za-z0-9_\-]+)/)?.[1];
      if (secUserId) return `https://www.douyin.com/user/${secUserId}`;
      u.search = '';
      u.hash = '';
      return u.toString();
    }

    if (host === 'live.bilibili.com') {
      const roomId = u.pathname.match(/\/(?:h5\/)?(\d+)/)?.[1];
      if (roomId) return `https://live.bilibili.com/${roomId}`;
    }

    if (/kuaishou\.com$/i.test(host)) {
      u.search = '';
      u.hash = '';
      return u.toString();
    }

    u.hash = '';
    return u.toString();
  } catch (_) {
    return raw;
  }
}

function inferPlatform(url, explicitPlatform) {
  const value = String(url || '').toLowerCase();
  if (value.includes('douyin.com')) return 'douyin';
  if (value.includes('live.bilibili.com')) return 'bilibili';
  if (value.includes('kuaishou.com')) return 'kuaishou';
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube';
  if (value.includes('tiktok.com')) return 'tiktok';
  return explicitPlatform || 'custom';
}

function fallbackChannelName(platform, url) {
  const label = {
    douyin: '抖音直播间',
    bilibili: 'B站直播间',
    kuaishou: '快手直播间',
    youtube: 'YouTube 频道',
    tiktok: 'TikTok 频道',
    custom: '直播频道',
  }[platform] || '直播频道';

  try {
    const u = new URL(url);
    const id = u.pathname.split('/').filter(Boolean).pop();
    return id ? `${label} ${id.slice(-12)}` : label;
  } catch (_) {
    return label;
  }
}

async function resolveChannelMeta({ name, platform, url, userId }) {
  let cleanUrl = normalizeChannelUrl(url);
  const finalPlatform = inferPlatform(cleanUrl, platform || 'douyin');
  let finalName = String(name || '').trim().slice(0, 120);

  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('请输入有效的直播间或账号主页 URL');
  }

  if (!finalName && /douyin\.com/i.test(cleanUrl)) {
    try {
      const info = await platformApi.getDouyinChannelInfo(cleanUrl, getDouyinCookies(userId));
      if (info?.url) cleanUrl = normalizeChannelUrl(info.url);
      if (info?.name) finalName = String(info.name).trim().slice(0, 120);
    } catch (_) {}
  }

  if (!finalName) finalName = fallbackChannelName(finalPlatform, cleanUrl);
  return { name: finalName, platform: finalPlatform, url: cleanUrl };
}

function getFormData(userId) {
  return {
    vpsList: db.prepare('SELECT id, name FROM vps WHERE user_id=? ORDER BY name').all(userId),
    streamKeys: db.prepare('SELECT id, name, platform, default_vps_id FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(userId),
  };
}

function getChannels(userId) {
  return db.prepare(`
    SELECT c.*,
      v.name as vps_name,
      sk.name as sk_name
    FROM source_channels c
    LEFT JOIN vps v ON c.auto_vps_id = v.id AND v.user_id = c.user_id
    LEFT JOIN stream_keys sk ON c.auto_stream_key_id = sk.id AND sk.user_id = c.user_id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId);
}

function findExistingChannel(userId, url, excludeId = null) {
  if (excludeId) {
    return db.prepare('SELECT id, name FROM source_channels WHERE user_id=? AND url=? AND id<>?')
      .get(userId, url, excludeId);
  }
  return db.prepare('SELECT id, name FROM source_channels WHERE user_id=? AND url=?')
    .get(userId, url);
}

function renderChannels(req, res, { status = 200, error = null } = {}) {
  return res.status(status).render('channels', {
    title: TITLE,
    currentPath: '/channels',
    channels: getChannels(req.session.userId),
    error,
    ...getFormData(req.session.userId),
  });
}

function validateOwnedOptional(table, id, userId) {
  if (!id) return null;
  const row = db.prepare(`SELECT id FROM ${table} WHERE id=? AND user_id=?`).get(id, userId);
  if (!row) return false;
  return row.id;
}

function pickAutoStartStreamKey(userId, streamKeyId) {
  if (streamKeyId) {
    return db.prepare('SELECT * FROM stream_keys WHERE id=? AND user_id=?').get(streamKeyId, userId) || null;
  }

  const keys = db.prepare(`
    SELECT * FROM stream_keys
    WHERE user_id=?
    ORDER BY CASE platform WHEN 'youtube' THEN 0 WHEN 'custom' THEN 1 ELSE 2 END, name
  `).all(userId);

  return keys.length === 1 ? keys[0] : null;
}

function pickAutoStartVps(userId, channelVpsId, streamKey) {
  if (channelVpsId) {
    return db.prepare('SELECT id, name FROM vps WHERE id=? AND user_id=?').get(channelVpsId, userId) || null;
  }

  if (streamKey?.default_vps_id) {
    const vps = db.prepare('SELECT id, name FROM vps WHERE id=? AND user_id=?').get(streamKey.default_vps_id, userId);
    if (vps) return vps;
  }

  return db.prepare(`
    SELECT id, name FROM vps
    WHERE user_id=?
    ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id
    LIMIT 1
  `).get(userId) || null;
}

function getDetectionVps(userId, preferredVpsId = null) {
  if (preferredVpsId) {
    const preferred = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(preferredVpsId, userId);
    if (preferred) return preferred;
  }
  return db.prepare(`
    SELECT * FROM vps
    WHERE user_id=?
    ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, id
    LIMIT 1
  `).get(userId);
}

async function ensureRemoteDouyinHelper(vpsId, userId) {
  const key = `${userId}:${vpsId}`;
  if (syncedDouyinHelpers.has(key)) return;

  const scriptPath = path.join(__dirname, '..', 'check_douyin.py');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const scriptB64 = Buffer.from(script).toString('base64');
  const cmd = [
    'if ! command -v wget >/dev/null 2>&1; then apt-get update -y && apt-get install -y wget ca-certificates; fi',
    'if ! command -v python3 >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3; fi',
    'if ! command -v yt-dlp >/dev/null 2>&1; then ARCH=$(uname -m); if [ "$ARCH" = "aarch64" ]; then YT_BIN=yt-dlp_linux_aarch64; elif [ "$ARCH" = "armv7l" ]; then YT_BIN=yt-dlp_linux_armv7l; else YT_BIN=yt-dlp_linux; fi; wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN" && chmod +x /usr/local/bin/yt-dlp; fi',
    'if ! command -v streamlink >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3-pip ca-certificates && (pip3 install -q --break-system-packages --upgrade streamlink || pip3 install -q --upgrade streamlink); fi',
    'mkdir -p /opt/restream-console',
    `printf %s ${shQuote(scriptB64)} | base64 -d > ${shQuote(DOUYIN_CHECK_SCRIPT)}`,
    `chmod +x ${shQuote(DOUYIN_CHECK_SCRIPT)}`,
  ].join(' && ');

  await sshService.exec(vpsId, cmd, userId);
  syncedDouyinHelpers.add(key);
}

function buildDouyinCheckCmd(url, userId) {
  const cookies = getDouyinCookies(userId);
  return `python3 ${shQuote(DOUYIN_CHECK_SCRIPT)} ${shQuote(url)} ${shQuote(cookies)}`;
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

async function detectDouyinWithVps(channel, userId, vps) {
  if (!vps) return null;

  await ensureRemoteDouyinHelper(vps.id, userId);
  const result = await sshService.exec(vps.id, buildDouyinCheckCmd(channel.url, userId), userId);
  const out = String(result.stdout || '').trim().split(/\s+/)[0]?.toLowerCase();

  if (out === 'live') return { status: 'live', live: true, source: `douyin-helper:${vps.name || vps.id}` };
  if (out === 'offline') return { status: 'offline', live: false, source: `douyin-helper:${vps.name || vps.id}` };
  return null;
}

async function detectWithYtDlp(channel, userId, vps) {
  if (!vps) return null;
  const result = await sshService.exec(vps.id, buildYtDlpCmd(channel.url, userId), userId);
  const out = String(result.stdout || '').trim();
  if (!out) return { status: 'offline', live: false, source: `yt-dlp:${vps.name || vps.id}` };
  return { status: out.startsWith('http') ? 'live' : 'offline', live: out.startsWith('http'), source: `yt-dlp:${vps.name || vps.id}` };
}

async function detectChannel(channel, userId) {
  const normalized = normalizeChannelUrl(channel.url);
  const platform = inferPlatform(normalized, channel.platform);
  const checkTarget = { ...channel, url: normalized, platform, user_id: userId };
  const isDouyin = platform === 'douyin' || /douyin\.com/i.test(normalized);
  const vps = getDetectionVps(userId, channel.auto_vps_id);

  if (normalized && normalized !== channel.url) {
    db.prepare('UPDATE source_channels SET url=?, platform=? WHERE id=? AND user_id=?')
      .run(normalized, platform, channel.id, userId);
  }

  if (isDouyin) {
    try {
      const vpsResult = await detectDouyinWithVps(checkTarget, userId, vps);
      if (vpsResult) return vpsResult;
    } catch (e) {
      console.warn(`[channels] Douyin VPS check failed for channel ${channel.id}: ${e.message}`);
    }
  }

  try {
    const apiResult = await platformApi.checkChannel(checkTarget);
    if (apiResult !== null) {
      if (isDouyin && apiResult.isLive) {
        return { status: 'unknown', live: false, source: apiResult.source || 'douyin-api', msg: '抖音本地 API 只返回疑似直播，未作为直播中采信' };
      }
      if (isDouyin && apiResult.isLive === false) {
        return { status: 'unknown', live: false, source: apiResult.source || 'douyin-api', msg: '抖音本地 API 未确认直播，已保守标记为未检测' };
      }
      return {
        status: apiResult.isLive ? 'live' : 'offline',
        live: !!apiResult.isLive,
        source: apiResult.source || 'local-api',
        anchorName: apiResult.anchorName || '',
      };
    }
  } catch (e) {
    console.warn(`[channels] local API check failed for channel ${channel.id}: ${e.message}`);
  }

  if (!isDouyin) {
    try {
      const ytdlpResult = await detectWithYtDlp(checkTarget, userId, vps);
      if (ytdlpResult) return ytdlpResult;
    } catch (e) {
      console.warn(`[channels] yt-dlp check failed for channel ${channel.id}: ${e.message}`);
    }
  }

  return {
    status: 'unknown',
    live: false,
    source: 'none',
    msg: isDouyin ? '无法可靠检测抖音直播状态，请确认 VPS 在线且依赖已安装' : '无法检测直播状态，请确认 VPS 在线或平台链接有效',
  };
}

function detectionMessage(channel, detection) {
  if (detection.msg) return detection.msg;
  const source = detection.source ? `（${detection.source}）` : '';
  const anchor = detection.anchorName ? `，主播：${detection.anchorName}` : '';
  if (detection.status === 'live') return `正在直播${anchor}${source}`;
  if (detection.status === 'offline') return `未开播${anchor}${source}`;
  return `未检测${source}`;
}

async function updateChannelStatus(channel, userId) {
  const detection = await detectChannel(channel, userId);
  const status = ['live', 'offline', 'unknown'].includes(detection.status) ? detection.status : 'unknown';
  const live = status === 'live';

  db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
    .run(status, channel.id, userId);

  if (live && channel.auto_start) {
    ensureAutoStartTask({ ...channel, user_id: userId, live_status: status }).catch(e => {
      console.error(`[channels] auto start failed for channel ${channel.id}: ${e.message}`);
    });
  }

  return {
    id: channel.id,
    ok: status !== 'unknown',
    live,
    status,
    source: detection.source || '',
    msg: detectionMessage(channel, { ...detection, status }),
  };
}

router.get('/', (req, res) => renderChannels(req, res));

router.post('/', async (req, res) => {
  const { name, platform, auto_start, auto_vps_id, auto_stream_key_id, notes } = req.body;
  const wantsAutoStart = auto_start === '1';

  try {
    const meta = await resolveChannelMeta({ name, platform, url: req.body.url, userId: req.session.userId });
    const existing = findExistingChannel(req.session.userId, meta.url);
    if (existing) {
      return res.redirect('/channels?toast=' + encodeURIComponent(`频道已存在：${existing.name}`) + '&type=info');
    }

    const vpsId = validateOwnedOptional('vps', auto_vps_id, req.session.userId);
    if (vpsId === false) return renderChannels(req, res, { status: 403, error: 'VPS 不存在或无权限' });

    const streamKeyId = validateOwnedOptional('stream_keys', auto_stream_key_id, req.session.userId);
    if (streamKeyId === false) return renderChannels(req, res, { status: 403, error: '推流码不存在或无权限' });
    if (wantsAutoStart && !streamKeyId) {
      return renderChannels(req, res, { status: 400, error: '开启自动启动时必须选择推流码' });
    }

    db.prepare(`
      INSERT INTO source_channels (user_id, name, platform, url, auto_start, auto_vps_id, auto_stream_key_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      meta.name,
      meta.platform,
      meta.url,
      wantsAutoStart ? 1 : 0,
      vpsId || null,
      streamKeyId || null,
      String(notes || '').trim().slice(0, 1000) || null
    );

    res.redirect('/channels?toast=' + encodeURIComponent('频道已添加') + '&type=success');
  } catch (e) {
    if (/UNIQUE constraint failed: source_channels\.user_id, source_channels\.url/i.test(e.message)) {
      return res.redirect('/channels?toast=' + encodeURIComponent('频道已存在，未重复添加') + '&type=info');
    }
    renderChannels(req, res, { status: 400, error: e.message });
  }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM source_channels WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.redirect('/channels?toast=' + encodeURIComponent('已删除') + '&type=success');
});

router.post('/:id/check', async (req, res) => {
  const channel = db.prepare('SELECT * FROM source_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!channel) return res.status(404).json({ ok: false, status: 'unknown', msg: '频道不存在' });

  try {
    const result = await updateChannelStatus(channel, req.session.userId);
    res.json(result);
  } catch (e) {
    db.prepare("UPDATE source_channels SET live_status='unknown', last_check=datetime('now') WHERE id=? AND user_id=?")
      .run(channel.id, req.session.userId);
    res.json({ ok: false, id: channel.id, live: false, status: 'unknown', msg: '检测失败：' + e.message });
  }
});

router.post('/check-all', async (req, res) => {
  const channels = db.prepare('SELECT * FROM source_channels WHERE user_id=? ORDER BY id').all(req.session.userId);
  if (channels.length === 0) return res.json({ ok: true, msg: '暂无频道', results: [] });

  const results = [];
  for (const channel of channels) {
    try {
      results.push(await updateChannelStatus(channel, req.session.userId));
    } catch (e) {
      db.prepare("UPDATE source_channels SET live_status='unknown', last_check=datetime('now') WHERE id=? AND user_id=?")
        .run(channel.id, req.session.userId);
      results.push({ id: channel.id, ok: false, live: false, status: 'unknown', msg: '检测失败：' + e.message });
    }
  }

  res.json({ ok: true, results });
});

router.post('/resolve-meta', async (req, res) => {
  const rawUrl = String(req.body.url || '').trim();
  if (!rawUrl) return res.status(400).json({ ok: false, msg: '请输入直播间 URL' });

  try {
    const meta = await resolveChannelMeta({
      name: '',
      platform: req.body.platform || '',
      url: rawUrl,
      userId: req.session.userId,
    });
    res.json({ ok: true, ...meta });
  } catch (e) {
    res.status(400).json({ ok: false, msg: e.message });
  }
});

router.post('/:id/toggle-auto', (req, res) => {
  const channel = db.prepare('SELECT * FROM source_channels WHERE id=? AND user_id=?')
    .get(req.params.id, req.session.userId);
  if (!channel) return res.status(404).json({ ok: false, msg: '频道不存在' });

  const newVal = channel.auto_start ? 0 : 1;
  if (newVal === 1) {
    const streamKey = pickAutoStartStreamKey(req.session.userId, channel.auto_stream_key_id);
    if (!streamKey) {
      const keyCount = db.prepare('SELECT COUNT(*) as n FROM stream_keys WHERE user_id=?').get(req.session.userId).n;
      const msg = keyCount > 0
        ? '请先为这个频道选择要使用的推流码，再开启自动启动'
        : '请先到推流码库添加推流码，再开启自动启动';
      return res.status(400).json({ ok: false, needs_config: true, msg });
    }

    const vps = pickAutoStartVps(req.session.userId, channel.auto_vps_id, streamKey);
    if (!vps) {
      return res.status(400).json({ ok: false, needs_config: true, msg: '请先添加或选择可用 VPS，再开启自动启动' });
    }

    db.prepare(`
      UPDATE source_channels
      SET auto_start=1, auto_stream_key_id=?, auto_vps_id=?
      WHERE id=? AND user_id=?
    `).run(streamKey.id, vps.id, req.params.id, req.session.userId);

    return res.json({
      ok: true,
      auto_start: 1,
      auto_stream_key_id: streamKey.id,
      auto_vps_id: vps.id,
      sk_name: streamKey.name,
      vps_name: vps.name,
      msg: channel.auto_stream_key_id
        ? '已开启自动启动'
        : `已使用唯一推流码「${streamKey.name}」开启自动启动`,
    });
  }

  db.prepare('UPDATE source_channels SET auto_start=0 WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ ok: true, auto_start: 0, msg: '已关闭自动启动' });
});

router.post('/:id/edit', async (req, res) => {
  const { name, platform, notes, auto_vps_id, auto_stream_key_id, auto_start } = req.body;
  const wantsAutoStart = auto_start === '1' || auto_start === true || auto_start === 1;

  try {
    const meta = await resolveChannelMeta({ name, platform, url: req.body.url, userId: req.session.userId });
    const duplicate = findExistingChannel(req.session.userId, meta.url, req.params.id);
    if (duplicate) return res.status(409).json({ ok: false, msg: `该直播间已存在：${duplicate.name}` });

    const vpsId = validateOwnedOptional('vps', auto_vps_id, req.session.userId);
    if (vpsId === false) return res.status(403).json({ ok: false, msg: 'VPS 不存在或无权限' });

    const streamKeyId = validateOwnedOptional('stream_keys', auto_stream_key_id, req.session.userId);
    if (streamKeyId === false) return res.status(403).json({ ok: false, msg: '推流码不存在或无权限' });
    if (wantsAutoStart && !streamKeyId) {
      return res.status(400).json({ ok: false, msg: '开启自动启动时必须选择推流码' });
    }

    const result = db.prepare(`
      UPDATE source_channels
      SET name=?, platform=?, url=?, notes=?, auto_vps_id=?, auto_stream_key_id=?, auto_start=?
      WHERE id=? AND user_id=?
    `).run(
      meta.name,
      meta.platform,
      meta.url,
      String(notes || '').trim().slice(0, 1000) || null,
      vpsId || null,
      streamKeyId || null,
      wantsAutoStart ? 1 : 0,
      req.params.id,
      req.session.userId
    );

    if (result.changes === 0) return res.status(404).json({ ok: false, msg: '频道不存在' });
    res.json({ ok: true, msg: '频道已更新' });
  } catch (e) {
    if (/UNIQUE constraint failed: source_channels\.user_id, source_channels\.url/i.test(e.message)) {
      return res.status(409).json({ ok: false, msg: '该直播间已存在，不能重复保存' });
    }
    res.status(400).json({ ok: false, msg: e.message });
  }
});

module.exports = router;
