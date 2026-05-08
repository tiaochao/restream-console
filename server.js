const express = require('express');
const session = require('express-session');
const ejsLayouts = require('express-ejs-layouts');
const path = require('path');

require('./db'); // 初始化数据库
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { csrfMiddleware } = require('./middleware/csrf');
const taskManager = require('./services/task-manager');
const liveMonitor = require('./services/live-monitor');
const youtubeMonitor = require('./services/youtube-monitor');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

const _encKey = process.env.ENCRYPTION_KEY || '';
if (!_encKey || _encKey.length !== 64 || !/^[0-9a-f]+$/i.test(_encKey)) {
  if (isProduction) {
    throw new Error('ENCRYPTION_KEY is required in production (generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
  } else if (_encKey) {
    console.warn('[security] ENCRYPTION_KEY 格式错误（需 64 位 hex）—— 在开发环境中忽略，生产环境将启动失败');
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || (isProduction ? undefined : 'restream-console-dev-secret'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: isProduction,
    httpOnly: true,
  }
}));


app.use(csrfMiddleware);
app.use('/', require('./routes/auth'));
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'restream-console' }));
app.use('/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/vps', requireAuth, require('./routes/vps'));
app.use('/tasks', requireAuth, require('./routes/tasks'));
app.use('/channels', requireAuth, require('./routes/channels'));
app.use('/stream-keys', requireAuth, require('./routes/stream-keys'));
app.use('/media', requireAuth, require('./routes/media'));
app.use('/logs', requireAuth, require('./routes/logs'));
app.use('/settings', requireAuth, require('./routes/settings'));
app.use('/youtube-channels', requireAuth, require('./routes/youtube-channels'));
app.use('/admin', requireAuth, requireAdmin, require('./routes/admin'));

app.get('/', (req, res) => res.redirect('/dashboard'));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message, err.stack ? err.stack.split('\n')[1] : '');
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.status(status).json({ error: isProduction ? '服务器内部错误' : err.message });
  }
  res.status(status).send(isProduction ? '<h1>服务器内部错误</h1>' : `<pre>${err.message}\n${err.stack || ''}</pre>`);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`转推控制台运行在 http://localhost:${PORT}`);
  taskManager.startMonitor();
  liveMonitor.startLiveMonitor();
  youtubeMonitor.startMonitor();
});

server.requestTimeout = 2 * 60 * 60 * 1000;
server.headersTimeout = 2 * 60 * 60 * 1000 + 30 * 1000;
server.keepAliveTimeout = 75 * 1000;
