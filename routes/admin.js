const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, ensureDefaultSettings, getGlobalSetting, setGlobalSetting } = require('../db');

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all();
  const allowReg = getGlobalSetting('allow_registration') ?? 'false';
  res.locals.currentPath = '/admin/users';
  res.render('admin-users', {
    users,
    allowRegistration: allowReg === 'true',
    success: req.query.success,
    error: req.query.error,
  });
});

router.post('/users', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('用户名只能包含字母、数字、下划线和短横线，长度 3-32 位'));
  }
  if (password.length < 6) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('密码至少 6 位'));
  }

  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role);
    ensureDefaultSettings(info.lastInsertRowid);
    return res.redirect('/admin/users?success=' + encodeURIComponent(`用户「${username}」已创建`));
  } catch (e) {
    const msg = /UNIQUE/i.test(e.message) ? '用户名已存在' : e.message;
    return res.redirect('/admin/users?error=' + encodeURIComponent(msg));
  }
});

router.post('/users/:id/delete', (req, res) => {
  const targetId = parseInt(req.params.id);
  const selfId = req.session.userId;

  if (targetId === selfId) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('不能删除自己'));
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.redirect('/admin/users?error=' + encodeURIComponent('用户不存在'));

  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get().n;
    if (adminCount <= 1) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('不能删除最后一个管理员'));
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  return res.redirect('/admin/users?success=' + encodeURIComponent(`用户「${target.username}」已删除`));
});

router.post('/settings/registration', (req, res) => {
  const enable = req.body.allow_registration === '1';
  setGlobalSetting('allow_registration', enable ? 'true' : 'false');
  return res.redirect('/admin/users?success=' + encodeURIComponent(enable ? '已开启注册' : '已关闭注册'));
});

router.post('/users/:id/role', (req, res) => {
  const targetId = parseInt(req.params.id);
  const newRole = req.body.role === 'admin' ? 'admin' : 'user';

  if (targetId === req.session.userId) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('不能修改自己的角色'));
  }
  if (newRole === 'user') {
    const adminCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'admin'").get().n;
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(targetId);
    if (target?.role === 'admin' && adminCount <= 1) {
      return res.redirect('/admin/users?error=' + encodeURIComponent('不能降级最后一个管理员'));
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, targetId);
  return res.redirect('/admin/users?success=' + encodeURIComponent('角色已更新'));
});

module.exports = router;
