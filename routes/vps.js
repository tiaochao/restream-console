const express = require('express');
const router = express.Router();
const db = require('../db');
const sshService = require('../services/ssh');

router.get('/', (req, res) => {
  const list = db.prepare('SELECT * FROM vps WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  res.render('vps', { title: 'VPS管理 - 转推控制台', currentPath: '/vps', vpsList: list, error: null });
});

router.post('/', (req, res) => {
  const { name, host, port, username, auth_type, password, private_key } = req.body;
  try {
    db.prepare(`
      INSERT INTO vps (user_id, name, host, port, username, auth_type, password, private_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.session.userId, name, host, parseInt(port) || 22, username || 'root', auth_type || 'password', password || null, private_key || null);
    res.redirect('/vps?toast=' + encodeURIComponent('VPS 添加成功') + '&type=success');
  } catch (e) {
    const list = db.prepare('SELECT * FROM vps WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
    res.render('vps', { title: 'VPS管理 - 转推控制台', currentPath: '/vps', vpsList: list, error: e.message });
  }
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM vps WHERE id = ? AND user_id=?').run(req.params.id, req.session.userId);
  sshService.disconnect(parseInt(req.params.id));
  res.redirect('/vps?toast=' + encodeURIComponent('VPS 已删除') + '&type=success');
});

router.post('/:id/test', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id = ? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在' });

  try {
    sshService.disconnect(parseInt(req.params.id));
    const ok = await sshService.testConnection(vps);
    if (ok) {
      db.prepare("UPDATE vps SET status='online', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      return res.json({ ok: true, msg: '连接成功' });
    }
    db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
    res.json({ ok: false, msg: '连接失败' });
  } catch (e) {
    db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/install-deps', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id = ? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在' });

  // 安装脚本：ffmpeg + yt-dlp + streamlink（检测已安装则跳过）
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get install -y ffmpeg wget python3 python3-pip 2>&1 | tail -3',
    // yt-dlp 独立二进制（不依赖系统 Python 版本）
    'ARCH=$(uname -m)',
    'if [ "$ARCH" = "aarch64" ]; then YT_BIN=yt-dlp_linux_aarch64; elif [ "$ARCH" = "armv7l" ]; then YT_BIN=yt-dlp_linux_armv7l; else YT_BIN=yt-dlp_linux; fi',
    'wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN"',
    'chmod +x /usr/local/bin/yt-dlp',
    // streamlink（抖音直播拉流）
    'pip3 install -q --upgrade streamlink 2>&1 | tail -2',
    'echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1)"',
    'echo "yt-dlp: $(yt-dlp --version)"',
    'echo "streamlink: $(streamlink --version 2>/dev/null || echo 未安装)"',
  ].join(' && ');

  try {
    const result = await sshService.freshExec(vps.id, script);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const ok = output.includes('yt-dlp:') || output.includes('ffmpeg:');
    res.json({ ok, msg: ok ? '依赖安装完成' : '安装可能有问题，请查看输出', output });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

// 批量 ping 所有 VPS（前端按钮调用）
router.post('/ping-all', async (req, res) => {
  const vpsList = db.prepare('SELECT * FROM vps WHERE user_id=?').all(req.session.userId);
  const results = [];
  for (const vps of vpsList) {
    try {
      sshService.disconnect(vps.id);
      await new Promise(r => setTimeout(r, 200));
      const ok = await sshService.testConnection(vps);
      const status = ok ? 'online' : 'offline';
      db.prepare("UPDATE vps SET status=?, last_check=CURRENT_TIMESTAMP WHERE id=?").run(status, vps.id);
      results.push({ id: vps.id, status, name: vps.name });
    } catch (e) {
      db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      results.push({ id: vps.id, status: 'offline', name: vps.name, error: e.message });
    }
  }
  res.json({ ok: true, results });
});

module.exports = router;
