const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const multer = require('multer');
const db = require('../db');
const sshService = require('../services/ssh');

const UPLOAD_DIR = '/root/restream_uploads';

const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'restream-' + Date.now() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20 GB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|mkv|avi|ts|mov|flv|wmv|m4v|webm)$/i;
    cb(null, allowed.test(file.originalname));
  },
});

router.get('/', (req, res) => {
  const vpsList = db.prepare('SELECT id, name, host, status FROM vps WHERE user_id=? ORDER BY name').all(req.session.userId);
  const selectedVpsId = parseInt(req.query.vps_id) || vpsList[0]?.id || null;
  const vps = vpsList.find(v => v.id === selectedVpsId) || null;

  let files = [];
  let totalSize = 0;
  if (vps) {
    files = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM tasks WHERE user_id=? AND source_url = m.remote_path) as ref_count
      FROM media_files m WHERE m.user_id=? AND m.vps_id = ? ORDER BY m.created_at DESC
    `).all(req.session.userId, req.session.userId, vps.id);
    totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  }

  res.render('media', {
    title: '媒体库 - 转推控制台',
    currentPath: '/media',
    vpsList, selectedVpsId, vps, files, totalSize,
    UPLOAD_DIR,
  });
});

// 扫描 VPS 上传目录并导入媒体库
router.post('/:vpsId/scan', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在' });

  const cmd = [
    `mkdir -p ${UPLOAD_DIR}`,
    `find ${UPLOAD_DIR} -maxdepth 1 -type f \\( -name "*.mp4" -o -name "*.mkv" -o -name "*.avi" -o -name "*.ts" -o -name "*.mov" -o -name "*.flv" -o -name "*.wmv" \\) | while IFS= read -r f; do echo "$(basename \\"$f\\")|\$f|$(stat -c%s "\$f" 2>/dev/null||echo 0)"; done`,
  ].join(' && ');

  try {
    const result = await sshService.exec(vps.id, cmd);
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    let added = 0;
    let updated = 0;

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const [name, remotePath, sizeStr] = parts;
      if (!name || !remotePath) continue;
      const size = parseInt(sizeStr) || 0;

      const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?').get(req.session.userId, vps.id, remotePath);
      if (existing) {
        db.prepare('UPDATE media_files SET size=?, name=? WHERE id=?').run(size, name, existing.id);
        updated++;
      } else {
        db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)').run(req.session.userId, vps.id, name, remotePath, size);
        added++;
      }
    }

    res.json({
      ok: true,
      msg: `扫描完成：发现 ${lines.length} 个文件，新增 ${added} 条，更新 ${updated} 条`,
      total: lines.length, added,
    });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

// 获取 VPS 磁盘占用（异步加载）
router.get('/:vpsId/disk', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
  if (!vps) return res.json({ ok: false });

  try {
    const result = await sshService.exec(
      vps.id,
      `df -B1 / | awk 'NR==2{printf "%s|%s|%s|%s",$2,$3,$4,$5}'`
    );
    const parts = (result.stdout || '').trim().split('|');
    const total = parseInt(parts[0]) || 0;
    const used  = parseInt(parts[1]) || 0;
    const avail = parseInt(parts[2]) || 0;
    const pct   = parseInt(parts[3]) || 0;
    res.json({ ok: true, total, used, avail, pct });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// 删除媒体文件（VPS + DB）
router.post('/:id/delete', async (req, res) => {
  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!file) {
    return res.redirect('/media?toast=' + encodeURIComponent('文件不存在') + '&type=error');
  }

  try {
    await sshService.exec(file.vps_id, `rm -f "${file.remote_path}"`);
  } catch (_) {}

  db.prepare('DELETE FROM media_files WHERE id=?').run(file.id);
  res.redirect(`/media?vps_id=${file.vps_id}&toast=${encodeURIComponent('已删除文件：' + file.name)}&type=success`);
});

// JSON API：供任务表单选取媒体文件
router.get('/api/list', (req, res) => {
  const vpsId = req.query.vps_id;
  if (!vpsId) return res.json([]);
  const files = db.prepare('SELECT id, name, remote_path, size FROM media_files WHERE user_id=? AND vps_id=? ORDER BY name').all(req.session.userId, vpsId);
  res.json(files);
});

// 文件上传到 VPS（本机 → 临时目录 → SFTP → VPS）
// 安全保障：磁盘预检 → SFTP传输（带重试）→ MD5校验 → 失败清理残缺文件
router.post('/:vpsId/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.json({ ok: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '文件超过 20 GB 限制' : err.message });
    }
    if (err) return res.json({ ok: false, msg: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.json({ ok: false, msg: '未选择文件或格式不支持（仅限 mp4/mkv/avi/ts/mov/flv/wmv/m4v/webm）' });

  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
  if (!vps) {
    fs.unlink(req.file.path, () => {});
    return res.json({ ok: false, msg: 'VPS 不存在' });
  }

  const localPath = req.file.path;
  const fileSize = req.file.size;

  let origName;
  try { origName = Buffer.from(req.file.originalname, 'latin1').toString('utf8'); }
  catch (_) { origName = req.file.originalname; }
  const safeName = origName.replace(/[/\\:*?"<>|]/g, '_');
  const remotePath = `${UPLOAD_DIR}/${safeName}`;

  // 计算本地 MD5（与上传同时进行，不额外耗时）
  function localMd5() {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      fs.createReadStream(localPath)
        .on('data', d => hash.update(d))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
  }

  // SFTP 传输，失败后最多重试 2 次
  async function sftpWithRetry(ssh, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        await ssh.putFile(localPath, remotePath);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < maxTries) {
          console.warn(`[上传] SFTP 第 ${attempt} 次失败，1.5s 后重试：${e.message}`);
          await new Promise(r => setTimeout(r, 1500));
          // 重连（连接可能已断）
          sshService.disconnect(vps.id);
          ssh = await sshService.connect(vps.id);
        }
      }
    }
    throw lastErr;
  }

  try {
    const ssh = await sshService.connect(vps.id);
    await sshService.exec(vps.id, `mkdir -p ${UPLOAD_DIR}`);

    // ① 磁盘空间预检：剩余空间需 > 文件大小 × 1.1
    const diskR = await sshService.exec(vps.id, `df -B1 "${UPLOAD_DIR}" 2>/dev/null || df -B1 / | awk 'NR==2{print $4}'`);
    const avail = parseInt((diskR.stdout || '').trim().split('\n').pop()) || 0;
    if (avail > 0 && avail < fileSize * 1.1) {
      fs.unlink(localPath, () => {});
      const fmt = b => b > 1073741824 ? (b/1073741824).toFixed(1)+'GB' : (b/1048576).toFixed(0)+'MB';
      return res.json({ ok: false, msg: `VPS 磁盘空间不足：剩余 ${fmt(avail)}，文件需要 ${fmt(fileSize)}` });
    }

    // ② SFTP 传输（含重试）
    await sftpWithRetry(ssh);

    // ③ MD5 完整性校验
    const [localHash, remoteHashR] = await Promise.all([
      localMd5(),
      sshService.exec(vps.id, `md5sum "${remotePath}" 2>/dev/null | cut -d' ' -f1`),
    ]);
    const remoteHash = (remoteHashR.stdout || '').trim().toLowerCase();

    if (remoteHash && remoteHash !== localHash) {
      // 校验失败：删除残缺文件，返回错误
      await sshService.exec(vps.id, `rm -f "${remotePath}"`).catch(() => {});
      return res.json({ ok: false, msg: `传输校验失败（MD5 不匹配），VPS 上的残缺文件已自动删除，请重试` });
    }

    // ④ 登记媒体库
    const sizeR = await sshService.exec(vps.id, `stat -c%s "${remotePath}" 2>/dev/null || echo 0`);
    const size = parseInt((sizeR.stdout || '').trim()) || fileSize;

    const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?').get(req.session.userId, vps.id, remotePath);
    if (existing) {
      db.prepare('UPDATE media_files SET size=?, name=? WHERE id=?').run(size, safeName, existing.id);
    } else {
      db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)').run(req.session.userId, vps.id, safeName, remotePath, size);
    }

    const verified = remoteHash ? ' [MD5 已校验]' : '';
    res.json({ ok: true, msg: `上传成功：${safeName}${verified}`, name: safeName, remotePath, size });
  } catch (e) {
    // 传输过程出错：尝试清理 VPS 上可能存在的残缺文件
    sshService.exec(vps.id, `rm -f "${remotePath}"`).catch(() => {});
    res.json({ ok: false, msg: '上传失败：' + e.message });
  } finally {
    fs.unlink(localPath, () => {});
  }
});

module.exports = router;
