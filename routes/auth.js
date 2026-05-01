const express = require('express');
const router = express.Router();
const db = require('../db');
const { ensureDefaultSettings, hashPassword, verifyPassword } = require('../db');

function allowRegistration() {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  return process.env.ALLOW_REGISTRATION === 'true' || count === 0;
}

router.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/dashboard');
  res.render('login', {
    layout: 'layout-bare',
    error: null,
    allowRegistration: allowRegistration(),
  });
});

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (user && verifyPassword(password, user.password_hash)) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).render('login', { layout: 'layout-bare', error: '服务器错误', allowRegistration: allowRegistration() });
      req.session.authenticated = true;
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role || 'user';
      ensureDefaultSettings(user.id);
      res.redirect('/dashboard');
    });
    return;
  }

  res.status(401).render('login', {
    layout: 'layout-bare',
    error: '用户名或密码错误',
    allowRegistration: allowRegistration(),
  });
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
