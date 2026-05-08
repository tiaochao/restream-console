const express = require('express');
const router = express.Router();
const db = require('../db');
const sshService = require('../services/ssh');

const TITLE = '推流码管理 - 转推控制台';

function getVpsList(userId) {
  return db.prepare('SELECT id, name FROM vps WHERE user_id=? ORDER BY name').all(userId);
}

function getYtChannels(userId) {
  return db.prepare('SELECT id, channel_id, title, handle, thumbnail_url FROM yt_channels WHERE user_id=? ORDER BY title').all(userId);
}

function getKeys(userId) {
  return db.prepare(`
    SELECT sk.*,
      v.name as default_vps_name,
      yc.title as yt_channel_title,
      yc.handle as yt_channel_handle,
      yc.thumbnail_url as yt_channel_thumbnail,
      yc.channel_id as yt_channel_channel_id
    FROM stream_keys sk
    LEFT JOIN vps v ON v.id = sk.default_vps_id AND v.user_id = sk.user_id
    LEFT JOIN yt_channels yc ON yc.id = sk.youtube_channel_id AND yc.user_id = sk.user_id
    WHERE sk.user_id=?
    ORDER BY sk.platform, sk.name
  `).all(userId);
}

function normalizeDefaultVpsId(value, userId) {
  if (!value) return null;
  const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(value, userId);
  return vps ? vps.id : false;
}

function normalizeYtChannelId(value, userId) {
  if (!value) return null;
  const ch = db.prepare('SELECT id FROM yt_channels WHERE id=? AND user_id=?').get(value, userId);
  return ch ? ch.id : false;
}

function renderPage(req, res, { status = 200, error = null } = {}) {
  return res.status(status).render('stream-keys', {
    title: TITLE,
    currentPath: '/stream-keys',
    keys: getKeys(req.session.userId),
    vpsList: getVpsList(req.session.userId),
    ytChannels: getYtChannels(req.session.userId),
    error,
  });
}

function normalizeInput(body) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    platform: String(body.platform || 'youtube').trim().slice(0, 32) || 'youtube',
    rtmp_url: String(body.rtmp_url || '').trim(),
    stream_key: String(body.stream_key || '').trim(),
    youtube_channel_id: body.youtube_channel_id || null,
    youtube_url: String(body.youtube_url || '').trim().slice(0, 500) || null,
    notes: String(body.notes || '').trim().slice(0, 1000) || null,
    default_vps_id: body.default_vps_id,
  };
}

function validateKeyInput(input) {
  if (!input.name || !input.rtmp_url || !input.stream_key) return '名称、RTMP 地址和推流密钥不能为空';
  if (!/^rtmps?:\/\//i.test(input.rtmp_url)) return 'RTMP 地址必须以 rtmp:// 或 rtmps:// 开头';
  if (/[\r\n\0]/.test(input.rtmp_url) || /[\r\n\0]/.test(input.stream_key)) return 'RTMP 地址或推流密钥包含非法字符';
  if (input.youtube_url && (!/^https?:\/\//i.test(input.youtube_url) || !/youtu(?:be\.com|\.be)/i.test(input.youtube_url))) {
    return 'YouTube 直播间/频道链接格式不正确';
  }
  if (input.rtmp_url.length > 500 || input.stream_key.length > 800) return 'RTMP 地址或推流密钥过长';
  return null;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildVerifyCommand(dest) {
  const quotedDest = shQuote(dest);
  return [
    'timeout 10 ffmpeg -hide_banner -loglevel warning -re',
    '-f lavfi -i color=black:s=1280x720:r=30',
    '-f lavfi -i anullsrc',
    '-c:v libx264 -preset ultrafast -b:v 500k -c:a aac -t 3',
    `-f flv ${quotedDest} 2>&1 | tail -20`,
  ].join(' ');
}

// 启动时自动将旧 youtube_url 匹配到 yt_channels（仅本地字符串解析，无需 API）
function autoLinkExistingKeys() {
  const rows = db.prepare(`
    SELECT sk.id, sk.user_id, sk.youtube_url
    FROM stream_keys sk
    WHERE sk.youtube_channel_id IS NULL
      AND sk.youtube_url IS NOT NULL
      AND trim(sk.youtube_url) != ''
  `).all();

  for (const row of rows) {
    const url = row.youtube_url;
    const channels = db.prepare('SELECT id, channel_id, handle FROM yt_channels WHERE user_id=?').all(row.user_id);
    if (!channels.length) continue;

    let matched = null;
    const ucMatch = url.match(/\/channel\/(UC[\w-]{22})/);
    if (ucMatch) {
      matched = channels.find(c => c.channel_id === ucMatch[1]);
    }
    if (!matched) {
      const handleMatch = url.match(/@([\w.-]+)/);
      if (handleMatch) {
        const h = handleMatch[1].toLowerCase();
        matched = channels.find(c => (c.handle || '').replace(/^@/, '').toLowerCase() === h);
      }
    }
    if (matched) {
      db.prepare('UPDATE stream_keys SET youtube_channel_id=? WHERE id=?').run(matched.id, row.id);
      console.log(`[stream-keys] 自动关联推流码 ${row.id} → 频道 ${matched.channel_id}`);
    }
  }
}

autoLinkExistingKeys();

router.get('/', (req, res) => renderPage(req, res));

router.post('/', (req, res) => {
  const input = normalizeInput(req.body);
  const validationError = validateKeyInput(input);
  if (validationError) return renderPage(req, res, { status: 400, error: validationError });

  try {
    const vpsId = normalizeDefaultVpsId(input.default_vps_id, req.session.userId);
    if (vpsId === false) throw new Error('VPS 不存在或无权限');
    const ytChId = normalizeYtChannelId(input.youtube_channel_id, req.session.userId);
    if (ytChId === false) throw new Error('YouTube 频道不存在或无权限');
    db.prepare('INSERT INTO stream_keys (user_id,name,platform,rtmp_url,stream_key,notes,default_vps_id,youtube_url,youtube_channel_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(req.session.userId, input.name, input.platform, input.rtmp_url, input.stream_key, input.notes, vpsId, input.youtube_url, ytChId);
    res.redirect('/stream-keys?toast=' + encodeURIComponent('推流码已添加') + '&type=success');
  } catch (e) {
    renderPage(req, res, { status: 400, error: e.message });
  }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM stream_keys WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.redirect('/stream-keys?toast=' + encodeURIComponent('已删除') + '&type=success');
});

router.post('/:id/edit', (req, res) => {
  const input = normalizeInput(req.body);
  const validationError = validateKeyInput(input);
  if (validationError) return res.status(400).json({ ok: false, msg: validationError });

  const key = db.prepare('SELECT id FROM stream_keys WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!key) return res.status(404).json({ ok: false, msg: '推流码不存在或无权限' });

  try {
    const vpsId = normalizeDefaultVpsId(input.default_vps_id, req.session.userId);
    if (vpsId === false) return res.status(400).json({ ok: false, msg: 'VPS 不存在或无权限' });
    const ytChId = normalizeYtChannelId(input.youtube_channel_id, req.session.userId);
    if (ytChId === false) return res.status(400).json({ ok: false, msg: 'YouTube 频道不存在或无权限' });
    db.prepare(`
      UPDATE stream_keys
      SET name=?, platform=?, rtmp_url=?, stream_key=?, notes=?, default_vps_id=?, youtube_url=?, youtube_channel_id=?
      WHERE id=? AND user_id=?
    `).run(input.name, input.platform, input.rtmp_url, input.stream_key, input.notes, vpsId, input.youtube_url, ytChId, req.params.id, req.session.userId);
    res.json({ ok: true, msg: '推流码已更新' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/verify', async (req, res) => {
  const key = db.prepare('SELECT * FROM stream_keys WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!key) return res.status(404).json({ ok: false, msg: '推流码不存在' });

  const validationError = validateKeyInput({
    name: key.name,
    platform: key.platform,
    rtmp_url: key.rtmp_url,
    stream_key: key.stream_key,
  });
  if (validationError) return res.status(400).json({ ok: false, msg: validationError });

  const vps = key.default_vps_id
    ? db.prepare("SELECT * FROM vps WHERE id=? AND user_id=? AND status='online'").get(key.default_vps_id, req.session.userId)
    : null;
  const testVps = vps || db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
  if (!testVps) return res.json({ ok: false, msg: '没有在线 VPS 可用于校验，请先测试 VPS 连接' });

  const dest = `${key.rtmp_url.replace(/\/$/, '')}/${key.stream_key}`;
  const cmd = buildVerifyCommand(dest);

  try {
    const result = await sshService.freshExec(testVps.id, cmd, req.session.userId);
    const output = (result.stdout + result.stderr).toLowerCase();
    const success = output.includes('frame=') || output.includes('muxing overhead') || output.includes('video:');
    const failed = output.includes('connection refused') || output.includes('failed') || (output.includes('error') && !success);

    if (success) {
      const cleaned = (key.notes || '').replace(/\s*\[校验通过\]/g, '').trim();
      const newNotes = cleaned ? `${cleaned} [校验通过]` : '[校验通过]';
      db.prepare('UPDATE stream_keys SET notes=? WHERE id=? AND user_id=?').run(newNotes, key.id, req.session.userId);
      return res.json({ ok: true, msg: '推流码有效，RTMP 连接成功' });
    }
    if (failed) return res.json({ ok: false, msg: 'RTMP 连接失败，请检查推流码或直播是否开启' });
    res.json({ ok: true, msg: '测试完成，未发现明显错误' });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

router.get('/api/list', (req, res) => {
  const keys = db.prepare(`
    SELECT sk.id, sk.name, sk.platform, sk.rtmp_url, sk.stream_key, sk.default_vps_id,
           sk.youtube_url, sk.youtube_channel_id,
           yc.title as yt_channel_title, yc.channel_id as yt_channel_channel_id
    FROM stream_keys sk
    LEFT JOIN yt_channels yc ON yc.id = sk.youtube_channel_id AND yc.user_id = sk.user_id
    WHERE sk.user_id=? ORDER BY sk.platform, sk.name
  `).all(req.session.userId);
  res.json(keys);
});

module.exports = router;
