const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const sshService = require('../services/ssh');
const { recordLabelForTask } = require('../services/task-manager');

const TITLE = '媒体库 - 转推控制台';
const UPLOAD_DIR = '/root/restream_uploads';
const LEGACY_RECORD_DIR = '/root/restream_recordings';
const DOUYIN_RECORD_DIR = '/root/douyin2youtube/recordings';
const MEDIA_SCAN_DIRS = [UPLOAD_DIR, LEGACY_RECORD_DIR, DOUYIN_RECORD_DIR];
const MAX_UPLOAD_SIZE = 3 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MIN_CHUNK_SIZE = 1024 * 1024;
const MEDIA_EXT_RE = /\.(mp4|mkv|avi|ts|mov|flv|wmv|m4v|webm)$/i;
const UPLOAD_ID_RE = /^[a-f0-9]{32,64}$/i;
const UPLOAD_SESSION_TTL_HOURS = 24;

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function decodeOriginalName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? name : decoded;
  } catch (_) {
    return name;
  }
}

function safeFilename(name) {
  const ext = path.extname(String(name || ''));
  const base = path.basename(String(name || 'media'), ext)
    .replace(/[/\\:*?"<>|$`;\n\r\x00(){}]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const safeBase = (base || 'media').slice(0, 180);
  const safeExt = MEDIA_EXT_RE.test(ext) ? ext : '.mp4';
  return `${safeBase}${safeExt}`;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${n} B`;
}

function getChunkDir(uploadId) {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new Error('上传会话无效');
  return `${UPLOAD_DIR}/.chunks/${uploadId}`;
}

function uniqueFilename(userId, vpsId, safeName) {
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || 'media';
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let candidate = safeName;
  let i = 1;

  while (db.prepare('SELECT 1 FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
    .get(userId, vpsId, `${UPLOAD_DIR}/${candidate}`)) {
    candidate = `${base}_${stamp}_${i}${ext}`;
    i++;
  }

  return candidate;
}

function cleanupExpiredUploadSessions(userId) {
  db.prepare("DELETE FROM upload_sessions WHERE user_id=? AND expires_at < datetime('now')").run(userId);
}

function getUploadSession(uploadId, userId, vpsId) {
  if (!UPLOAD_ID_RE.test(uploadId)) return null;
  return db.prepare(`
    SELECT * FROM upload_sessions
    WHERE id=? AND user_id=? AND vps_id=? AND expires_at > datetime('now')
  `).get(uploadId, userId, vpsId);
}

function getChunkName(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > 999999) throw new Error('分片序号无效');
  return `${String(n).padStart(6, '0')}.part`;
}

function isAllowedMediaPath(remotePath) {
  return typeof remotePath === 'string' &&
    MEDIA_SCAN_DIRS.some(dir => remotePath.startsWith(`${dir}/`)) &&
    !remotePath.includes('/../') &&
    !remotePath.includes('\0') &&
    MEDIA_EXT_RE.test(remotePath);
}

function isInternalMediaName(name) {
  return /^task_\d+_latest\.ts$/i.test(path.basename(String(name || '')));
}

function parseUploadedChunks(stdout, chunkSize, fileSize) {
  const uploaded = [];
  const sizes = {};

  for (const line of String(stdout || '').trim().split('\n').filter(Boolean)) {
    const [name, sizeStr] = line.split('\t');
    const match = name && name.match(/^(\d{6})\.part$/);
    if (!match) continue;

    const index = parseInt(match[1], 10);
    const size = parseInt(sizeStr, 10) || 0;
    const expected = Math.min(chunkSize, Math.max(0, fileSize - index * chunkSize));
    if (size > 0 && expected > 0 && size === expected) {
      uploaded.push(index);
      sizes[index] = size;
    }
  }

  return { uploaded, sizes };
}

async function scanVpsFiles(userId, vpsId) {
  const dirs = MEDIA_SCAN_DIRS.map(shQuote).join(' ');
  const cmd = [
    `mkdir -p ${shQuote(UPLOAD_DIR)}`,
    // 救援超过 1 小时未修改的录播临时文件（正常录制中的文件不会超过 1 小时不更新）
    `find ${shQuote(UPLOAD_DIR)} -maxdepth 1 -type f -name "task_*_recording.tmp" -mmin +60 2>/dev/null | while IFS= read -r f; do mv -f "$f" "\${f%.tmp}.ts" 2>/dev/null || true; done`,
    `for d in ${dirs}; do [ -d "$d" ] || continue; find "$d" -maxdepth 1 -type f \\( -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.avi" -o -iname "*.ts" -o -iname "*.mov" -o -iname "*.flv" -o -iname "*.wmv" -o -iname "*.m4v" -o -iname "*.webm" \\) ! -name "*.tmp" ! -name "*.part" ! -name "*.uploading-*" ! -name "task_*_latest.ts" | while IFS= read -r f; do printf '%s\\t%s\\t%s\\n' "$(basename "$f")" "$f" "$(stat -c%s "$f" 2>/dev/null || echo 0)"; done; done`,
  ].join(' && ');

  const result = await sshService.exec(vpsId, cmd, userId);
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  let added = 0;
  let updated = 0;

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [name, remotePath, sizeStr] = parts;
    if (!name || !isAllowedMediaPath(remotePath)) continue;
    if (isInternalMediaName(name)) continue;

    const size = parseInt(sizeStr, 10) || 0;
    const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .get(userId, vpsId, remotePath);

    if (existing) {
      db.prepare('UPDATE media_files SET size=?, name=? WHERE id=?').run(size, name, existing.id);
      updated++;
    } else {
      db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
        .run(userId, vpsId, name, remotePath, size);
      added++;
    }
  }

  return { total: lines.length, added, updated };
}

async function getAvailableBytes(vpsId, userId, targetDir = UPLOAD_DIR) {
  const result = await sshService.exec(
    vpsId,
    `df -B1 ${shQuote(targetDir)} 2>/dev/null | awk 'NR==2{print $4}' || df -B1 / | awk 'NR==2{print $4}'`,
    userId
  );
  return parseInt((result.stdout || '').trim().split('\n').pop(), 10) || 0;
}

async function cleanupStaleChunkTemps(vpsId, userId, uploadId) {
  const chunkDir = getChunkDir(uploadId);
  await sshService.exec(
    vpsId,
    `find ${shQuote(chunkDir)} -maxdepth 1 -type f -name '*.uploading-*' -mmin +5 -delete 2>/dev/null || true`,
    userId
  ).catch(() => {});
}

function createDirectVpsStorage() {
  return {
    _handleFile(req, file, cb) {
      (async () => {
        const userId = req.session.userId;
        const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, userId);
        if (!vps) throw new Error('VPS 不存在或无权限');

        const originalName = decodeOriginalName(file.originalname || 'media.mp4');
        if (!req._uploadTargetName && !MEDIA_EXT_RE.test(originalName)) {
          file.stream.resume();
          throw new Error('不支持的媒体格式，仅支持 mp4/mkv/avi/ts/mov/flv/wmv/m4v/webm');
        }

        const safeName = req._uploadTargetName || safeFilename(originalName);
        const targetDir = req._uploadTargetDir || UPLOAD_DIR;
        const remotePath = `${targetDir}/${safeName}`;
        const remoteTempPath = req._writeDirectToFinal
          ? remotePath
          : `${remotePath}.uploading-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const contentLength = parseInt(req.headers['content-length'] || '0', 10) || 0;

        await sshService.exec(vps.id, `mkdir -p ${shQuote(targetDir)}`, userId);
        const avail = await getAvailableBytes(vps.id, userId, targetDir);
        if (avail > 0 && contentLength > 0 && avail < contentLength * 1.03) {
          file.stream.resume();
          throw new Error(`VPS 剩余空间不足，剩余 ${formatBytes(avail)}，本次写入约 ${formatBytes(contentLength)}`);
        }

        const ssh = await sshService.connect(vps.id, userId);
        const sftp = await new Promise((resolve, reject) => {
          ssh.connection.sftp((err, client) => err ? reject(err) : resolve(client));
        });

        const hash = crypto.createHash('md5');
        let size = 0;
        let done = false;

        const finish = (err, info) => {
          if (done) return;
          done = true;
          if (err) {
            try { sftp.end(); } catch (_) {}
            sshService.exec(vps.id, `rm -f ${shQuote(remoteTempPath)}`, userId).catch(() => {});
            cb(err);
          } else {
            cb(null, info);
          }
        };

        const write = sftp.createWriteStream(remoteTempPath, { flags: 'w', mode: 0o644 });
        file.stream.on('data', chunk => {
          size += chunk.length;
          hash.update(chunk);
        });
        file.stream.on('limit', () => finish(new Error('文件超过上传限制')));
        file.stream.on('error', finish);
        write.on('error', finish);
        write.on('finish', () => {
          finish(null, {
            userId,
            vpsId: vps.id,
            name: safeName,
            originalName,
            remotePath,
            remoteTempPath,
            size,
            md5: hash.digest('hex'),
            closeSftp: () => { try { sftp.end(); } catch (_) {} },
          });
        });
        file.stream.pipe(write);
      })().catch(cb);
    },
    _removeFile(req, file, cb) {
      if (file?.vpsId && file?.remoteTempPath) {
        if (typeof file.closeSftp === 'function') file.closeSftp();
        sshService.exec(file.vpsId, `rm -f ${shQuote(file.remoteTempPath)}`, file.userId || req.session.userId)
          .finally(() => cb(null));
      } else {
        cb(null);
      }
    },
  };
}

const chunkUpload = multer({
  storage: createDirectVpsStorage(),
  limits: { fileSize: MAX_CHUNK_SIZE },
});

router.get('/', (req, res) => {
  const vpsList = db.prepare('SELECT id, name, host, status FROM vps WHERE user_id=? ORDER BY name').all(req.session.userId);
  const selectedVpsId = parseInt(req.query.vps_id, 10) || vpsList[0]?.id || null;
  const vps = vpsList.find(v => v.id === selectedVpsId) || null;

  let files = [];
  let totalSize = 0;
  if (vps) {
    files = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM tasks WHERE user_id=? AND source_url = m.remote_path) as ref_count
      FROM media_files m
      WHERE m.user_id=? AND m.vps_id=?
        AND m.name NOT GLOB 'task_*_latest.ts'
      ORDER BY m.created_at DESC
    `).all(req.session.userId, req.session.userId, vps.id);
    totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
  }

  res.render('media', {
    title: TITLE,
    currentPath: '/media',
    vpsList,
    selectedVpsId,
    vps,
    files,
    totalSize,
    UPLOAD_DIR,
  });
});

router.get('/api/list', (req, res) => {
  const vpsId = req.query.vps_id;
  if (!vpsId) return res.json([]);
  const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(vpsId, req.session.userId);
  if (!vps) return res.json([]);
  const files = db.prepare(`
    SELECT id, name, remote_path, size
    FROM media_files
    WHERE user_id=? AND vps_id=? AND name NOT GLOB 'task_*_latest.ts'
    ORDER BY name
  `)
    .all(req.session.userId, vps.id);
  res.json(files);
});

router.post('/:vpsId/upload-session', async (req, res) => {
  const userId = req.session.userId;
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在或无权限' });

  const originalName = String(req.body.name || '').trim();
  const fileSize = parseInt(req.body.size || '0', 10);
  const requestedChunkSize = parseInt(req.body.chunkSize || String(DEFAULT_CHUNK_SIZE), 10);
  const chunkSize = Math.max(MIN_CHUNK_SIZE, Math.min(MAX_CHUNK_SIZE, requestedChunkSize || DEFAULT_CHUNK_SIZE));

  if (!originalName || !MEDIA_EXT_RE.test(originalName)) {
    return res.status(400).json({ ok: false, msg: '不支持的媒体格式，仅支持 mp4/mkv/avi/ts/mov/flv/wmv/m4v/webm' });
  }
  if (!fileSize || fileSize <= 0) return res.status(400).json({ ok: false, msg: '文件大小无效' });
  if (fileSize > MAX_UPLOAD_SIZE) return res.status(400).json({ ok: false, msg: '文件超过 3 GB 限制' });

  cleanupExpiredUploadSessions(userId);

  const safeName = uniqueFilename(userId, vps.id, safeFilename(originalName));
  const remotePath = `${UPLOAD_DIR}/${safeName}`;
  const uploadId = crypto.randomBytes(32).toString('hex');
  const chunkDir = getChunkDir(uploadId);
  const totalChunks = Math.ceil(fileSize / chunkSize);

  try {
    await sshService.exec(vps.id, `mkdir -p ${shQuote(chunkDir)}`, userId);
    const avail = await getAvailableBytes(vps.id, userId, UPLOAD_DIR);
    if (avail > 0 && avail < fileSize * 1.03) {
      await sshService.exec(vps.id, `rm -rf ${shQuote(chunkDir)}`, userId).catch(() => {});
      return res.status(400).json({
        ok: false,
        msg: `VPS 剩余空间不足，剩余 ${formatBytes(avail)}，文件大小 ${formatBytes(fileSize)}`,
      });
    }

    db.prepare(`
      INSERT INTO upload_sessions (id, user_id, vps_id, name, original_name, remote_path, size, chunk_size, total_chunks, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
    `).run(
      uploadId,
      userId,
      vps.id,
      safeName,
      originalName,
      remotePath,
      fileSize,
      chunkSize,
      totalChunks,
      `+${UPLOAD_SESSION_TTL_HOURS} hours`
    );

    const listR = await sshService.exec(
      vps.id,
      `find ${shQuote(chunkDir)} -maxdepth 1 -type f -name '*.part' -printf '%f\\t%s\\n' 2>/dev/null || true`,
      userId
    );
    const { uploaded } = parseUploadedChunks(listR.stdout, chunkSize, fileSize);
    cleanupStaleChunkTemps(vps.id, userId, uploadId);

    res.json({ ok: true, uploadId, chunkSize, totalChunks, uploaded, name: safeName, remotePath });
  } catch (e) {
    res.status(500).json({ ok: false, msg: '创建上传会话失败：' + e.message });
  }
});

router.post('/:vpsId/upload-chunk', (req, res, next) => {
  try {
    const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
    if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在或无权限' });

    const uploadId = String(req.query.uploadId || req.body?.uploadId || '');
    const index = parseInt(String(req.query.index ?? req.body?.index ?? ''), 10);
    const session = getUploadSession(uploadId, req.session.userId, vps.id);
    if (!session) return res.status(400).json({ ok: false, msg: '上传会话无效或已过期' });
    if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
      return res.status(400).json({ ok: false, msg: '分片序号无效' });
    }

    req._uploadSession = session;
    req._chunkUploadId = uploadId;
    req._chunkIndex = index;
    req._uploadTargetDir = getChunkDir(uploadId);
    req._uploadTargetName = getChunkName(index);
    req._writeDirectToFinal = true;
  } catch (e) {
    return res.status(400).json({ ok: false, msg: e.message });
  }

  chunkUpload.single('chunk')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        ok: false,
        msg: err.code === 'LIMIT_FILE_SIZE' ? '单个分片超过 16 MB 限制' : err.message,
      });
    }
    if (err) return res.status(400).json({ ok: false, msg: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, msg: '分片为空' });

  const file = req.file;
  const session = req._uploadSession;
  const expectedSize = Math.min(session.chunk_size, session.size - req._chunkIndex * session.chunk_size);

  try {
    if (typeof file.closeSftp === 'function') file.closeSftp();
    if (file.size !== expectedSize) {
      await sshService.exec(file.vpsId, `rm -f ${shQuote(file.remotePath)} ${shQuote(file.remoteTempPath)}`, req.session.userId)
        .catch(() => {});
      return res.status(400).json({ ok: false, msg: `分片大小不匹配，应为 ${expectedSize}，实际 ${file.size}` });
    }

    if (file.remoteTempPath !== file.remotePath) {
      await sshService.exec(file.vpsId, `mv -f ${shQuote(file.remoteTempPath)} ${shQuote(file.remotePath)}`, req.session.userId);
    }

    res.json({ ok: true, uploadId: req._chunkUploadId, index: req._chunkIndex, size: file.size, md5: file.md5 });
  } catch (e) {
    await sshService.exec(file.vpsId, `rm -f ${shQuote(file.remotePath)} ${shQuote(file.remoteTempPath)}`, req.session.userId)
      .catch(() => {});
    res.status(500).json({ ok: false, msg: '分片上传失败：' + e.message });
  }
});

router.post('/:vpsId/upload-complete', async (req, res) => {
  const userId = req.session.userId;
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, userId);
  if (!vps) return res.status(404).json({ ok: false, msg: 'VPS 不存在或无权限' });

  const uploadId = String(req.body.uploadId || '');
  const session = getUploadSession(uploadId, userId, vps.id);
  if (!session) return res.status(400).json({ ok: false, msg: '上传会话无效或已过期' });

  const originalName = session.original_name;
  const fileSize = session.size;
  const chunkSize = session.chunk_size;
  if (!UPLOAD_ID_RE.test(uploadId)) return res.status(400).json({ ok: false, msg: '上传会话无效' });
  if (!originalName || !MEDIA_EXT_RE.test(originalName)) return res.status(400).json({ ok: false, msg: '不支持的媒体格式' });
  if (!fileSize || fileSize > MAX_UPLOAD_SIZE) return res.status(400).json({ ok: false, msg: '文件大小无效或超过 3 GB 限制' });

  const safeName = session.name;
  const remotePath = session.remote_path;
  if (!isAllowedMediaPath(remotePath)) return res.status(400).json({ ok: false, msg: '目标路径无效' });

  const finalTempPath = `${remotePath}.merging-${Date.now()}`;
  const chunkDir = getChunkDir(uploadId);
  const totalChunks = session.total_chunks;

  try {
    const existingBefore = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .get(userId, vps.id, remotePath);
    if (existingBefore) {
      return res.status(409).json({ ok: false, msg: '目标文件已存在，请重新选择文件创建上传会话' });
    }

    const listR = await sshService.exec(
      vps.id,
      `find ${shQuote(chunkDir)} -maxdepth 1 -type f -name '*.part' -printf '%f\\t%s\\n' 2>/dev/null || true`,
      userId
    );
    const { uploaded } = parseUploadedChunks(listR.stdout, chunkSize, fileSize);
    if (uploaded.length !== totalChunks) {
      const have = new Set(uploaded);
      const missing = [];
      for (let i = 0; i < totalChunks && missing.length < 10; i++) {
        if (!have.has(i)) missing.push(i);
      }
      return res.status(409).json({ ok: false, msg: `缺少 ${totalChunks - uploaded.length} 个分片`, missing });
    }

    const concatCmd = [
      `rm -f ${shQuote(finalTempPath)}`,
      `for f in ${shQuote(chunkDir)}/*.part; do cat "$f" >> ${shQuote(finalTempPath)}; done`,
      `size=$(stat -c%s ${shQuote(finalTempPath)} 2>/dev/null || echo 0)`,
      `if [ "$size" != "${fileSize}" ]; then echo "SIZE_MISMATCH:$size"; exit 23; fi`,
      `mv -f ${shQuote(finalTempPath)} ${shQuote(remotePath)}`,
      `rm -rf ${shQuote(chunkDir)}`,
    ].join(' && ');

    const mergeR = await sshService.exec(vps.id, concatCmd, userId);
    if (mergeR.code && mergeR.code !== 0) {
      const detail = (mergeR.stdout || mergeR.stderr || `exit ${mergeR.code}`).trim();
      return res.status(500).json({ ok: false, msg: '合并文件失败：' + detail });
    }

    const sizeR = await sshService.exec(vps.id, `stat -c%s ${shQuote(remotePath)} 2>/dev/null || echo 0`, userId);
    const size = parseInt((sizeR.stdout || '').trim(), 10) || fileSize;
    db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
      .run(userId, vps.id, safeName, remotePath, size);
    db.prepare('DELETE FROM upload_sessions WHERE id=? AND user_id=?').run(uploadId, userId);

    res.json({ ok: true, msg: `上传完成：${safeName}`, name: safeName, remotePath, size });
  } catch (e) {
    await sshService.exec(vps.id, `rm -f ${shQuote(finalTempPath)}`, userId).catch(() => {});
    res.status(500).json({ ok: false, msg: '完成上传失败：' + e.message });
  }
});

router.post('/:vpsId/scan', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在或无权限' });

  try {
    const result = await scanVpsFiles(req.session.userId, vps.id);
    res.json({
      ok: true,
      msg: `扫描完成：发现 ${result.total} 个文件，新增 ${result.added} 个，更新 ${result.updated} 个`,
      ...result,
    });
  } catch (e) {
    res.json({ ok: false, msg: '扫描失败：' + e.message });
  }
});

// 修复乱码录播文件名：将 task_N_recording.ts / 乱码命名重命名为 录播_YYYYMMDD_HHMMSS_label_taskN.ts
router.post('/:vpsId/fix-names', async (req, res) => {
  const userId = req.session.userId;
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在或无权限' });

  try {
    // 从 VPS 获取所有上传目录中疑似乱码/旧格式的录播文件
    // 特征：以 task_ 开头（旧格式），或文件名含 \x?? 非 ASCII 序列（shell 乱码）
    const dirs = MEDIA_SCAN_DIRS.map(shQuote).join(' ');
    const findCmd = `for d in ${dirs}; do [ -d "$d" ] || continue; find "$d" -maxdepth 1 -type f -iname "*.ts" ! -name "task_*_latest.ts" | while IFS= read -r f; do b=$(basename "$f"); printf '%s\\t%s\\t%s\\n' "$b" "$f" "$(stat -c%s "$f" 2>/dev/null || echo 0)"; done; done`;
    const findR = await sshService.exec(vps.id, findCmd, userId);
    const lines = (findR.stdout || '').trim().split('\n').filter(Boolean);

    let renamed = 0;
    let skipped = 0;
    const errors = [];

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [name, remotePath] = parts;

      // 从文件名末尾提取 taskN，支持两种格式：
      // 旧格式：task_N_recording.ts（存在于内存中的 recording 临时文件改后缀）
      // 乱码格式：<乱码>_taskN.ts（中文录播前缀在非 UTF-8 shell 中乱码）
      const taskMatch = name.match(/[_\-]?task[_\-]?(\d+)[_\-]?(?:recording)?\.ts$/i)
        || name.match(/_task(\d+)\.ts$/i);
      if (!taskMatch) { skipped++; continue; }

      const taskId = parseInt(taskMatch[1], 10);
      const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, userId);
      if (!task) { skipped++; continue; }

      // 提取文件修改时间（作为录播时间）
      const mtimeR = await sshService.exec(vps.id, `stat -c%Y ${shQuote(remotePath)} 2>/dev/null || echo 0`, userId);
      const mtime = parseInt((mtimeR.stdout || '').trim(), 10) || Math.floor(Date.now() / 1000);

      // 格式化为上海时间（VPS 上执行以复用 date 命令）
      const tsR = await sshService.exec(
        vps.id,
        `TZ=Asia/Shanghai date -d @${mtime} +%Y%m%d_%H%M%S 2>/dev/null || date -u -d "@$((${mtime} + 28800))" +%Y%m%d_%H%M%S 2>/dev/null || date +%Y%m%d_%H%M%S`,
        userId
      );
      const ts = (tsR.stdout || '').trim() || new Date(mtime * 1000).toISOString().slice(0,19).replace(/[-T:]/g, (c) => c === 'T' ? '_' : c).replace(/[:-]/g, '');

      const label = recordLabelForTask(task);
      const newName = `录播_${ts}_${label}_task${taskId}.ts`;
      const dir = path.posix.dirname(remotePath);
      const newPath = `${dir}/${newName}`;

      // 跳过已经是正确格式的文件名
      if (name === newName) { skipped++; continue; }

      // 目标路径不能冲突
      const checkR = await sshService.exec(vps.id, `[ -e ${shQuote(newPath)} ] && echo exists || echo ok`, userId);
      if ((checkR.stdout || '').trim() === 'exists') {
        errors.push(`${name} → 目标文件已存在，跳过`);
        skipped++;
        continue;
      }

      try {
        await sshService.exec(vps.id, `mv ${shQuote(remotePath)} ${shQuote(newPath)}`, userId);

        // 更新 DB 记录
        const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
          .get(userId, vps.id, remotePath);
        if (existing) {
          db.prepare('UPDATE media_files SET name=?, remote_path=? WHERE id=?').run(newName, newPath, existing.id);
        } else {
          const size = parseInt(parts[2], 10) || 0;
          db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
            .run(userId, vps.id, newName, newPath, size);
        }
        renamed++;
      } catch (mvErr) {
        errors.push(`${name} → 重命名失败: ${mvErr.message}`);
        skipped++;
      }
    }

    res.json({
      ok: true,
      msg: `修复完成：重命名 ${renamed} 个，跳过 ${skipped} 个${errors.length ? `，${errors.length} 个错误` : ''}`,
      renamed, skipped, errors,
    });
  } catch (e) {
    res.json({ ok: false, msg: '修复文件名失败：' + e.message });
  }
});

router.get('/:vpsId/disk', async (req, res) => {
  const vps = db.prepare('SELECT * FROM vps WHERE id=? AND user_id=?').get(req.params.vpsId, req.session.userId);
  if (!vps) return res.json({ ok: false, msg: 'VPS 不存在或无权限' });

  try {
    const result = await sshService.exec(
      vps.id,
      `df -B1 / | awk 'NR==2{printf "%s|%s|%s|%s",$2,$3,$4,$5}'`,
      req.session.userId
    );
    const parts = (result.stdout || '').trim().split('|');
    res.json({
      ok: true,
      total: parseInt(parts[0], 10) || 0,
      used: parseInt(parts[1], 10) || 0,
      avail: parseInt(parts[2], 10) || 0,
      pct: parseInt(parts[3], 10) || 0,
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/delete', async (req, res) => {
  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  const wantsJson = req.headers.accept?.includes('application/json');
  if (!file) {
    if (wantsJson) return res.status(404).json({ ok: false, msg: '文件不存在' });
    return res.redirect('/media?toast=' + encodeURIComponent('文件不存在') + '&type=error');
  }

  const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(file.vps_id, req.session.userId);
  if (!vps || !isAllowedMediaPath(file.remote_path)) {
    if (wantsJson) return res.status(400).json({ ok: false, msg: '文件路径无效或 VPS 无权限' });
    return res.redirect('/media?toast=' + encodeURIComponent('文件路径无效或 VPS 无权限') + '&type=error');
  }

  try {
    await sshService.exec(file.vps_id, `rm -f ${shQuote(file.remote_path)}`, req.session.userId);
  } catch (_) {}

  db.prepare('DELETE FROM media_files WHERE id=? AND user_id=?').run(file.id, req.session.userId);

  if (wantsJson) return res.json({ ok: true, msg: `已删除 ${file.name}` });
  res.redirect(`/media?vps_id=${file.vps_id}&toast=${encodeURIComponent('已删除 ' + file.name)}&type=success`);
});

module.exports = router;
