function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated && req.session.userId) {
    res.locals.currentUser = {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role || 'user',
    };
    return next();
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (res.locals.currentUser?.role === 'admin') return next();
  res.status(403).send('无权限');
}

module.exports = { requireAuth, requireAdmin };
