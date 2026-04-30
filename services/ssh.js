const { NodeSSH } = require('node-ssh');
const db = require('../db');

// 连接池: Map<vpsId, NodeSSH>
const pool = new Map();

async function connect(vpsId) {
  if (pool.has(vpsId)) {
    const conn = pool.get(vpsId);
    // isConnected() 在网络抖动后可能误报 true，验证一下
    if (conn.isConnected()) {
      try {
        await conn.execCommand('true');
        return conn;
      } catch (_) {
        // 连接实际已死，清掉重连
        try { conn.dispose(); } catch (_) {}
        pool.delete(vpsId);
      }
    } else {
      pool.delete(vpsId);
    }
  }

  const vps = db.prepare('SELECT * FROM vps WHERE id = ?').get(vpsId);
  if (!vps) throw new Error(`VPS ${vpsId} 不存在`);

  const ssh = new NodeSSH();
  const config = {
    host: vps.host,
    port: vps.port || 22,
    username: vps.username || 'root',
    readyTimeout: 15000,
    keepaliveInterval: 30000, // 每 30s 发一次心跳，防止连接空闲被踢
    keepaliveCountMax: 3,
  };

  if (vps.auth_type === 'key' && vps.private_key) {
    config.privateKey = vps.private_key;
  } else {
    config.password = vps.password;
  }

  await ssh.connect(config);
  pool.set(vpsId, ssh);
  return ssh;
}

async function exec(vpsId, command) {
  try {
    const ssh = await connect(vpsId);
    return await ssh.execCommand(command);
  } catch (e) {
    // 连接已断开时清除缓存，等一会再重试一次
    if (/handshake|closed|ended|lost|ECONNRESET|ETIMEDOUT/i.test(e.message)) {
      disconnect(vpsId);
      await new Promise(r => setTimeout(r, 1500));
      const ssh = await connect(vpsId);
      return await ssh.execCommand(command);
    }
    throw e;
  }
}

// 强制建新连接执行（用于耗时长的命令，避免复用已断的旧连接）
async function freshExec(vpsId, command) {
  disconnect(vpsId);
  await new Promise(r => setTimeout(r, 500));
  const ssh = await connect(vpsId);
  return await ssh.execCommand(command);
}

function disconnect(vpsId) {
  if (pool.has(vpsId)) {
    try { pool.get(vpsId).dispose(); } catch (_) {}
    pool.delete(vpsId);
  }
}

async function testConnection(vpsConfig) {
  const ssh = new NodeSSH();
  const config = {
    host: vpsConfig.host,
    port: parseInt(vpsConfig.port) || 22,
    username: vpsConfig.username || 'root',
    readyTimeout: 10000,
  };
  if (vpsConfig.auth_type === 'key' && vpsConfig.private_key) {
    config.privateKey = vpsConfig.private_key;
  } else {
    config.password = vpsConfig.password;
  }
  await ssh.connect(config);
  const result = await ssh.execCommand('echo ok');
  ssh.dispose();
  return result.stdout.trim() === 'ok';
}

module.exports = { connect, exec, freshExec, disconnect, testConnection };
