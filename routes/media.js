const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const sshService = require('../services/ssh');

// In-memory job store for long-running VPS tasks (vocals removal etc.)
const pendingJobs = new Map();

const TITLE = '媒体库 - 转推控制台';
const UPLOAD_DIR = '/root/restream_uploads';
const MEDIA_SCAN_DIRS = [UPLOAD_DIR];
const MAX_UPLOAD_SIZE = 3 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MIN_CHUNK_SIZE = 1024 * 1024;
const MEDIA_EXT_RE = /\.(mp4|mkv|avi|ts|mov|flv|wmv|m4v|webm)$/i;
const UPLOAD_ID_RE = /^[a-f0-9]{32,64}$/i;
const UPLOAD_SESSION_TTL_HOURS = 24;
const REMOTE_CHUNK_WRITE_TIMEOUT_MS = 150 * 1000;

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

async function writeRemoteFileViaSshStdin(vpsId, userId, remotePath, source, req, onChunk) {
  const ssh = await sshService.connect(vpsId, userId);
  const command = `cat > ${shQuote(remotePath)}`;

  return new Promise((resolve, reject) => {
    let done = false;
    let inputEnded = false;
    let channel = null;
    let exitCode = 0;
    let exitSignal = null;
    let stderr = '';
    let writeTimer = null;

    const cleanup = () => {
      if (writeTimer) clearTimeout(writeTimer);
      source.off('data', handleData);
      source.off('end', handleEnd);
      source.off('limit', handleLimit);
      source.off('error', finish);
      req.off('aborted', handleAbort);
      if (channel) {
        channel.off('error', finish);
      }
    };

    const finish = (err) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) {
        try { source.unpipe(channel); } catch (_) {}
        try { channel?.destroy(); } catch (_) {}
        return reject(err);
      }
      resolve();
    };

    const resetWriteTimer = () => {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        finish(new Error('VPS write timeout; check network, disk IO, or SSH connection'));
      }, REMOTE_CHUNK_WRITE_TIMEOUT_MS);
    };

    const handleData = (chunk) => {
      onChunk(chunk);
      resetWriteTimer();
    };

    const handleEnd = () => {
      inputEnded = true;
      resetWriteTimer();
    };

    const handleLimit = () => finish(new Error('file exceeds upload limit'));
    const handleAbort = () => finish(new Error('upload request aborted'));

    source.pause();
    source.on('limit', handleLimit);
    source.on('error', finish);
    req.on('aborted', handleAbort);

    ssh.connection.exec(command, (err, ch) => {
      if (err) return finish(err);
      channel = ch;
      resetWriteTimer();

      ch.stderr.on('data', chunk => {
        stderr = (stderr + String(chunk)).slice(-800);
      });
      ch.on('data', () => {});
      ch.on('error', finish);
      ch.on('exit', (code, signal) => {
        exitCode = code || 0;
        exitSignal = signal || null;
      });
      ch.on('close', () => {
        if (!inputEnded) {
          return finish(new Error('VPS write channel closed before upload completed'));
        }
        if (exitCode !== 0 || exitSignal) {
          const detail = (stderr || exitSignal || `exit ${exitCode}`).trim();
          return finish(new Error(`VPS write command failed: ${detail}`));
        }
        finish();
      });

      source.on('data', handleData);
      source.on('end', handleEnd);
      source.pipe(ch);
    });
  });
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

        if (!req._uploadSession) {
          await sshService.exec(vps.id, `mkdir -p ${shQuote(targetDir)}`, userId);
          const avail = await getAvailableBytes(vps.id, userId, targetDir);
          if (avail > 0 && contentLength > 0 && avail < contentLength * 1.03) {
            file.stream.resume();
            throw new Error(`VPS 剩余空间不足，剩余 ${formatBytes(avail)}，本次写入约 ${formatBytes(contentLength)}`);
          }
        }

        const hash = crypto.createHash('md5');
        let size = 0;
        await writeRemoteFileViaSshStdin(vps.id, userId, remoteTempPath, file.stream, req, chunk => {
          size += chunk.length;
          hash.update(chunk);
        });

        cb(null, {
          userId,
          vpsId: vps.id,
          name: safeName,
          originalName,
          remotePath,
          remoteTempPath,
          size,
          md5: hash.digest('hex'),
        });
      })().catch(cb);
    },
    _removeFile(req, file, cb) {
      if (file?.vpsId && file?.remoteTempPath) {
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

router.get('/csrf', (req, res) => {
  res.json({ token: req.session.csrfToken || '' });
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

  // 同名同大小的活跃会话直接复用，支持断点续传
  const existing = db.prepare(`
    SELECT * FROM upload_sessions
    WHERE user_id=? AND vps_id=? AND original_name=? AND size=? AND expires_at > datetime('now')
    ORDER BY expires_at DESC LIMIT 1
  `).get(userId, vps.id, originalName, fileSize);

  if (existing) {
    try {
      const existingChunkDir = getChunkDir(existing.id);
      const listR = await sshService.exec(
        vps.id,
        `find ${shQuote(existingChunkDir)} -maxdepth 1 -type f -name '*.part' -printf '%f\\t%s\\n' 2>/dev/null || true`,
        userId
      );
      const { uploaded } = parseUploadedChunks(listR.stdout, existing.chunk_size, fileSize);
      cleanupStaleChunkTemps(vps.id, userId, existing.id);
      return res.json({
        ok: true, uploadId: existing.id, chunkSize: existing.chunk_size,
        totalChunks: existing.total_chunks, uploaded, name: existing.name,
        remotePath: existing.remote_path, resumed: true,
      });
    } catch (_) {
      // 无法查询已有会话时继续创建新会话
    }
  }

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

router.get('/jobs/:jobId', (req, res) => {
  const job = pendingJobs.get(req.params.jobId);
  if (!job || job.userId !== req.session.userId) return res.status(404).json({ ok: false, msg: '任务不存在' });
  const { userId: _u, ...safe } = job;
  res.json({ ok: true, ...safe });
});

router.get('/:id/download', async (req, res) => {
  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=?')
    .get(req.params.id, req.session.userId);
  if (!file) return res.status(404).send('文件不存在');
  if (!isAllowedMediaPath(file.remote_path)) return res.status(400).send('路径无效');

  const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(file.vps_id, req.session.userId);
  if (!vps) return res.status(403).send('无权限');

  const safeName = encodeURIComponent(file.name).replace(/'/g, '%27');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  if (file.size) res.setHeader('Content-Length', file.size);

  try {
    const ssh = await sshService.connect(file.vps_id, req.session.userId);
    const sftp = await new Promise((resolve, reject) => {
      ssh.connection.sftp((err, client) => (err ? reject(err) : resolve(client)));
    });
    const stream = sftp.createReadStream(file.remote_path);
    stream.on('error', () => { try { sftp.end(); } catch (_) {} res.end(); });
    stream.on('close', () => { try { sftp.end(); } catch (_) {} });
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) return res.status(500).send('连接 VPS 失败：' + e.message);
    res.end();
  }
});

router.post('/:id/remove-vocals', async (req, res) => {
  const userId = req.session.userId;
  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=?').get(req.params.id, userId);
  if (!file) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if (!isAllowedMediaPath(file.remote_path)) return res.status(400).json({ ok: false, msg: '路径无效' });

  const ext = path.extname(file.remote_path);
  const dir = path.posix.dirname(file.remote_path);
  const baseName = path.basename(file.remote_path, ext);
  const outName = `${baseName}_novoice${ext}`;
  const outPath = `${dir}/${outName}`;

  // Reject if output already exists in DB
  const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
    .get(userId, file.vps_id, outPath);
  if (existing) return res.json({ ok: false, msg: `消声版已存在：${outName}` });

  const jobId = crypto.randomBytes(16).toString('hex');
  pendingJobs.set(jobId, { userId, fileId: file.id, status: 'running', startedAt: Date.now() });

  // Run ffmpeg in background (audio phase cancellation, video stream copied)
  (async () => {
    const job = pendingJobs.get(jobId);
    try {
      const ffCmd = [
        'ffmpeg -y',
        `-i ${shQuote(file.remote_path)}`,
        `-af 'pan=stereo|c0=c0-c1|c1=c1-c0'`,
        '-c:v copy',
        shQuote(outPath),
      ].join(' ');
      const r = await sshService.exec(file.vps_id, ffCmd, userId);
      if (r.code && r.code !== 0) {
        const detail = (r.stdout || r.stderr || `exit ${r.code}`).slice(-300);
        throw new Error(detail);
      }
      const sizeR = await sshService.exec(file.vps_id, `stat -c%s ${shQuote(outPath)} 2>/dev/null || echo 0`, userId);
      const size = parseInt((sizeR.stdout || '').trim(), 10) || 0;
      const ins = db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
        .run(userId, file.vps_id, outName, outPath, size);
      job.status = 'done';
      job.newFileId = ins.lastInsertRowid;
      job.outputName = outName;
    } catch (e) {
      if (job) { job.status = 'error'; job.error = e.message.slice(0, 300); }
    } finally {
      setTimeout(() => pendingJobs.delete(jobId), 30 * 60 * 1000);
    }
  })();

  res.json({ ok: true, jobId, msg: '消除人声任务已启动，视频将保留背景音乐' });
});

router.post('/:id/transcode', async (req, res) => {
  const userId = req.session.userId;
  const file = db.prepare('SELECT * FROM media_files WHERE id=? AND user_id=?').get(req.params.id, userId);
  if (!file) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if (!isAllowedMediaPath(file.remote_path)) return res.status(400).json({ ok: false, msg: '路径无效' });

  const ext = path.extname(file.remote_path);
  const dir = path.posix.dirname(file.remote_path);
  const baseName = path.basename(file.remote_path, ext);
  const outName = `${baseName}_h264${ext}`;
  const outPath = `${dir}/${outName}`;
  // 转码期间写临时文件，完成后改名，防止扫描把半成品登记进库
  const tmpPath = `${outPath}.transcoding`;

  const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
    .get(userId, file.vps_id, outPath);
  if (existing) return res.json({ ok: false, msg: `H.264 版本已存在：${outName}` });

  const jobId = crypto.randomBytes(16).toString('hex');
  const doneFile = `/tmp/transcode_${jobId}.done`;
  const logFile = `/tmp/transcode_${jobId}.log`;
  const scriptPath = `/tmp/transcode_${jobId}.sh`;
  pendingJobs.set(jobId, { userId, fileId: file.id, status: 'running', startedAt: Date.now() });

  (async () => {
    const job = pendingJobs.get(jobId);
    try {
      // 把内层脚本 base64 编码后写到 VPS 临时 .sh 文件再执行
      // 避免 bash -c '...' 与 shQuote 单引号嵌套互相截断导致语法错误
      const innerScript = [
        '#!/bin/bash',
        `rm -f ${shQuote(tmpPath)}`,
        `ffmpeg -y -i ${shQuote(file.remote_path)} -c:v libx264 -preset veryfast -crf 18 -g 48 -keyint_min 48 -c:a copy -f mp4 ${shQuote(tmpPath)} >${shQuote(logFile)} 2>&1`,
        `_RC=$?`,
        `[ "$_RC" -eq 0 ] && mv -f ${shQuote(tmpPath)} ${shQuote(outPath)}`,
        `echo "$_RC" >${shQuote(doneFile)}`,
      ].join('\n');
      const b64 = Buffer.from(innerScript).toString('base64');
      await sshService.exec(file.vps_id, `printf '%s' '${b64}' | base64 -d >${shQuote(scriptPath)} && chmod +x ${shQuote(scriptPath)}`, userId);
      await sshService.exec(file.vps_id, `nohup ${shQuote(scriptPath)} >/dev/null 2>&1 &`, userId);

      // 每 30 秒轮询一次，最长等 4 小时
      const MAX_WAIT_MS = 4 * 60 * 60 * 1000;
      const startedAt = Date.now();
      while (true) {
        await new Promise(r => setTimeout(r, 30000));
        if (!pendingJobs.has(jobId)) break;
        const r = await sshService.exec(file.vps_id, `cat ${shQuote(doneFile)} 2>/dev/null`, userId);
        const exitCode = r.stdout.trim();
        if (exitCode !== '') {
          if (exitCode !== '0') {
            const errLog = await sshService.exec(file.vps_id, `tail -5 ${shQuote(logFile)} 2>/dev/null`, userId);
            throw new Error(errLog.stdout.trim().slice(-300) || `转码失败 (exit ${exitCode})`);
          }
          break;
        }
        if (Date.now() - startedAt > MAX_WAIT_MS) throw new Error('转码超时（超过 4 小时）');
      }

      const sizeR = await sshService.exec(file.vps_id, `stat -c%s ${shQuote(outPath)} 2>/dev/null || echo 0`, userId);
      const size = parseInt((sizeR.stdout || '').trim(), 10) || 0;
      if (size === 0) throw new Error('转码完成但输出文件为空');
      // UPSERT：若扫描已预先登记则更新大小，否则新增
      const preExist = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
        .get(userId, file.vps_id, outPath);
      let newFileId;
      if (preExist) {
        db.prepare('UPDATE media_files SET size=?, name=? WHERE id=?').run(size, outName, preExist.id);
        newFileId = preExist.id;
      } else {
        const ins = db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
          .run(userId, file.vps_id, outName, outPath, size);
        newFileId = ins.lastInsertRowid;
      }
      job.status = 'done';
      job.newFileId = newFileId;
      job.outputName = outName;
    } catch (e) {
      sshService.exec(file.vps_id, `rm -f ${shQuote(tmpPath)}`, userId).catch(() => {});
      if (job) { job.status = 'error'; job.error = e.message.slice(0, 300); }
    } finally {
      sshService.exec(file.vps_id, `rm -f ${shQuote(doneFile)} ${shQuote(logFile)} ${shQuote(scriptPath)}`, userId).catch(() => {});
      setTimeout(() => pendingJobs.delete(jobId), 30 * 60 * 1000);
    }
  })();

  res.json({ ok: true, jobId, msg: `转码任务已在 VPS 后台启动，大文件需要较长时间（每 30 秒更新进度），完成后自动入库` });
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
