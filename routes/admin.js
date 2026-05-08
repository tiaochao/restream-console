const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, ensureDefaultSettings, getGlobalSetting, setGlobalSetting } = require('../db');

const TITLE = '用户管理 - 转推控制台';
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

function redirectWith(type, message) {
  return `/admin/users?${type}=${encodeURIComponent(message)}`;
}

function getAdminCount() {
  return db.prepare("SELECT COUNT(*) as n FROM users WHERE role='admin'").get().n;
}

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all();
  const allowReg = getGlobalSetting('allow_registration') ?? 'false';
  res.locals.currentPath = '/admin/users';
  res.render('admin-users', {
    title: TITLE,
    users,
    allowRegistration: allowReg === 'true',
    success: req.query.success,
    error: req.query.error,
  });
});

router.post('/users', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!USERNAME_RE.test(username)) {
    return res.redirect(redirectWith('error', '用户名只能包含字母、数字、下划线和短横线，长度 3-32 位'));
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.redirect(redirectWith('error', `密码至少 ${MIN_PASSWORD_LENGTH} 位`));
  }

  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role);
    ensureDefaultSettings(info.lastInsertRowid);
    return res.redirect(redirectWith('success', `用户「${username}」已创建`));
  } catch (e) {
    const msg = /UNIQUE/i.test(e.message) ? '用户名已存在' : e.message;
    return res.redirect(redirectWith('error', msg));
  }
});

router.post('/users/:id/delete', (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.redirect(redirectWith('error', '用户不存在'));
  if (targetId === req.session.userId) return res.redirect(redirectWith('error', '不能删除自己'));

  const target = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(targetId);
  if (!target) return res.redirect(redirectWith('error', '用户不存在'));

  if (target.role === 'admin' && getAdminCount() <= 1) {
    return res.redirect(redirectWith('error', '不能删除最后一个管理员'));
  }

  db.prepare('DELETE FROM users WHERE id=?').run(targetId);
  return res.redirect(redirectWith('success', `用户「${target.username}」已删除`));
});

router.post('/settings/registration', (req, res) => {
  const enable = req.body.allow_registration === '1';
  setGlobalSetting('allow_registration', enable ? 'true' : 'false');
  return res.redirect(redirectWith('success', enable ? '已开启注册' : '已关闭注册'));
});

router.post('/users/:id/role', (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const newRole = req.body.role === 'admin' ? 'admin' : 'user';

  if (!Number.isInteger(targetId)) return res.redirect(redirectWith('error', '用户不存在'));
  if (targetId === req.session.userId) return res.redirect(redirectWith('error', '不能修改自己的角色'));

  const target = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(targetId);
  if (!target) return res.redirect(redirectWith('error', '用户不存在'));

  if (target.role === 'admin' && newRole === 'user' && getAdminCount() <= 1) {
    return res.redirect(redirectWith('error', '不能降级最后一个管理员'));
  }

  if (target.role !== newRole) {
    db.prepare('UPDATE users SET role=? WHERE id=?').run(newRole, targetId);
  }
  return res.redirect(redirectWith('success', `用户「${target.username}」角色已更新`));
});

module.exports = router;
