const express = require('express');
const session = require('express-session');
const ejsLayouts = require('express-ejs-layouts');
const path = require('path');

require('./db'); // 初始化数据库
const { requireAuth, requireAdmin } = require('./middleware/auth');
const { csrfMiddleware } = require('./middleware/csrf');
const taskManager = require('./services/task-manager');
const liveMonitor = require('./services/live-monitor');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
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
app.use('/admin', requireAuth, requireAdmin, require('./routes/admin'));

app.get('/', (req, res) => res.redirect('/dashboard'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`转推控制台运行在 http://localhost:${PORT}`);
  taskManager.startMonitor();
  liveMonitor.startLiveMonitor();
});
