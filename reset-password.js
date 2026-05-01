#!/usr/bin/env node
/**
 * reset-password.js — 重置管理员密码
 * 用法: node reset-password.js [新密码] [vps_id]
 * 示例: node reset-password.js myNewPass123
 *       node reset-password.js myNewPass123 3
 */

const { NodeSSH } = require('node-ssh');
const crypto = require('crypto');
const db = require('./db');

const newPassword = process.argv[2];
const VPS_ID = parseInt(process.argv[3]) || 3;
const REMOTE_DB = '/opt/restream-console/data/db.sqlite';

if (!newPassword) {
  console.error('用法: node reset-password.js <新密码> [vps_id]');
  process.exit(1);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

async function main() {
  const vps = db.prepare('SELECT * FROM vps WHERE id=?').get(VPS_ID);
  if (!vps) { console.error(`VPS ${VPS_ID} 不存在`); process.exit(1); }

  const newHash = hashPassword(newPassword);
  console.log(`目标 VPS: ${vps.name} (${vps.host})`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: vps.host, port: vps.port, username: vps.username,
    password: vps.password, readyTimeout: 15000,
  });

  // 在容器内用 sqlite3 更新密码
  const cmd = `sqlite3 ${REMOTE_DB} "UPDATE users SET password_hash='${newHash}' WHERE username='admin';"`;
  const result = await ssh.execCommand(cmd);

  if (result.stderr && result.stderr.trim()) {
    console.error('执行失败:', result.stderr);
    ssh.dispose();
    process.exit(1);
  }

  // 验证更新
  const checkResult = await ssh.execCommand(`sqlite3 ${REMOTE_DB} "SELECT username, substr(password_hash,1,20) FROM users WHERE username='admin';"`);
  ssh.dispose();

  console.log('验证结果:', checkResult.stdout.trim());
  console.log(`\n✓ 密码已重置！用户名: admin  新密码: ${newPassword}`);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
