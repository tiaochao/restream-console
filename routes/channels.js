const express = require('express');
const router = express.Router();
const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('../services/ssh');
const platformApi = require('../services/platform-api');
const { checkAndUpdate } = require('../services/live-monitor');

function dqEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/"/g, '\\"');
}

function buildYtDlpCmd(url, userId) {
  const isDouyin = /douyin\.com/i.test(url);
  if (isDouyin) {
    const cookies = getSetting('douyin_cookies', userId) || '';
    if (cookies) {
      const escaped = cookies.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `yt-dlp --no-warnings -g --add-header "Cookie:${escaped}" "${dqEsc(url)}" 2>/dev/null | head -1`;
    }
  }
  return `yt-dlp --no-warnings -g "${dqEsc(url)}" 2>/dev/null | head -1`;
}

// 抖音直播间用 VPS curl 检测（本机 IP 被验证码拦截，VPS IP 可正常访问）
function buildDouyinVpsCurlCmd(url, userId) {
  const m = url.match(/live\.douyin\.com\/(\d+)/);
  if (!m) return null;
  const roomId = m[1];
  const cookies = getSetting('douyin_cookies', userId) || '';
  const ckEsc = cookies.replace(/'/g, "'\\''");
  const ckHeader = ckEsc ? `-H 'Cookie: ${ckEsc}' ` : '';
  // Python 处理两种格式：字符串 "liveStatus":"normal" 和数字 "liveStatus":2
  // 结果统一输出 normal（直播中）或空字符串（未开播/未知）
  const py = 'import sys,re; h=sys.stdin.read(); ' +
    'ms=re.search("liveStatus.{0,15}?(normal|end|LIVE|live|Living|NORMAL|init)",h); ' +
    'mn=re.search("\\"liveStatus\\"\\s*:\\s*(\\d+)",h); ' +
    'sv=ms.group(1) if ms else None; nv=mn.group(1) if mn else None; ' +
    'print("normal" if sv in("normal","LIVE","live","Living","NORMAL") or nv=="2" else "")';
  return `curl -s -m 30 -L ` +
    `-H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' ` +
    `-H 'Accept: text/html,*/*' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Referer: https://www.douyin.com/' ` +
    `${ckHeader}'https://live.douyin.com/${roomId}' | ` +
    `python3 -c '${py}'`;
}

function getFormData(userId) {
  return {
    vpsList:    db.prepare('SELECT id, name FROM vps WHERE user_id=? ORDER BY name').all(userId),
    streamKeys: db.prepare('SELECT id, name, platform FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(userId),
  };
}

router.get('/', (req, res) => {
  const channels = db.prepare(`
    SELECT c.*,
      v.name as vps_name,
      sk.name as sk_name
    FROM source_channels c
    LEFT JOIN vps v ON c.auto_vps_id = v.id
    LEFT JOIN stream_keys sk ON c.auto_stream_key_id = sk.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.session.userId);

  res.render('channels', {
    title: '频道监控 - 转推控制台',
    currentPath: '/channels',
    channels,
    ...getFormData(req.session.userId),
  });
});

router.post('/', (req, res) => {
  const { name, platform, url, auto_start, auto_vps_id, auto_stream_key_id, notes } = req.body;

  if (auto_vps_id) {
    const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(auto_vps_id, req.session.userId);
    if (!vps) {
      const channels = db.prepare('SELECT * FROM source_channels WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
      return res.status(403).render('channels', { title: '频道监控 - 转推控制台', currentPath: '/channels', channels, error: 'VPS 不存在或无权限', ...getFormData(req.session.userId) });
    }
  }
  if (auto_stream_key_id) {
    const sk = db.prepare('SELECT id FROM stream_keys WHERE id=? AND user_id=?').get(auto_stream_key_id, req.session.userId);
    if (!sk) {
      const channels = db.prepare('SELECT * FROM source_channels WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
      return res.status(403).render('channels', { title: '频道监控 - 转推控制台', currentPath: '/channels', channels, error: '推流码不存在或无权限', ...getFormData(req.session.userId) });
    }
  }

  try {
    db.prepare(`
      INSERT INTO source_channels (user_id, name, platform, url, auto_start, auto_vps_id, auto_stream_key_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      name, platform || 'douyin', url,
      auto_start === '1' ? 1 : 0,
      auto_vps_id || null,
      auto_stream_key_id || null,
      notes || null
    );
    res.redirect('/channels?toast=' + encodeURIComponent('频道已添加') + '&type=success');
  } catch (e) {
    const channels = db.prepare('SELECT * FROM source_channels WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
    res.render('channels', {
      title: '频道监控 - 转推控制台', currentPath: '/channels',
      channels, error: e.message, ...getFormData(req.session.userId),
    });
  }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM source_channels WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.redirect('/channels?toast=' + encodeURIComponent('已删除') + '&type=success');
});

// 手动检测单个频道
router.post('/:id/check', async (req, res) => {
  const channel = db.prepare('SELECT * FROM source_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!channel) return res.json({ ok: false, msg: '频道不存在' });

  // 优先平台直连 API
  try {
    const apiResult = await platformApi.checkChannel(channel);
    if (apiResult !== null) {
      const isLive = apiResult.isLive;
      const status = isLive ? 'live' : 'offline';
      db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
        .run(status, channel.id, req.session.userId);

      if (isLive && channel.auto_start) {
        checkAndUpdate({ ...channel, live_status: channel.live_status }).catch(() => {});
      }

      const source = apiResult.source || '';
      const anchorName = apiResult.anchorName ? `（${apiResult.anchorName}）` : '';
      const detail = source ? `[${source}]` : '';
      return res.json({
        ok: true,
        live: isLive,
        status,
        msg: isLive ? `正在直播 🔴${anchorName}` : `未开播${anchorName} ${detail}`,
        source,
      });
    }
  } catch (e) {
    // 平台 API 异常，继续尝试 VPS
    console.warn('[频道检测] 平台 API 失败:', e.message);
  }

  // 兜底：SSH 检测（抖音用 curl 解析页面，其他用 yt-dlp）
  const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
  if (!vps) return res.json({ ok: false, msg: '没有在线的 VPS，且平台 API 检测失败' });

  const isDouyinUrl = /live\.douyin\.com\/\d+/.test(channel.url);
  const curlCmd = isDouyinUrl ? buildDouyinVpsCurlCmd(channel.url, req.session.userId) : null;
  const cmd = curlCmd || buildYtDlpCmd(channel.url, req.session.userId);
  const source = curlCmd ? 'vps-curl' : 'yt-dlp';

  try {
    const result = await sshService.exec(vps.id, cmd);
    const out = (result.stdout || '').trim();
    console.log(`[频道检测] ${channel.name} VPS raw output: "${out}" stderr: "${(result.stderr||'').slice(0,100)}"`);
    const isLive = isDouyinUrl ? out === 'normal' : out.startsWith('http');

    if (isLive && channel.auto_start) {
      checkAndUpdate({ ...channel, live_status: channel.live_status }).catch(() => {});
    }

    res.json({ ok: true, live: isLive, status, msg: isLive ? '正在直播 🔴' : `未开播 [${source}]`, source });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

// 切换自动启动
router.post('/:id/toggle-auto', (req, res) => {
  const ch = db.prepare('SELECT auto_start FROM source_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!ch) return res.json({ ok: false });
  const newVal = ch.auto_start ? 0 : 1;
  db.prepare('UPDATE source_channels SET auto_start=? WHERE id=? AND user_id=?').run(newVal, req.params.id, req.session.userId);
  res.json({ ok: true, auto_start: newVal });
});

// 批量检测所有频道
router.post('/check-all', async (req, res) => {
  const channels = db.prepare('SELECT * FROM source_channels WHERE user_id=?').all(req.session.userId);
  if (channels.length === 0) return res.json({ ok: true, msg: '没有频道', results: [] });

  const results = [];

  for (const ch of channels) {
    let isLive = false;
    let status = 'unknown';
    const wasLive = ch.live_status === 'live';

    // 1. 平台 API
    try {
      const apiResult = await platformApi.checkChannel(ch);
      if (apiResult !== null) {
        isLive = apiResult.isLive;
        status = isLive ? 'live' : 'offline';
        db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
          .run(status, ch.id, req.session.userId);
        if (isLive && !wasLive && ch.auto_start) {
          checkAndUpdate(ch).catch(() => {});
        }
        results.push({ id: ch.id, live: isLive, status });
        continue;
      }
    } catch (_) {}

    // 2. VPS curl/yt-dlp 兜底
    try {
      const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
      if (vps) {
        const isDouyinUrl = /live\.douyin\.com\/\d+/.test(ch.url);
        const curlCmd = isDouyinUrl ? buildDouyinVpsCurlCmd(ch.url, req.session.userId) : null;
        const cmd = curlCmd || buildYtDlpCmd(ch.url, req.session.userId);
        const r = await sshService.exec(vps.id, cmd);
        const out = (r.stdout || '').trim();
        isLive = isDouyinUrl ? out === 'normal' : out.startsWith('http');
        status = isLive ? 'live' : 'offline';
        db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
          .run(status, ch.id, req.session.userId);
        if (isLive && !wasLive && ch.auto_start) {
          checkAndUpdate(ch).catch(() => {});
        }
      }
    } catch (_) {}

    results.push({ id: ch.id, live: isLive, status });
  }

  res.json({ ok: true, results });
});

module.exports = router;
