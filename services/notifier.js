const { getSetting } = require('../db');
const { decrypt } = require('./crypto');

const TYPE_EMOJI = {
  task_stalled:    '🔴 任务掉线',
  task_restarting: '🔄 自动重启',
  task_error:      '❌ 任务错误',
  task_recovered:  '✅ 任务恢复',
  test:            '✅ 通知测试',
};

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    let parsed;
    try { parsed = new URL(url); } catch (_) { return reject(new Error('无效 URL')); }
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
      timeout: 10000,
    };
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(opts, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(json);
    req.end();
  });
}

async function sendWebhook(webhookUrl, event) {
  const code = await postJson(webhookUrl, { ...event, service: 'restream-console' });
  if (code >= 400) console.warn(`[notifier] Webhook 响应 ${code}: ${webhookUrl}`);
}

async function sendTelegram(token, chatId, event) {
  const label = TYPE_EMOJI[event.type] || 'ℹ️ 通知';
  const lines = [label];
  if (event.message) lines.push(event.message);
  if (event.taskName) lines.push(`任务：${event.taskName}`);
  const text = lines.join('\n');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const code = await postJson(url, { chat_id: chatId, text });
  if (code >= 400) console.warn(`[notifier] Telegram 响应 ${code}`);
}

async function send(userId, event) {
  if (!userId && !event) return;
  const evt = { ts: Date.now(), ...event };

  const webhookUrl = userId ? getSetting('notify_webhook_url', userId) : null;
  const tgToken    = userId ? decrypt(getSetting('notify_telegram_token', userId) || '') || '' : '';
  const tgChatId   = userId ? getSetting('notify_telegram_chat_id', userId) : null;

  const tasks = [];
  if (webhookUrl) tasks.push(sendWebhook(webhookUrl, evt).catch(e => console.warn('[notifier] Webhook 失败:', e.message)));
  if (tgToken && tgChatId) tasks.push(sendTelegram(tgToken, tgChatId, evt).catch(e => console.warn('[notifier] Telegram 失败:', e.message)));

  await Promise.all(tasks);
}

async function test(userId) {
  return send(userId, { type: 'test', message: '这是一条来自 restream-console 的测试通知', taskName: '', taskId: null });
}

module.exports = { send, test };
