#!/usr/bin/env node
const { NodeSSH } = require('node-ssh');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const VPS_ID = parseInt(process.argv[2], 10) || 3;
const REMOTE_SRC = '/opt/restream-console';
const CONTAINER = 'restream-console';
const BACKUP_IMAGE = `${CONTAINER}:previous`;
const LOCAL_ROOT = __dirname;

const SOURCE_FILES = [
  'server.js', 'db.js', 'package.json', 'package-lock.json', 'Dockerfile', 'nginx-xiaoyan.chat.conf',
  'middleware/auth.js', 'middleware/csrf.js',
  'routes/auth.js', 'routes/admin.js', 'routes/channels.js', 'routes/dashboard.js', 'routes/logs.js', 'routes/media.js', 'routes/settings.js', 'routes/stream-keys.js', 'routes/tasks.js', 'routes/vps.js', 'routes/youtube-channels.js',
  'services/crypto.js', 'services/ffmpeg-args.js', 'services/live-monitor.js', 'services/notifier.js', 'services/platform-api.js', 'services/ssh.js', 'services/task-manager.js', 'services/task-ssh.js', 'services/task-state.js', 'services/vps-scheduler.js', 'services/youtube-monitor.js', 'services/youtube-channel-sync.js',
  'utils/log-error.js', 'utils/shell-escape.js',
  'views/layout.ejs', 'views/layout-bare.ejs', 'views/login.ejs', 'views/register.ejs', 'views/dashboard.ejs', 'views/vps.ejs', 'views/tasks.ejs', 'views/channels.ejs', 'views/logs.ejs', 'views/media.ejs', 'views/settings.ejs', 'views/stream-keys.ejs', 'views/admin-users.ejs', 'views/log-detail.ejs', 'views/partials/stats.ejs', 'views/youtube-channels.ejs',
  'scripts/migrate-encrypt.js',
  'check_douyin.py',
];

function log(msg) { console.log(`[deploy] ${msg}`); }
function fail(msg) { console.error(`[deploy] ERROR: ${msg}`); }
function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function isSafeDockerName(s) { return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function execOrThrow(ssh, cmd, label) {
  const r = await ssh.execCommand(cmd);
  if (r.code && r.code !== 0) {
    throw new Error(`${label} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return r;
}

async function writeRemoteFile(ssh, remotePath, content, mode = '600') {
  const b64 = Buffer.from(content).toString('base64');
  await execOrThrow(
    ssh,
    `printf %s ${shQuote(b64)} | base64 -d > ${shQuote(remotePath)} && chmod ${mode} ${shQuote(remotePath)}`,
    `write ${remotePath}`
  );
}

function buildSwitchScript() {
  return `#!/usr/bin/env bash
set -u

CONTAINER=${shQuote(CONTAINER)}
REMOTE_SRC=${shQuote(REMOTE_SRC)}
NEW_IMAGE=${shQuote(CONTAINER)}
BACKUP_IMAGE=${shQuote(BACKUP_IMAGE)}

log() { echo "[switch] $*"; }

run_container() {
  docker run -d \\
    --name "$CONTAINER" \\
    --restart unless-stopped \\
    -p 3000:3000 \\
    -v "$REMOTE_SRC/data:/app/data" \\
    --env-file "$REMOTE_SRC/.env" \\
    "$1"
}

is_up() {
  docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}} {{.Status}}' | grep -q "^${CONTAINER} Up"
}

rollback() {
  log "new container failed; attempting rollback"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker image inspect "$BACKUP_IMAGE" >/dev/null 2>&1; then
    if run_container "$BACKUP_IMAGE" >/dev/null; then
      sleep 4
      if is_up; then
        log "DEPLOY_SWITCH_ROLLED_BACK"
        docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}} {{.Status}}'
        exit 1
      fi
    fi
  fi
  log "DEPLOY_SWITCH_FAILED"
  docker logs --tail 80 "$CONTAINER" 2>&1 || true
  exit 1
}

log "replacing container with $NEW_IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if ! run_container "$NEW_IMAGE" >/dev/null; then
  rollback
fi

sleep 4
if ! is_up; then
  docker logs --tail 80 "$CONTAINER" 2>&1 || true
  rollback
fi

if ! curl -fsS --max-time 8 http://127.0.0.1:3000/healthz >/dev/null; then
  docker logs --tail 80 "$CONTAINER" 2>&1 || true
  rollback
fi

log "DEPLOY_SWITCH_OK"
docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}} {{.Status}}'
`;
}

async function switchContainer(ssh) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const remoteScript = `/tmp/restream-switch-${suffix}.sh`;
  const remoteLog = `/tmp/restream-switch-${suffix}.log`;

  await writeRemoteFile(ssh, remoteScript, buildSwitchScript(), '700');
  const startR = await execOrThrow(
    ssh,
    `nohup bash ${shQuote(remoteScript)} > ${shQuote(remoteLog)} 2>&1 < /dev/null & echo $!`,
    'start container switch'
  );
  log(`remote switch pid: ${startR.stdout.trim()}`);

  let lastLog = '';
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const r = await ssh.execCommand(`tail -n 80 ${shQuote(remoteLog)} 2>/dev/null || true`);
    lastLog = r.stdout || '';
    if (lastLog.includes('DEPLOY_SWITCH_OK')) return lastLog;
    if (lastLog.includes('DEPLOY_SWITCH_FAILED') || lastLog.includes('DEPLOY_SWITCH_ROLLED_BACK')) {
      throw new Error(`container switch failed:\n${lastLog}`);
    }
  }

  throw new Error(`container switch timed out:\n${lastLog}`);
}

async function main() {
  if (!isSafeDockerName(CONTAINER)) throw new Error('Unsafe container name');

  const vps = db.prepare('SELECT * FROM vps WHERE id=?').get(VPS_ID);
  if (!vps) throw new Error(`VPS ${VPS_ID} not found`);

  log(`目标 VPS: ${vps.name} (${vps.host})`);
  const ssh = new NodeSSH();
  await ssh.connect({
    host: vps.host,
    port: vps.port,
    username: vps.username,
    password: vps.password,
    privateKey: vps.auth_type === 'key' ? vps.private_key : undefined,
    readyTimeout: 15000,
  });

  try {
    log('SSH 已连接');
    const dirs = [...new Set(SOURCE_FILES.map(f => {
      const dir = f.includes('/') ? `${REMOTE_SRC}/${f.split('/').slice(0, -1).join('/')}` : REMOTE_SRC;
      return shQuote(dir);
    }))];
    await execOrThrow(ssh, `mkdir -p ${dirs.join(' ')}`, 'mkdir');
    log('远端目录已创建');

    let uploaded = 0;
    const missing = [];
    for (const f of SOURCE_FILES) {
      const localPath = path.join(LOCAL_ROOT, f.replace(/\//g, path.sep));
      if (!fs.existsSync(localPath)) { missing.push(f); continue; }
      await ssh.putFile(localPath, `${REMOTE_SRC}/${f}`);
      process.stdout.write('.');
      uploaded++;
    }
    console.log('');
    log(`已上传 ${uploaded} 个文件${missing.length ? `（跳过不存在: ${missing.join(', ')}）` : ''}`);

    log('正在重建 Docker 镜像...');
    const buildR = await execOrThrow(ssh, `cd ${shQuote(REMOTE_SRC)} && docker build -t ${shQuote(CONTAINER)} . 2>&1`, 'docker build');
    buildR.stdout.split('\n').slice(-6).forEach(l => l.trim() && console.log('  ' + l));
    log('镜像构建成功');

    log('正在替换容器...');
    await ssh.execCommand(`docker image inspect ${shQuote(CONTAINER)} >/dev/null 2>&1 && docker tag ${shQuote(CONTAINER)} ${shQuote(BACKUP_IMAGE)} || true`);
    const switchLog = await switchContainer(ssh);
    switchLog.split('\n').slice(-8).forEach(l => l.trim() && console.log('  ' + l));

    const statusR = await ssh.execCommand(`docker ps --filter name=${shQuote(CONTAINER)} --format '{{.Names}} {{.Status}}'`);
    const logsR = await ssh.execCommand(`docker logs --tail 5 ${shQuote(CONTAINER)} 2>&1`);
    log(`容器状态: ${statusR.stdout.trim()}`);
    log(`最新日志: ${logsR.stdout.trim().split('\n').pop()}`);
    if (!statusR.stdout.includes('Up')) throw new Error('容器未正常启动，请检查日志');
    console.log('\n✓ 部署成功！');
  } finally {
    ssh.dispose();
  }
}

main().catch(e => { fail(e.message); process.exit(1); });
