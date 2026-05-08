const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'db.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT DEFAULT 'root',
    auth_type TEXT DEFAULT 'password',
    password TEXT,
    private_key TEXT,
    status TEXT DEFAULT 'unknown',
    last_check TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    vps_id INTEGER REFERENCES vps(id) ON DELETE SET NULL,
    name TEXT,
    platform TEXT DEFAULT 'youtube',
    source_url TEXT NOT NULL,
    rtmp_url TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    remote_pid INTEGER,
    log_file TEXT,
    started_at TEXT,
    last_active_at TEXT,
    stall_count INTEGER DEFAULT 0,
    auto_restart INTEGER DEFAULT 0,
    block_count INTEGER DEFAULT 0,
    backup_urls TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stream_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT DEFAULT 'youtube',
    rtmp_url TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS source_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT DEFAULT 'douyin',
    url TEXT NOT NULL,
    live_status TEXT DEFAULT 'unknown',
    last_check TEXT,
    auto_start INTEGER DEFAULT 0,
    auto_vps_id INTEGER REFERENCES vps(id) ON DELETE SET NULL,
    auto_stream_key_id INTEGER REFERENCES stream_keys(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    vps_id INTEGER NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    vps_id INTEGER NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    remote_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS yt_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    input TEXT NOT NULL,
    title TEXT,
    handle TEXT,
    thumbnail_url TEXT,
    subscriber_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    uploads_playlist_id TEXT,
    last_synced TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_yt_channels_user_channel
    ON yt_channels(user_id, channel_id);

  CREATE TABLE IF NOT EXISTS yt_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT,
    type TEXT DEFAULT 'video',
    duration_sec INTEGER,
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    concurrent_viewers INTEGER,
    live_start TEXT,
    live_end TEXT,
    published_at TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at DESC);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const actual = crypto.pbkdf2Sync(password, parts[1], 310000, 32, 'sha256');
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateSettingsPrimaryKey() {
  const columns = db.prepare('PRAGMA table_info(settings)').all();
  const keyPk = columns.find(c => c.name === 'key')?.pk || 0;
  const userPk = columns.find(c => c.name === 'user_id')?.pk || 0;
  if (keyPk && !userPk) {
    db.exec('ALTER TABLE settings RENAME TO settings_old');
    db.exec(`
      CREATE TABLE settings (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (user_id, key)
      );
    `);
    db.prepare(`
      INSERT OR IGNORE INTO settings (user_id, key, value)
      SELECT ?, key, value FROM settings_old
    `).run(defaultUserId);
    db.exec('DROP TABLE settings_old');
  }
}

[
  ['tasks', 'last_active_at', 'TEXT'],
  ['tasks', 'stall_count', 'INTEGER DEFAULT 0'],
  ['tasks', 'auto_restart', 'INTEGER DEFAULT 0'],
  ['tasks', 'block_count', 'INTEGER DEFAULT 0'],
  ['tasks', 'backup_urls', 'TEXT'],
  ['tasks', 'youtube_video_id', 'TEXT'],
  ['tasks', 'youtube_live_status', 'TEXT'],
  ['tasks', 'youtube_viewers', 'INTEGER'],
  ['tasks', 'youtube_views', 'INTEGER'],
  ['tasks', 'youtube_title', 'TEXT'],
  ['tasks', 'youtube_last_check', 'TEXT'],
  ['tasks', 'youtube_check_error', 'TEXT'],
  ['stream_keys', 'default_vps_id', 'INTEGER REFERENCES vps(id) ON DELETE SET NULL'],
  ['stream_keys', 'youtube_url', 'TEXT'],
  ['stream_keys', 'youtube_channel_id', 'INTEGER REFERENCES yt_channels(id) ON DELETE SET NULL'],
  ['yt_channels', 'current_live_video_id', 'TEXT'],
].forEach(([table, column, definition]) => {
  ensureColumn(table, column, definition);
});

const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
if (userCount === 0) {
  const initialAdminPassword = process.env.ADMIN_PASSWORD;
  if (process.env.NODE_ENV === 'production' && !initialAdminPassword) {
    throw new Error('ADMIN_PASSWORD is required when creating the first admin user in production');
  }
  const passwordToUse = initialAdminPassword || crypto.randomBytes(18).toString('base64url');
  if (!initialAdminPassword) {
    console.warn(`[db] Created development admin user. Temporary password: ${passwordToUse}`);
  }
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run('admin', hashPassword(passwordToUse), 'admin');
}

const defaultUserId = db.prepare("SELECT id FROM users WHERE username='admin'").get()?.id || 1;

migrateSettingsPrimaryKey();

['vps', 'tasks', 'stream_keys', 'source_channels', 'media_files'].forEach(table => {
  ensureColumn(table, 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  db.prepare(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(defaultUserId);
});

// 确保唯一索引存在（IF NOT EXISTS 保证幂等，不删除数据）
// 注意：已删除原有的 DELETE FROM source_channels 语句，该语句每次启动都会静默清除重复行，存在数据丢失风险
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_source_channels_user_url
  ON source_channels(user_id, url);
`);

ensureColumn('settings', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
try {
  db.prepare('UPDATE settings SET user_id=? WHERE user_id IS NULL').run(defaultUserId);
} catch (_) {}

const defaults = {
  start_delay: '5',
  stall_timeout: '120',
  max_tasks_per_vps: '5',
  block_limit: '8',
  monitor_interval: '5',
  youtube_api_key: '',
  youtube_api_keys: '',
  youtube_api_key_cursor: '0',
  youtube_api_key_status: '{}',
};

function ensureDefaultSettings(userId) {
  for (const [key, value] of Object.entries(defaults)) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE user_id = ? AND key = ?').get(userId, key);
    if (!exists) {
      db.prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, value);
    }
  }
}

db.prepare('SELECT id FROM users').all().forEach(user => ensureDefaultSettings(user.id));

function writeEvent(taskId, userId, fromStatus, toStatus, reason) {
  try {
    db.prepare('INSERT INTO task_events (task_id, user_id, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, userId, fromStatus || null, toStatus, reason || null);
  } catch (e) {
    console.warn('[task_events] write failed:', e.message);
  }
}

function getSetting(key, userId = defaultUserId) {
  return db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key)?.value;
}

function getGlobalSetting(key) {
  return db.prepare('SELECT value FROM global_settings WHERE key = ?').get(key)?.value;
}

function setGlobalSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = db;
module.exports.getSetting = getSetting;
module.exports.getGlobalSetting = getGlobalSetting;
module.exports.setGlobalSetting = setGlobalSetting;
module.exports.ensureDefaultSettings = ensureDefaultSettings;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.defaultUserId = defaultUserId;
module.exports.writeEvent = writeEvent;
