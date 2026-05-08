#!/usr/bin/env node
// 一次性迁移脚本：将数据库中现有明文凭证加密存储
// 用法：ENCRYPTION_KEY=<hex> node scripts/migrate-encrypt.js
// 已加密（enc:v1: 前缀）的值会被跳过，幂等执行

const db = require('../db');
const { encrypt } = require('../services/crypto');

const PREFIX = 'enc:v1:';

function needsEncrypt(value) {
  return value && !String(value).startsWith(PREFIX);
}

let migratedVps = 0;
let migratedCookies = 0;

// 迁移 vps 表
const vpsList = db.prepare('SELECT id, password, private_key FROM vps').all();
for (const vps of vpsList) {
  let changed = false;
  const updates = {};
  if (needsEncrypt(vps.password)) {
    updates.password = encrypt(vps.password);
    changed = true;
  }
  if (needsEncrypt(vps.private_key)) {
    updates.private_key = encrypt(vps.private_key);
    changed = true;
  }
  if (changed) {
    if (updates.password && updates.private_key) {
      db.prepare('UPDATE vps SET password=?, private_key=? WHERE id=?')
        .run(updates.password, updates.private_key, vps.id);
    } else if (updates.password) {
      db.prepare('UPDATE vps SET password=? WHERE id=?').run(updates.password, vps.id);
    } else {
      db.prepare('UPDATE vps SET private_key=? WHERE id=?').run(updates.private_key, vps.id);
    }
    migratedVps++;
  }
}

// 迁移 settings 表中的 douyin_cookies
const cookieRows = db.prepare("SELECT user_id, value FROM settings WHERE key='douyin_cookies'").all();
for (const row of cookieRows) {
  if (needsEncrypt(row.value)) {
    db.prepare("UPDATE settings SET value=? WHERE user_id=? AND key='douyin_cookies'")
      .run(encrypt(row.value), row.user_id);
    migratedCookies++;
  }
}

console.log(`迁移完成：${migratedVps} 个 VPS 凭证，${migratedCookies} 个 Cookie 已加密`);
console.log('（已加密的记录被跳过，可安全重复执行）');
process.exit(0);
