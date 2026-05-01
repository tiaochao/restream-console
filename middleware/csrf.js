const crypto = require('crypto');

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function csrfMiddleware(req, res, next) {
  const token = ensureCsrfToken(req);
  res.locals.csrfToken = token;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerRaw = req.headers['x-csrf-token'];
  const bodyToken = req.body?._csrf;
  // Node.js 会将同名 header 合并为逗号分隔，需逐个检查
  const headerMatch = headerRaw && headerRaw.split(',').map(s => s.trim()).includes(token);
  const submitted = bodyToken === token || headerMatch;
  if (!submitted) {
    const isFetch = headerRaw || req.headers['content-type']?.includes('application/json');
    if (isFetch) {
      return res.status(403).json({ ok: false, msg: '请求已过期，请刷新页面重试' });
    }
    return res.status(403).send('请求已过期，请刷新页面重试');
  }
  next();
}

module.exports = { csrfMiddleware };
