const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, verifyPassword } = require('../db');
const platformApi = require('../services/platform-api');

function getSetting(userId, key) {
  return db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(userId, key)?.value || '';
}

function setSetting(userId, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(user_id,key,value) VALUES(?,?,?)').run(userId, key, value);
}

function getCfg(userId) {
  return {
    start_delay: getSetting(userId, 'start_delay') || '5',
    stall_timeout: getSetting(userId, 'stall_timeout') || '120',
    max_tasks_per_vps: getSetting(userId, 'max_tasks_per_vps') || '5',
    monitor_interval: getSetting(userId, 'monitor_interval') || '5',
    douyin_cookies: getSetting(userId, 'douyin_cookies') || '',
  };
}

router.get('/', (req, res) => {
  res.render('settings', {
    title: '设置 - 转推控制台',
    currentPath: '/settings',
    cfg: getCfg(req.session.userId),
    success: null,
    error: null,
  });
});

router.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);

  if (!verifyPassword(current_password || '', user?.password_hash)) {
    return res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), error: '当前密码错误', success: null });
  }
  if (new_password !== confirm_password) {
    return res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), error: '两次密码不一致', success: null });
  }
  if ((new_password || '').length < 8) {
    return res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), error: '密码至少 8 位', success: null });
  }

  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), req.session.userId);
  res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), success: '密码已更新', error: null });
});

router.post('/general', (req, res) => {
  setSetting(req.session.userId, 'start_delay', String(parseInt(req.body.start_delay) || 5));
  setSetting(req.session.userId, 'stall_timeout', String(parseInt(req.body.stall_timeout) || 120));
  setSetting(req.session.userId, 'max_tasks_per_vps', String(parseInt(req.body.max_tasks_per_vps) || 5));
  setSetting(req.session.userId, 'monitor_interval', String(parseInt(req.body.monitor_interval) || 5));
  res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), success: '设置已保存', error: null });
});

router.post('/cookies', (req, res) => {
  setSetting(req.session.userId, 'douyin_cookies', (req.body.douyin_cookies || '').trim());
  res.render('settings', { title: '设置 - 转推控制台', currentPath: '/settings', cfg: getCfg(req.session.userId), success: 'Cookie 已保存', error: null });
});

router.post('/test-douyin', async (req, res) => {
  const { test_url } = req.body;
  const url = (test_url || '').trim() || 'https://live.douyin.com/80616554674';
  try {
    const result = await platformApi.checkDouyin(url, getSetting(req.session.userId, 'douyin_cookies'));
    if (result.error) return res.json({ ok: false, msg: result.error });
    const anchor = result.anchorName ? `，主播：${result.anchorName}` : '';
    const src = result.source ? `（来源 ${result.source}）` : '';
    return res.json({
      ok: true,
      live: result.isLive,
      msg: (result.isLive ? '正在直播' : '未开播') + anchor + src,
    });
  } catch (e) {
    res.json({ ok: false, msg: `检测异常: ${e.message}` });
  }
});

module.exports = router;
