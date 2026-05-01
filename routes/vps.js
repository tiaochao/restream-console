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

// 获取 VPS 系统状态：磁盘、内存、负载、在线时长
router.get('/:id/stats', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在' });

  const cmd = [
    `df -h / | awk 'NR==2{printf "%s|%s|%s|%s",$2,$3,$4,$5}'`,
    `echo ""`,
    `free -m | awk '/^Mem/{printf "%s|%s|%s",$2,$3,$4}'`,
    `echo ""`,
    `uptime -p 2>/dev/null || uptime | sed 's/.*up \\([^,]*\\).*/\\1/'`,
    `cat /proc/loadavg | awk '{printf "%s|%s|%s",$1,$2,$3}'`,
    `echo ""`,
  ].join('; ');

  try {
    const result = await sshService.exec(vps.id, cmd);
    const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);

    const disk = lines[0] ? lines[0].split('|') : [];
    const mem  = lines[1] ? lines[1].split('|') : [];
    const uptime = lines[2] || '--';
    const load  = lines[3] ? lines[3].split('|') : [];

    res.json({
      ok: true,
      disk: { total: disk[0] || '--', used: disk[1] || '--', avail: disk[2] || '--', pct: disk[3] || '--' },
      mem:  { totalMB: parseInt(mem[0]) || 0, usedMB: parseInt(mem[1]) || 0, freeMB: parseInt(mem[2]) || 0 },
      uptime,
      load: { m1: load[0] || '--', m5: load[1] || '--', m15: load[2] || '--' },
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// 在 VPS 上执行命令（SSE 流式输出）
router.get('/:id/exec-stream', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) { res.status(404).end(); return; }

  const cmd = String(req.query.cmd || '').slice(0, 500).trim();
  if (!cmd) { res.status(400).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {} };
  let activeStream = null;

  req.on('close', () => {
    if (activeStream) { try { activeStream.destroy(); } catch (_) {} }
  });

  try {
    const ssh = await sshService.connect(vps.id);
    await new Promise((resolve) => {
      ssh.connection.exec(cmd, (err, stream) => {
        if (err) { send({ err: err.message }); resolve(); return; }
        activeStream = stream;
        stream.on('data', chunk => send({ out: chunk.toString() }));
        stream.stderr.on('data', chunk => send({ out: chunk.toString() }));
        stream.on('close', () => { send({ done: true }); resolve(); });
        stream.on('error', e => { send({ err: e.message }); resolve(); });
      });
    });
  } catch (e) {
    send({ err: e.message });
  }

  res.end();
});

// 配置 Xray SOCKS5 代理
router.post('/:id/socks5-config', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在' });

  const port = parseInt(req.body.port) || 1080;
  const user = String(req.body.user || '').trim().slice(0, 64);
  const pass = String(req.body.pass || '').trim().slice(0, 64);

  if (port < 1 || port > 65535) return res.json({ ok: false, msg: '端口号无效 (1-65535)' });

  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port,
      listen: '0.0.0.0',
      protocol: 'socks',
      settings: {
        auth: user ? 'password' : 'noauth',
        accounts: user ? [{ user, pass }] : [],
        udp: true,
      },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };

  const cfgB64 = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');
  const cmd = [
    'mkdir -p /usr/local/etc/xray',
    `echo '${cfgB64}' | base64 -d > /usr/local/etc/xray/config.json`,
    'xray -test -config /usr/local/etc/xray/config.json 2>&1 | head -5',
    'systemctl restart xray 2>&1',
    'sleep 1',
    'systemctl is-active xray && echo "✓ Xray SOCKS5 已启动，端口: ' + port + '"',
  ].join(' && ');

  try {
    const result = await sshService.exec(vps.id, cmd);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const ok = output.includes('✓ Xray SOCKS5 已启动');
    res.json({ ok, output });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
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
