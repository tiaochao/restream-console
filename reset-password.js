#!/usr/bin/env node
const { NodeSSH } = require('node-ssh');
const db = require('./db');
const { hashPassword } = require('./db');

const newPassword = process.argv[2];
const username = process.argv[3] && !/^\d+$/.test(process.argv[3]) ? process.argv[3] : 'admin';
const vpsArg = process.argv[3] && /^\d+$/.test(process.argv[3]) ? process.argv[3] : process.argv[4];
const VPS_ID = parseInt(vpsArg, 10) || 3;
const REMOTE_DB = '/opt/restream-console/data/db.sqlite';

if (!newPassword || newPassword.length < 8) {
  console.error('用法: node reset-password.js <新密码(至少8位)> [username] [vps_id]');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
  console.error('用户名只能包含字母、数字、下划线和短横线，长度 3-32 位');
  process.exit(1);
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function main() {
  const vps = db.prepare('SELECT * FROM vps WHERE id=?').get(VPS_ID);
  if (!vps) throw new Error(`VPS ${VPS_ID} 不存在`);

  const newHash = hashPassword(newPassword);
  console.log(`目标 VPS: ${vps.name} (${vps.host})`);

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
    const sql = `UPDATE users SET password_hash=${shQuote(newHash)} WHERE username=${shQuote(username)};`;
    const cmd = `sqlite3 ${shQuote(REMOTE_DB)} ${shQuote(sql)}`;
    const result = await ssh.execCommand(cmd);
    if (result.code && result.code !== 0) throw new Error(result.stderr || result.stdout || `exit ${result.code}`);

    const checkSql = `SELECT username, substr(password_hash,1,20) FROM users WHERE username=${shQuote(username)};`;
    const checkResult = await ssh.execCommand(`sqlite3 ${shQuote(REMOTE_DB)} ${shQuote(checkSql)}`);
    console.log('验证结果:', checkResult.stdout.trim());
    console.log(`\n✓ 密码已重置：${username}`);
  } finally {
    ssh.dispose();
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
