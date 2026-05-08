const { NodeSSH } = require('node-ssh');
const db = require('../db');
const { decrypt } = require('./crypto');

const pool = new Map();

function poolKey(vpsId, userId) {
  return userId ? `${userId}:${vpsId}` : `global:${vpsId}`;
}

function buildConfig(vps) {
  const config = {
    host: vps.host,
    port: parseInt(vps.port, 10) || 22,
    username: vps.username || 'root',
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  };
  if (vps.auth_type === 'key' && vps.private_key) config.privateKey = decrypt(vps.private_key);
  else config.password = decrypt(vps.password);
  return config;
}

async function connect(vpsId, userId = null) {
  const key = poolKey(vpsId, userId);
  const cached = pool.get(key);
  if (cached) {
    if (cached.isConnected()) {
      try {
        await cached.execCommand('true');
        return cached;
      } catch (_) {
        try { cached.dispose(); } catch (_) {}
      }
    }
    pool.delete(key);
  }

  const vps = userId
    ? db.prepare('SELECT * FROM vps WHERE id = ? AND user_id = ?').get(vpsId, userId)
    : db.prepare('SELECT * FROM vps WHERE id = ?').get(vpsId);
  if (!vps) throw new Error(`VPS ${vpsId} 不存在或无权限`);

  const ssh = new NodeSSH();
  await ssh.connect(buildConfig(vps));
  pool.set(key, ssh);
  return ssh;
}

async function exec(vpsId, command, userId = null) {
  try {
    const ssh = await connect(vpsId, userId);
    return await ssh.execCommand(command);
  } catch (e) {
    if (/handshake|closed|ended|lost|ECONNRESET|ETIMEDOUT/i.test(e.message)) {
      disconnect(vpsId, userId);
      await new Promise(r => setTimeout(r, 1500));
      const ssh = await connect(vpsId, userId);
      return await ssh.execCommand(command);
    }
    throw e;
  }
}

async function freshExec(vpsId, command, userId = null) {
  disconnect(vpsId, userId);
  await new Promise(r => setTimeout(r, 500));
  const ssh = await connect(vpsId, userId);
  return await ssh.execCommand(command);
}

function disconnect(vpsId, userId = null) {
  const keys = userId ? [poolKey(vpsId, userId)] : [...pool.keys()].filter(key => key.endsWith(`:${vpsId}`));
  for (const key of keys) {
    const conn = pool.get(key);
    if (conn) {
      try { conn.dispose(); } catch (_) {}
      pool.delete(key);
    }
  }
}

async function testConnection(vpsConfig) {
  const ssh = new NodeSSH();
  await ssh.connect({ ...buildConfig(vpsConfig), readyTimeout: 10000 });
  const result = await ssh.execCommand('echo ok');
  ssh.dispose();
  return result.stdout.trim() === 'ok';
}

module.exports = { connect, exec, freshExec, disconnect, testConnection };
