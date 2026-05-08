const path = require('path');
const fs = require('fs');
const db = require('../db');
const sshService = require('./ssh');
const { shSingleQuote } = require('../utils/shell-escape');
const {
  MEDIA_LIBRARY_DIR,
  LEGACY_RECORD_DIR,
  AUTO_RECORDING_PREFIX,
  autoRecordingCompatName,
  autoRecordingCompatPath,
  remoteDependencyInstallCommand,
} = require('./ffmpeg-args');

async function syncDouyinHelper(vpsId, userId) {
  const scriptPath = path.join(__dirname, '..', 'check_douyin.py');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const scriptB64 = Buffer.from(script).toString('base64');
  await sshService.exec(vpsId, [
    'mkdir -p /opt/restream-console',
    `printf %s ${shSingleQuote(scriptB64)} | base64 -d > /opt/restream-console/check_douyin.py`,
    'chmod +x /opt/restream-console/check_douyin.py',
  ].join(' && '), userId);
}

async function ensureRemoteRuntime(vpsId, userId, options = {}) {
  await sshService.exec(vpsId, remoteDependencyInstallCommand(), userId);
  if (options.douyinHelper) await syncDouyinHelper(vpsId, userId);
}

async function syncAutoRecordingMediaFile(task) {
  if (!task?.id || !task?.vps_id || !task?.user_id) return;
  if (String(task.source_url || '').startsWith('/')) return;

  const compatName = autoRecordingCompatName(task.id);
  const compatPath = autoRecordingCompatPath(task.id);
  const legacyPath = `${LEGACY_RECORD_DIR}/${compatName}`;
  const namedPattern = `${AUTO_RECORDING_PREFIX}_*_task${task.id}.ts`;
  const cmd = [
    `mkdir -p ${shSingleQuote(MEDIA_LIBRARY_DIR)}`,
    `if [ ! -s ${shSingleQuote(compatPath)} ] && [ -s ${shSingleQuote(legacyPath)} ]; then cp -f ${shSingleQuote(legacyPath)} ${shSingleQuote(compatPath)}; fi`,
    `find ${shSingleQuote(MEDIA_LIBRARY_DIR)} -maxdepth 1 -type f \\( -name ${shSingleQuote(namedPattern)} -o -name ${shSingleQuote(compatName)} \\) -size +0c -printf '%f\\t%p\\t%s\\n' 2>/dev/null`,
  ].join(' && ');

  const result = await sshService.exec(task.vps_id, cmd, task.user_id);
  const records = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => {
    const [fileName, remotePath, sizeStr] = line.split('\t');
    return { fileName, remotePath, size: parseInt(sizeStr, 10) || 0 };
  }).filter(row => row.fileName && row.remotePath && row.size > 0);
  const hasNamedRecording = records.some(row => row.fileName !== compatName);

  if (hasNamedRecording) {
    db.prepare('DELETE FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .run(task.user_id, task.vps_id, compatPath);
  }

  for (const { fileName, remotePath, size } of records) {
    if (hasNamedRecording && remotePath === compatPath) continue;
    const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .get(task.user_id, task.vps_id, remotePath);
    if (existing) {
      db.prepare('UPDATE media_files SET name=?, size=? WHERE id=?').run(fileName, size, existing.id);
    } else {
      db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
        .run(task.user_id, task.vps_id, fileName, remotePath, size);
    }
  }

  const currentPaths = new Set(records.map(r => r.remotePath));
  const allEntries = db.prepare(
    'SELECT id, remote_path, name FROM media_files WHERE user_id=? AND vps_id=?'
  ).all(task.user_id, task.vps_id);
  const stalePattern = new RegExp(`^${AUTO_RECORDING_PREFIX}_.*_task${task.id}(_\\d+)?\\.ts$`);
  for (const entry of allEntries) {
    if (stalePattern.test(entry.name || '') && !currentPaths.has(entry.remote_path)) {
      db.prepare('DELETE FROM media_files WHERE id=?').run(entry.id);
    }
  }
}

module.exports = { syncDouyinHelper, ensureRemoteRuntime, syncAutoRecordingMediaFile };
