const express = require('express');
const router = express.Router();
const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('../services/ssh');
const platformApi = require('../services/platform-api');
const { checkAndUpdate } = require('../services/live-monitor');

const DOUYIN_CHECK_SCRIPT = '/opt/restream-console/check_douyin.py';

function dqEsc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/"/g, '\\"');
}

function buildDouyinCheckCmd(url, userId) {
  const cookies = getSetting('douyin_cookies', userId) || '';
  const ckEsc  = cookies.replace(/'/g, "'\\''");
  const urlEsc = url.replace(/'/g, "'\\''");
  return `python3 ${DOUYIN_CHECK_SCRIPT} '${urlEsc}' '${ckEsc}'`;
}

function buildYtDlpCmd(url, userId) {
  const isDouyin = /douyin\.com/i.test(url);
  if (isDouyin) {
    const cookies = getSetting('douyin_cookies', userId) || '';
    const ckArg = cookies ? `--add-header "Cookie:${cookies.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
    const hdrs = `--add-header "Referer: https://live.douyin.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`;
    return `yt-dlp --no-warnings -g ${ckArg} ${hdrs} "${dqEsc(url)}" 2>/dev/null | head -1`;
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

  // 抖音：Python 脚本检测（三层降级，比 yt-dlp 可靠）
  if (/douyin\.com/i.test(channel.url)) {
    const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
    if (vps) {
      const cmd = buildDouyinCheckCmd(channel.url, req.session.userId);
      try {
        const result = await sshService.exec(vps.id, cmd);
        const out = (result.stdout || '').trim();
        console.log(`[频道检测] ${channel.name} python check: ${out}`);

        if (out === 'offline') {
          db.prepare("UPDATE source_channels SET live_status='offline', last_check=datetime('now') WHERE id=? AND user_id=?")
            .run(channel.id, req.session.userId);
          return res.json({ ok: true, live: false, status: 'offline', msg: '未开播', source: 'python' });
        }

        if (out === 'live') {
          // yt-dlp 实流验证（API 有 CDN 缓存）
          try {
            const ytCmd = buildYtDlpCmd(channel.url, req.session.userId);
            const ytResult = await sshService.exec(vps.id, ytCmd);
            const ytUrl = (ytResult.stdout || '').trim();
            if (!ytUrl.startsWith('http')) {
              // yt-dlp 拿不到流地址 → API 误报，已结束
              db.prepare("UPDATE source_channels SET live_status='offline', last_check=datetime('now') WHERE id=? AND user_id=?")
                .run(channel.id, req.session.userId);
              return res.json({ ok: true, live: false, status: 'offline', msg: '未开播（API缓存误报，已结束）', source: 'yt-dlp-verify' });
            }
          } catch (_) {
            // yt-dlp 异常，维持 live 判定
          }
          db.prepare("UPDATE source_channels SET live_status='live', last_check=datetime('now') WHERE id=? AND user_id=?")
            .run(channel.id, req.session.userId);
          if (channel.auto_start) {
            checkAndUpdate({ ...channel, live_status: channel.live_status }).catch(() => {});
          }
          return res.json({ ok: true, live: true, status: 'live', msg: '正在直播 🔴', source: 'python+yt-dlp' });
        }
        // unknown → 继续走 API
      } catch (e) {
        console.warn('[频道检测] Python 脚本失败:', e.message);
      }
    }
  }

  // 非抖音 or Python 返回 unknown：本地 API
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
      return res.json({
        ok: true,
        live: isLive,
        status,
        msg: isLive ? `正在直播 🔴${anchorName}` : `未开播${anchorName}`,
        source,
      });
    }
  } catch (e) {
    console.warn('[频道检测] 平台 API 失败:', e.message);
  }

  // 兜底：SSH yt-dlp
  const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
  if (!vps) return res.json({ ok: false, msg: '没有在线的 VPS，且平台 API 检测失败' });

  const cmd = buildYtDlpCmd(channel.url, req.session.userId);
  try {
    const result = await sshService.exec(vps.id, cmd);
    const out = (result.stdout || '').trim();
    const isLive = out.startsWith('http');
    const status = isLive ? 'live' : 'offline';
    db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
      .run(status, channel.id, req.session.userId);
    if (isLive && channel.auto_start) {
      checkAndUpdate({ ...channel, live_status: channel.live_status }).catch(() => {});
    }
    res.json({ ok: true, live: isLive, status, msg: isLive ? '正在直播 🔴' : '未开播 [yt-dlp]', source: 'yt-dlp' });
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

    // 2. VPS Python 脚本（抖音）或 yt-dlp（其他平台）兜底
    try {
      const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
      if (vps) {
        const isDouyinUrl = /douyin\.com/i.test(ch.url);
        let detected = false;
        if (isDouyinUrl) {
          const r = await sshService.exec(vps.id, buildDouyinCheckCmd(ch.url, req.session.userId));
          const out = (r.stdout || '').trim();
          if (out === 'live' || out === 'offline') {
            isLive = out === 'live';
            detected = true;
          }
        } else {
          const r = await sshService.exec(vps.id, buildYtDlpCmd(ch.url, req.session.userId));
          const out = (r.stdout || '').trim();
          if (out) { isLive = out.startsWith('http'); detected = true; }
        }
        if (detected) {
          status = isLive ? 'live' : 'offline';
          db.prepare("UPDATE source_channels SET live_status=?, last_check=datetime('now') WHERE id=? AND user_id=?")
            .run(status, ch.id, req.session.userId);
          if (isLive && !wasLive && ch.auto_start) {
            checkAndUpdate(ch).catch(() => {});
          }
        }
      }
    } catch (_) {}

    results.push({ id: ch.id, live: isLive, status });
  }

  res.json({ ok: true, results });
});

// 编辑频道
router.post('/:id/edit', (req, res) => {
  const { name, platform, url, notes, auto_vps_id, auto_stream_key_id, auto_start } = req.body;

  if (auto_vps_id) {
    const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(auto_vps_id, req.session.userId);
    if (!vps) return res.json({ ok: false, msg: 'VPS 不存在或无权限' });
  }
  if (auto_stream_key_id) {
    const sk = db.prepare('SELECT id FROM stream_keys WHERE id=? AND user_id=?').get(auto_stream_key_id, req.session.userId);
    if (!sk) return res.json({ ok: false, msg: '推流码不存在或无权限' });
  }

  try {
    const result = db.prepare(`
      UPDATE source_channels
      SET name=?, platform=?, url=?, notes=?, auto_vps_id=?, auto_stream_key_id=?, auto_start=?
      WHERE id=? AND user_id=?
    `).run(
      name, platform || 'douyin', url,
      notes || null,
      auto_vps_id || null,
      auto_stream_key_id || null,
      auto_start === '1' ? 1 : 0,
      req.params.id, req.session.userId
    );
    if (result.changes === 0) return res.json({ ok: false, msg: '频道不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

module.exports = router;
