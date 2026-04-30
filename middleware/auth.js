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

module.exports = { requireAuth };
