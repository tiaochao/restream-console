const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword } = require('../db');
const platformApi = require('../services/platform-api');
const youtubeMonitor = require('../services/youtube-monitor');
const { encrypt, decrypt } = require('../services/crypto');
const notifier = require('../services/notifier');

const TITLE = '设置 - 转推控制台';
const MAX_COOKIE_LENGTH = 20000;
const MAX_YOUTUBE_API_KEYS_LENGTH = 12000;

function getSetting(userId, key) {
  return db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(userId, key)?.value || '';
}

function setSetting(userId, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(user_id,key,value) VALUES(?,?,?)').run(userId, key, value);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeYouTubeApiKeys(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\s,;，；]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter(v => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    })
    .join('\n');
}

function getCfg(userId) {
  const apiKeys = getSetting(userId, 'youtube_api_keys') || getSetting(userId, 'youtube_api_key') || '';
  return {
    start_delay: getSetting(userId, 'start_delay') || '5',
    stall_timeout: getSetting(userId, 'stall_timeout') || '120',
    max_tasks_per_vps: getSetting(userId, 'max_tasks_per_vps') || '5',
    monitor_interval: getSetting(userId, 'monitor_interval') || '5',
    youtube_api_key: getSetting(userId, 'youtube_api_key') || '',
    youtube_api_keys: apiKeys,
    youtube_api_key_count: normalizeYouTubeApiKeys(apiKeys).split('\n').filter(Boolean).length,
    douyin_cookies: decrypt(getSetting(userId, 'douyin_cookies') || '') || '',
    notify_webhook_url:        getSetting(userId, 'notify_webhook_url')      || '',
    notify_telegram_token:     getSetting(userId, 'notify_telegram_token')   || '',
    notify_telegram_chat_id:   getSetting(userId, 'notify_telegram_chat_id') || '',
  };
}

function renderSettings(req, res, { status = 200, success = null, error = null } = {}) {
  return res.status(status).render('settings', {
    title: TITLE,
    currentPath: '/settings',
    cfg: getCfg(req.session.userId),
    success,
    error,
  });
}

router.get('/', (req, res) => renderSettings(req, res));

router.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);

  if (!verifyPassword(current_password || '', user?.password_hash)) {
    return renderSettings(req, res, { status: 400, error: '当前密码错误' });
  }
  if (new_password !== confirm_password) {
    return renderSettings(req, res, { status: 400, error: '两次密码不一致' });
  }
  if ((new_password || '').length < 8) {
    return renderSettings(req, res, { status: 400, error: '密码至少 8 位' });
  }

  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), req.session.userId);
  req.session.regenerate((err) => {
    if (err) return renderSettings(req, res, { status: 500, error: '密码已更新，但会话刷新失败，请重新登录' });
    res.redirect('/login?toast=' + encodeURIComponent('密码已更新，请重新登录') + '&type=success');
  });
});

router.post('/general', (req, res) => {
  setSetting(req.session.userId, 'start_delay', String(clampInt(req.body.start_delay, 5, 0, 300)));
  setSetting(req.session.userId, 'stall_timeout', String(clampInt(req.body.stall_timeout, 120, 30, 1800)));
  setSetting(req.session.userId, 'max_tasks_per_vps', String(clampInt(req.body.max_tasks_per_vps, 5, 1, 20)));
  setSetting(req.session.userId, 'monitor_interval', String(clampInt(req.body.monitor_interval, 5, 1, 60)));
  if (
    Object.prototype.hasOwnProperty.call(req.body, 'youtube_api_keys') ||
    Object.prototype.hasOwnProperty.call(req.body, 'youtube_api_key')
  ) {
    const raw = Object.prototype.hasOwnProperty.call(req.body, 'youtube_api_keys')
      ? req.body.youtube_api_keys
      : req.body.youtube_api_key;
    if (String(raw || '').length > MAX_YOUTUBE_API_KEYS_LENGTH) {
      return renderSettings(req, res, { status: 400, error: 'YouTube API Key 池内容太长，请减少无效内容后再保存' });
    }
    const keys = normalizeYouTubeApiKeys(raw);
    const firstKey = keys.split('\n').filter(Boolean)[0] || '';
    setSetting(req.session.userId, 'youtube_api_keys', keys);
    setSetting(req.session.userId, 'youtube_api_key', firstKey);
    setSetting(req.session.userId, 'youtube_api_key_cursor', '0');
  }
  renderSettings(req, res, { success: '设置已保存' });
});

router.post('/cookies', (req, res) => {
  const cookies = String(req.body.douyin_cookies || '').trim();
  if (cookies.length > MAX_COOKIE_LENGTH) {
    return renderSettings(req, res, { status: 400, error: 'Cookie 太长，请确认是否粘贴了正确内容' });
  }
  setSetting(req.session.userId, 'douyin_cookies', cookies ? encrypt(cookies) : '');
  renderSettings(req, res, { success: 'Cookie 已保存' });
});

router.post('/test-douyin', async (req, res) => {
  const url = String(req.body.test_url || '').trim() || 'https://live.douyin.com/80616554674';
  if (!/^https?:\/\//i.test(url) || !/douyin\.com/i.test(url)) {
    return res.status(400).json({ ok: false, msg: '请输入有效的抖音链接' });
  }

  try {
    const result = await platformApi.checkDouyin(url, decrypt(getSetting(req.session.userId, 'douyin_cookies') || '') || '');
    if (!result) return res.json({ ok: false, msg: '暂时无法可靠检测，请稍后重试或使用 VPS 检测' });
    if (result.error) return res.json({ ok: false, msg: result.error });
    const anchor = result.anchorName ? `，主播：${result.anchorName}` : '';
    const src = result.source ? `（来源 ${result.source}）` : '';
    return res.json({
      ok: true,
      live: !!result.isLive,
      msg: (result.isLive ? '正在直播' : '未开播') + anchor + src,
    });
  } catch (e) {
    res.json({ ok: false, msg: `检测异常：${e.message}` });
  }
});

router.post('/test-youtube-api-keys', async (req, res) => {
  const raw = Object.prototype.hasOwnProperty.call(req.body, 'youtube_api_keys')
    ? req.body.youtube_api_keys
    : getSetting(req.session.userId, 'youtube_api_keys') || getSetting(req.session.userId, 'youtube_api_key');
  if (String(raw || '').length > MAX_YOUTUBE_API_KEYS_LENGTH) {
    return res.status(400).json({ ok: false, msg: 'YouTube API Key 池内容太长' });
  }

  try {
    const keys = normalizeYouTubeApiKeys(raw);
    if (!keys) return res.json({ ok: false, msg: '请先填写 YouTube Data API Key' });
    const result = await youtubeMonitor.testApiKeyPool(req.session.userId, keys);
    const msg = result.ok
      ? `检测完成：${result.usable}/${result.total} 个 Key 可用`
      : `检测完成：${result.total} 个 Key 均不可用`;
    res.json({ ok: result.ok, msg, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, msg: `检测失败：${e.message}` });
  }
});

router.post('/notifications', (req, res) => {
  const webhookUrl = String(req.body.notify_webhook_url || '').trim();
  const tgToken    = String(req.body.notify_telegram_token || '').trim();
  const tgChatId   = String(req.body.notify_telegram_chat_id || '').trim();

  if (webhookUrl && !/^https?:\/\/.+/i.test(webhookUrl)) {
    return renderSettings(req, res, { status: 400, error: 'Webhook URL 格式无效（需 http/https 开头）' });
  }

  setSetting(req.session.userId, 'notify_webhook_url',      webhookUrl);
  setSetting(req.session.userId, 'notify_telegram_token',   tgToken);
  setSetting(req.session.userId, 'notify_telegram_chat_id', tgChatId);
  renderSettings(req, res, { success: '通知配置已保存' });
});

router.post('/test-notify', async (req, res) => {
  try {
    await notifier.test(req.session.userId);
    res.json({ ok: true, msg: '测试通知已发送（如未收到，请检查配置和 Bot 设置）' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

module.exports = router;
