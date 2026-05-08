const express = require('express');
const router = express.Router();
const db = require('../db');
const { ensureDefaultSettings, hashPassword, verifyPassword, getGlobalSetting } = require('../db');

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

function allowRegistration() {
  const dbSetting = getGlobalSetting('allow_registration');
  if (dbSetting !== null && dbSetting !== undefined) return dbSetting === 'true';
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  return process.env.ALLOW_REGISTRATION === 'true' || count === 0;
}

function loginKey(req, username) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(username || '').toLowerCase()}`;
}

function isLoginLimited(key) {
  const now = Date.now();
  const item = loginAttempts.get(key);
  if (!item || item.resetAt <= now) return false;
  return item.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const item = loginAttempts.get(key);
  if (!item || item.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    item.count += 1;
  }
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function renderLogin(res, status, error) {
  return res.status(status).render('login', {
    layout: 'layout-bare',
    error,
    allowRegistration: allowRegistration(),
  });
}

router.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/dashboard');
  renderLogin(res, 200, null);
});

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const key = loginKey(req, username);

  if (isLoginLimited(key)) {
    return renderLogin(res, 429, '登录失败次数过多，请 15 分钟后再试');
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user && verifyPassword(password, user.password_hash)) {
    clearLoginFailures(key);
    req.session.regenerate((err) => {
      if (err) return renderLogin(res, 500, '服务器错误');
      req.session.authenticated = true;
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role || 'user';
      ensureDefaultSettings(user.id);
      res.redirect('/dashboard');
    });
    return;
  }

  recordLoginFailure(key);
  renderLogin(res, 401, '用户名或密码错误');
});

router.get('/register', (req, res) => {
  if (!allowRegistration()) return res.redirect('/login');
  res.render('register', { layout: 'layout-bare', error: null });
});

router.post('/register', (req, res) => {
  if (!allowRegistration()) return res.redirect('/login');

  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const confirm = req.body.confirm_password || '';

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return res.status(400).render('register', { layout: 'layout-bare', error: '用户名只能包含字母、数字、下划线和短横线，长度 3-32 位' });
  }
  if (password.length < 8) {
    return res.status(400).render('register', { layout: 'layout-bare', error: '密码至少 8 位' });
  }
  if (password !== confirm) {
    return res.status(400).render('register', { layout: 'layout-bare', error: '两次密码不一致' });
  }

  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), 'user');
    ensureDefaultSettings(info.lastInsertRowid);
    req.session.regenerate((err) => {
      if (err) return res.status(500).render('register', { layout: 'layout-bare', error: '服务器错误' });
      req.session.authenticated = true;
      req.session.userId = info.lastInsertRowid;
      req.session.username = username;
      req.session.role = 'user';
      res.redirect('/dashboard');
    });
  } catch (e) {
    const msg = /UNIQUE/i.test(e.message) ? '用户名已存在' : e.message;
    res.status(400).render('register', { layout: 'layout-bare', error: msg });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
