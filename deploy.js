#!/usr/bin/env node
/**
 * deploy.js — 一键将本地代码同步到 VPS 并重建 Docker 镜像
 * 用法: node deploy.js [vps_id]
 * 默认部署到 VPS ID=3（萧炎-01, 107.175.194.202）
 */

const { NodeSSH } = require('node-ssh');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const VPS_ID = parseInt(process.argv[2]) || 3;
const REMOTE_SRC = '/opt/restream-console';
const CONTAINER = 'restream-console';
const LOCAL_ROOT = __dirname;

// 需要同步的所有源码文件（相对路径，正斜杠）
const SOURCE_FILES = [
  'server.js',
  'db.js',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  'middleware/auth.js',
  'middleware/csrf.js',
  'routes/auth.js',
  'routes/channels.js',
  'routes/dashboard.js',
  'routes/logs.js',
  'routes/media.js',
  'routes/settings.js',
  'routes/stream-keys.js',
  'routes/tasks.js',
  'routes/vps.js',
  'services/live-monitor.js',
  'services/platform-api.js',
  'services/ssh.js',
  'services/task-manager.js',
  'views/layout.ejs',
  'views/layout-bare.ejs',
  'views/login.ejs',
  'views/register.ejs',
  'views/dashboard.ejs',
  'views/vps.ejs',
  'views/tasks.ejs',
  'views/channels.ejs',
  'views/logs.ejs',
  'views/media.ejs',
  'views/settings.ejs',
  'views/stream-keys.ejs',
  'views/log-detail.ejs',
  'views/partials/stats.ejs',
];

function log(msg) { console.log(`[deploy] ${msg}`); }
function err(msg) { console.error(`[deploy] ✗ ${msg}`); }

async function main() {
  const vps = db.prepare('SELECT * FROM vps WHERE id=?').get(VPS_ID);
  if (!vps) { err(`VPS ${VPS_ID} 不存在`); process.exit(1); }

  log(`目标 VPS: ${vps.name} (${vps.host})`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: vps.host, port: vps.port, username: vps.username,
    password: vps.password, readyTimeout: 15000,
  });
  log('SSH 已连接');

  // 1. 确保远端目录结构存在
  const dirs = [...new Set(SOURCE_FILES.map(f => {
    const d = f.includes('/') ? REMOTE_SRC + '/' + f.split('/').slice(0, -1).join('/') : REMOTE_SRC;
    return d;
  }))];
  await ssh.execCommand('mkdir -p ' + dirs.join(' '));
  log('远端目录已创建');

  // 2. 过滤掉本地不存在的文件（可选模块），上传所有存在的文件
  let uploaded = 0;
  const missing = [];
  for (const f of SOURCE_FILES) {
    const localPath = path.join(LOCAL_ROOT, f.replace(/\//g, path.sep));
    if (!fs.existsSync(localPath)) { missing.push(f); continue; }
    const remotePath = REMOTE_SRC + '/' + f;
    try {
      await ssh.putFile(localPath, remotePath);
      process.stdout.write('.');
      uploaded++;
    } catch (e) {
      err(`上传失败: ${f} — ${e.message}`);
    }
  }
  console.log('');
  log(`已上传 ${uploaded} 个文件${missing.length ? `（跳过不存在: ${missing.join(', ')}）` : ''}`);

  // 3. 重建 Docker 镜像
  log('正在重建 Docker 镜像...');
  const buildR = await ssh.execCommand(`cd ${REMOTE_SRC} && docker build -t ${CONTAINER} . 2>&1`);
  const buildLines = buildR.stdout.split('\n');
  // 只打印最后几行（避免刷屏）
  buildLines.slice(-6).forEach(l => l.trim() && console.log('  ' + l));
  if (buildR.stdout.includes('error') && !buildR.stdout.includes('DONE')) {
    err('构建失败，中止部署');
    ssh.dispose();
    process.exit(1);
  }
  log('镜像构建成功');

  // 4. 替换运行中的容器
  log('正在替换容器...');
  await ssh.execCommand(`docker stop ${CONTAINER} && docker rm ${CONTAINER}`);
  const runR = await ssh.execCommand(
    `docker run -d --name ${CONTAINER} --restart unless-stopped ` +
    `-p 3000:3000 -v ${REMOTE_SRC}/data:/app/data ` +
    `--env-file ${REMOTE_SRC}/.env ${CONTAINER}`
  );
  if (runR.stderr && runR.stderr.includes('Error')) {
    err('启动容器失败: ' + runR.stderr);
    ssh.dispose();
    process.exit(1);
  }

  // 5. 等待 3 秒后验证
  await new Promise(r => setTimeout(r, 3000));
  const statusR = await ssh.execCommand(
    `docker ps --filter name=${CONTAINER} --format "{{.Names}} {{.Status}}"`
  );
  const logsR = await ssh.execCommand(`docker logs --tail 5 ${CONTAINER} 2>&1`);

  ssh.dispose();

  log(`容器状态: ${statusR.stdout.trim()}`);
  const lastLog = logsR.stdout.trim().split('\n').pop();
  log(`最新日志: ${lastLog}`);

  if (statusR.stdout.includes('Up')) {
    console.log('\n✓ 部署成功！');
  } else {
    err('容器未正常启动，请检查日志');
    process.exit(1);
  }
}

main().catch(e => { err(e.message); process.exit(1); });
