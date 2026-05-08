const crypto = require('crypto');

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function tokenMatches(submitted, expected) {
  if (!submitted || !expected) return false;
  const values = Array.isArray(submitted) ? submitted : String(submitted).split(',').map(s => s.trim());
  return values.some(value => value === expected);
}

function csrfMiddleware(req, res, next) {
  const token = ensureCsrfToken(req);
  res.locals.csrfToken = token;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerToken = req.headers['x-csrf-token'];
  const bodyToken = req.body?._csrf;
  const submitted = tokenMatches(headerToken, token) || tokenMatches(bodyToken, token);

  if (!submitted) {
    const wantsJson = headerToken || req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');
    if (wantsJson) return res.status(403).json({ ok: false, msg: '请求已过期，请刷新页面重试' });
    return res.status(403).send('请求已过期，请刷新页面重试');
  }

  next();
}

module.exports = { csrfMiddleware };
