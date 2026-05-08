const express = require('express');
const router = express.Router();
const db = require('../db');
const sshService = require('../services/ssh');
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('../services/crypto');

const TITLE = 'VPS管理 - 转推控制台';
const UPLOAD_DIR = '/root/restream_uploads';
const LEGACY_RECORD_DIR = '/root/restream_recordings';
const DOUYIN_RECORD_DIR = '/root/douyin2youtube/recordings';
const MEDIA_SCAN_DIRS = [UPLOAD_DIR, LEGACY_RECORD_DIR, DOUYIN_RECORD_DIR];
const HOST_RE = /^[a-zA-Z0-9._:-]{1,255}$/;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function isInternalMediaName(name) {
  return /^task_\d+_latest\.ts$/i.test(path.basename(String(name || '')));
}

function renderPage(req, res, { status = 200, error = null } = {}) {
  const list = db.prepare('SELECT * FROM vps WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  return res.status(status).render('vps', { title: TITLE, currentPath: '/vps', vpsList: list, error });
}

function normalizeVpsInput(body) {
  const port = parseInt(body.port, 10) || 22;
  return {
    name: String(body.name || '').trim().slice(0, 120),
    host: String(body.host || '').trim(),
    port,
    username: String(body.username || 'root').trim().slice(0, 64) || 'root',
    auth_type: body.auth_type === 'key' ? 'key' : 'password',
    password: String(body.password || ''),
    private_key: String(body.private_key || ''),
  };
}

function validateVpsInput(input) {
  if (!input.name) return 'VPS 名称不能为空';
  if (!input.host || !HOST_RE.test(input.host) || /[\r\n\0]/.test(input.host)) return 'VPS 主机地址无效';
  if (input.port < 1 || input.port > 65535) return '端口必须在 1-65535 之间';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(input.username)) return 'SSH 用户名无效';
  if (input.auth_type === 'key' && !input.private_key.trim()) return '密钥认证需要填写 private key';
  if (input.auth_type === 'password' && !input.password) return '密码认证需要填写密码';
  if (input.private_key.length > 20000) return 'private key 内容过长';
  return null;
}

async function scanMediaFiles(userId, vpsId) {
  const dirs = MEDIA_SCAN_DIRS.map(shQuote).join(' ');
  const cmd = [
    `mkdir -p ${shQuote(UPLOAD_DIR)}`,
    `for d in ${dirs}; do [ -d "$d" ] || continue; find "$d" -maxdepth 1 -type f \\( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.avi" -o -iname "*.ts" -o -iname "*.mov" -o -iname "*.flv" -o -iname "*.wmv" -o -iname "*.m4v" -o -iname "*.webm" \\) ! -name "*.tmp" ! -name "*.part" ! -name "*.uploading-*" ! -name "task_*_latest.ts" ! -name "*_recording.ts" ! -name "*_recording.tmp" ! -name "*_fallback.tmp" | while IFS= read -r f; do printf '%s\t%s\t%s\n' "$(basename "$f")" "$f" "$(stat -c%s "$f" 2>/dev/null || echo 0)"; done; done`,
  ].join(' && ');

  const result = await sshService.exec(vpsId, cmd, userId);
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [name, remotePath, sizeStr] = parts;
    if (!MEDIA_SCAN_DIRS.some(dir => remotePath.startsWith(`${dir}/`))) continue;
    if (isInternalMediaName(name)) continue;
    const size = parseInt(sizeStr, 10) || 0;
    const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?').get(userId, vpsId, remotePath);
    if (existing) db.prepare('UPDATE media_files SET size=?, name=? WHERE id=?').run(size, name, existing.id);
    else db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)').run(userId, vpsId, name, remotePath, size);
  }
  return lines.length;
}

router.get('/', (req, res) => renderPage(req, res));

router.get('/:id/media', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在或无权限' });
  try {
    if (req.query.scan === '1') await scanMediaFiles(req.session.userId, vps.id);
    const files = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM tasks WHERE user_id=? AND source_url = m.remote_path) AS ref_count
      FROM media_files m
      WHERE m.user_id=? AND m.vps_id=?
        AND m.name NOT GLOB 'task_*_latest.ts'
      ORDER BY m.created_at DESC
    `).all(req.session.userId, req.session.userId, vps.id);
    res.json({ ok: true, uploadDir: UPLOAD_DIR, files });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

router.post('/:id/media/:fileId/delete', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在或无权限' });

  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=? AND vps_id=?').get(req.params.fileId, req.session.userId, vps.id);
  if (!file) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if (!file.remote_path || !MEDIA_SCAN_DIRS.some(dir => file.remote_path.startsWith(`${dir}/`))) return res.status(400).json({ ok: false, msg: '文件路径无效' });

  await sshService.exec(vps.id, `rm -f ${shQuote(file.remote_path)}`, req.session.userId).catch(() => {});
  db.prepare('DELETE FROM media_files WHERE id=?').run(file.id);
  res.json({ ok: true, msg: `已删除文件：${file.name}` });
});

router.post('/', (req, res) => {
  const input = normalizeVpsInput(req.body);
  const error = validateVpsInput(input);
  if (error) return renderPage(req, res, { status: 400, error });

  try {
    db.prepare(`
      INSERT INTO vps (user_id, name, host, port, username, auth_type, password, private_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      input.name,
      input.host,
      input.port,
      input.username,
      input.auth_type,
      input.auth_type === 'password' ? encrypt(input.password) : null,
      input.auth_type === 'key' ? encrypt(input.private_key) : null
    );
    res.redirect('/vps?toast=' + encodeURIComponent('VPS 添加成功') + '&type=success');
  } catch (e) {
    renderPage(req, res, { status: 400, error: e.message });
  }
});

router.post('/:id/delete', (req, res) => {
  const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.redirect('/vps?toast=' + encodeURIComponent('VPS 不存在或无权限') + '&type=error');
  db.prepare('UPDATE tasks SET vps_id=NULL WHERE user_id=? AND vps_id=?').run(req.session.userId, vps.id);
  db.prepare('DELETE FROM vps WHERE id=? AND user_id=?').run(vps.id, req.session.userId);
  sshService.disconnect(vps.id, req.session.userId);
  res.redirect('/vps?toast=' + encodeURIComponent('VPS 已删除') + '&type=success');
});

router.post('/:id/test', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在' });
  try {
    sshService.disconnect(vps.id, req.session.userId);
    const ok = await sshService.testConnection(vps);
    const status = ok ? 'online' : 'offline';
    db.prepare('UPDATE vps SET status=?, last_check=CURRENT_TIMESTAMP WHERE id=?').run(status, vps.id);
    res.json({ ok, msg: ok ? '连接成功' : '连接失败' });
  } catch (e) {
    db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/install-xray', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在' });

  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'if command -v xray >/dev/null 2>&1; then echo "Xray 已安装: $(xray version 2>&1 | head -1)"; systemctl is-active xray >/dev/null 2>&1 || systemctl start xray 2>&1; systemctl is-active xray && echo "服务状态: running" || echo "服务状态: stopped"; exit 0; fi',
    'apt-get update -y 2>&1 | tail -2 || true',
    'apt-get install -y curl wget unzip 2>&1 | tail -3 || true',
    'bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install 2>&1 | tail -15',
    'systemctl enable xray 2>&1 || true',
    'systemctl start xray 2>&1 || true',
    'sleep 1',
    'command -v xray >/dev/null 2>&1 && echo "Xray 安装成功: $(xray version 2>&1 | head -1)" || echo "Xray 安装失败，请检查网络或手动安装"',
    'systemctl is-active xray && echo "服务状态: running" || echo "服务状态: stopped"',
  ].join(' && ');

  try {
    const result = await sshService.freshExec(vps.id, script, req.session.userId);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const ok = /Xray (已安装|安装成功)/.test(output) || output.includes('Xray Core');
    res.json({ ok, msg: ok ? 'Xray 安装/启动完成' : '安装可能有问题，请查看输出', output });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

router.post('/:id/install-deps', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在' });

  const douyinScriptB64 = Buffer.from(fs.readFileSync(path.join(__dirname, '..', 'check_douyin.py'), 'utf8')).toString('base64');
  const script = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y 2>&1 | tail -3 || true',
    'apt-get install -y ffmpeg wget python3 python3-pip 2>&1 | tail -5',
    'ARCH=$(uname -m)',
    'if [ "$ARCH" = "aarch64" ]; then YT_BIN=yt-dlp_linux_aarch64; elif [ "$ARCH" = "armv7l" ]; then YT_BIN=yt-dlp_linux_armv7l; else YT_BIN=yt-dlp_linux; fi',
    'wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN"',
    'chmod +x /usr/local/bin/yt-dlp',
    'pip3 install -q --break-system-packages --upgrade streamlink 2>&1 | tail -2 || pip3 install -q --upgrade streamlink 2>&1 | tail -2',
    'mkdir -p /opt/restream-console',
    `echo ${shQuote(douyinScriptB64)} | base64 -d > /opt/restream-console/check_douyin.py`,
    'chmod +x /opt/restream-console/check_douyin.py',
    'echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1)"',
    'echo "yt-dlp: $(yt-dlp --version)"',
    'echo "streamlink: $(streamlink --version 2>/dev/null || echo not-installed)"',
  ].join(' && ');

  try {
    const result = await sshService.freshExec(vps.id, script, req.session.userId);
    const output = (result.stdout + '\n' + result.stderr).trim();
    const ok = output.includes('yt-dlp:') || output.includes('ffmpeg:');
    res.json({ ok, msg: ok ? '依赖安装完成' : '安装可能有问题，请查看输出', output });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

router.get('/:id/stats', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在' });
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
    const result = await sshService.exec(vps.id, cmd, req.session.userId);
    const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const disk = lines[0] ? lines[0].split('|') : [];
    const mem = lines[1] ? lines[1].split('|') : [];
    const uptime = lines[2] || '--';
    const load = lines[3] ? lines[3].split('|') : [];
    res.json({
      ok: true,
      disk: { total: disk[0] || '--', used: disk[1] || '--', avail: disk[2] || '--', pct: disk[3] || '--' },
      mem: { totalMB: parseInt(mem[0], 10) || 0, usedMB: parseInt(mem[1], 10) || 0, freeMB: parseInt(mem[2], 10) || 0 },
      uptime,
      load: { m1: load[0] || '--', m5: load[1] || '--', m15: load[2] || '--' },
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/socks5-config', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在' });

  const port = parseInt(req.body.port, 10) || 1080;
  const user = String(req.body.user || '').trim().slice(0, 64);
  const pass = String(req.body.pass || '').trim().slice(0, 64);
  if (port < 1 || port > 65535) return res.status(400).json({ ok: false, msg: '端口号无效(1-65535)' });
  if ((user && !/^[a-zA-Z0-9_.-]{1,64}$/.test(user)) || /[\r\n\0]/.test(pass)) return res.status(400).json({ ok: false, msg: 'SOCKS5 用户名或密码无效' });

  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port,
      listen: '0.0.0.0',
      protocol: 'socks',
      settings: { auth: user ? 'password' : 'noauth', accounts: user ? [{ user, pass }] : [], udp: true },
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  const cfgB64 = Buffer.from(JSON.stringify(config, null, 2)).toString('base64');
  const marker = `Xray SOCKS5 started on ${port}`;
  const cmd = [
    'mkdir -p /usr/local/etc/xray',
    `echo ${shQuote(cfgB64)} | base64 -d > /usr/local/etc/xray/config.json`,
    'xray -test -config /usr/local/etc/xray/config.json 2>&1 | head -5',
    'systemctl restart xray 2>&1',
    'sleep 1',
    `systemctl is-active xray && echo ${shQuote(marker)}`,
  ].join(' && ');
  try {
    const result = await sshService.exec(vps.id, cmd, req.session.userId);
    const output = (result.stdout + '\n' + result.stderr).trim();
    res.json({ ok: output.includes(marker), output });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/ping-all', async (req, res) => {
  const vpsList = db.prepare('SELECT * FROM vps WHERE user_id=?').all(req.session.userId);
  const results = [];
  for (const vps of vpsList) {
    try {
      sshService.disconnect(vps.id, req.session.userId);
      await new Promise(r => setTimeout(r, 200));
      const ok = await sshService.testConnection(vps);
      const status = ok ? 'online' : 'offline';
      db.prepare('UPDATE vps SET status=?, last_check=CURRENT_TIMESTAMP WHERE id=?').run(status, vps.id);
      results.push({ id: vps.id, status, name: vps.name });
    } catch (e) {
      db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      results.push({ id: vps.id, status: 'offline', name: vps.name, error: e.message });
    }
  }
  res.json({ ok: true, results });
});

module.exports = router;
