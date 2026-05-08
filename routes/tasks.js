const express = require('express');
const router = express.Router();
const db = require('../db');
const { getSetting } = require('../db');
const taskManager = require('../services/task-manager');
const platformApi = require('../services/platform-api');
const youtubeMonitor = require('../services/youtube-monitor');

function getDouyinCookies(userId) {
  return getSetting('douyin_cookies', userId) || '';
}

function getFormData(userId) {
  let streamKeys = [];
  let sourceChannels = [];
  try {
    streamKeys = db.prepare('SELECT id, name, platform, rtmp_url, stream_key, notes, default_vps_id FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(userId);
  } catch (_) {}
  try {
    sourceChannels = db.prepare(`
      SELECT id, name, platform, url, live_status, auto_vps_id, auto_stream_key_id
      FROM source_channels
      WHERE user_id=?
      ORDER BY CASE live_status WHEN 'live' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, name
    `).all(userId);
  } catch (_) {}
  return {
    vpsList: db.prepare('SELECT id, name FROM vps WHERE user_id=? ORDER BY name').all(userId),
    streamKeys,
    sourceChannels,
  };
}

function getTaskRows(userId, orderSql = "CASE t.status WHEN 'running' THEN 0 WHEN 'source_retrying' THEN 1 WHEN 'target_lost' THEN 2 WHEN 'stalled' THEN 3 WHEN 'restarting' THEN 4 WHEN 'waiting_live' THEN 5 WHEN 'error' THEN 6 ELSE 7 END, t.created_at DESC") {
  db.prepare(`
    UPDATE tasks
    SET name = (
      SELECT '[Auto] ' || c.name
      FROM source_channels c
      WHERE c.user_id = tasks.user_id AND c.url = tasks.source_url AND c.name IS NOT NULL AND c.name != ''
      ORDER BY c.id DESC
      LIMIT 1
    )
    WHERE user_id = ?
      AND (name IS NULL OR trim(name) = '' OR name = '--')
      AND EXISTS (
        SELECT 1 FROM source_channels c
        WHERE c.user_id = tasks.user_id AND c.url = tasks.source_url AND c.name IS NOT NULL AND c.name != ''
      )
  `).run(userId);

  return db.prepare(`
    SELECT t.*,
      v.name as vps_name,
      (SELECT c.name FROM source_channels c WHERE c.user_id = t.user_id AND c.url = t.source_url ORDER BY c.id DESC LIMIT 1) as channel_name,
      (SELECT sk.name FROM stream_keys sk WHERE sk.user_id = t.user_id AND sk.rtmp_url = t.rtmp_url AND sk.stream_key = t.stream_key ORDER BY sk.id DESC LIMIT 1) as stream_key_name,
      (SELECT sk.notes FROM stream_keys sk WHERE sk.user_id = t.user_id AND sk.rtmp_url = t.rtmp_url AND sk.stream_key = t.stream_key ORDER BY sk.id DESC LIMIT 1) as stream_key_notes,
      (SELECT sk.youtube_url FROM stream_keys sk WHERE sk.user_id = t.user_id AND sk.rtmp_url = t.rtmp_url AND sk.stream_key = t.stream_key ORDER BY sk.id DESC LIMIT 1) as stream_key_youtube_url
    FROM tasks t
    LEFT JOIN vps v ON t.vps_id = v.id
    WHERE t.user_id = ?
    ORDER BY ${orderSql}
  `).all(userId);
}

function fallbackTaskName(sourceUrl) {
  try {
    const u = new URL(sourceUrl || '');
    const host = u.hostname.toLowerCase();
    const id = u.pathname.split('/').filter(Boolean).pop();
    if (/douyin\.com$/i.test(host) && id) return `抖音直播间 ${id.slice(-12)}`;
    if (/bilibili\.com$/i.test(host) && id) return `B站直播间 ${id}`;
    if (id) return `直播间 ${id.slice(-12)}`;
  } catch (_) {}
  return null;
}

async function resolveTaskName(inputName, sourceUrl, userId) {
  const given = String(inputName || '').trim();
  if (given && given !== '--') return given;

  const channel = db.prepare(`
    SELECT name FROM source_channels
    WHERE user_id=? AND url=? AND name IS NOT NULL AND name != ''
    ORDER BY id DESC LIMIT 1
  `).get(userId, sourceUrl);
  if (channel?.name) return `[Auto] ${channel.name}`;

  if (/douyin\.com/i.test(sourceUrl || '')) {
    try {
      const info = await platformApi.getDouyinChannelInfo(sourceUrl, getDouyinCookies(userId));
      if (info?.name) return `[Auto] ${info.name}`;
    } catch (_) {}
  }

  return fallbackTaskName(sourceUrl);
}

function renderTasks(res, req, status, error = null) {
  return res.status(status).render('tasks', {
    title: '任务管理 - 转推控制台',
    currentPath: '/tasks',
    tasks: getTaskRows(req.session.userId),
    error,
    ...getFormData(req.session.userId),
    PLATFORM_RTMP: taskManager.PLATFORM_RTMP,
  });
}

function cleanSourceUrl(sourceUrl) {
  let cleanUrl = sourceUrl || '';
  try {
    const u = new URL(cleanUrl);
    if (/douyin\.com/i.test(u.hostname)) cleanUrl = u.origin + u.pathname;
  } catch (_) {}
  return cleanUrl;
}

function validateMediaPath(userId, vpsId, filePath) {
  if (!filePath) return true;
  return !!db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?').get(userId, vpsId, filePath);
}

function validateSourceForVps(userId, vpsId, sourceUrl) {
  const value = String(sourceUrl || '').trim();
  if (!value.startsWith('/')) return true;
  if (!vpsId) return false;
  return validateMediaPath(userId, vpsId, value);
}

function findDefaultVpsForStreamKey(userId, rtmpUrl, streamKey) {
  return db.prepare(`
    SELECT default_vps_id FROM stream_keys
    WHERE user_id=? AND rtmp_url=? AND stream_key=? AND default_vps_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(userId, rtmpUrl, streamKey)?.default_vps_id || null;
}

router.get('/', (req, res) => renderTasks(res, req, 200));

router.post('/', async (req, res) => {
  const { name, platform, source_url, backup_urls, rtmp_url, stream_key, auto_restart, notes } = req.body;
  const vps_id = req.body.vps_id || findDefaultVpsForStreamKey(req.session.userId, rtmp_url, stream_key);

  if (vps_id) {
    const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(vps_id, req.session.userId);
    if (!vps) return renderTasks(res, req, 403, 'VPS 不存在或无权限');
  }

  const cleanUrl = cleanSourceUrl(source_url);
  if (!validateSourceForVps(req.session.userId, vps_id, cleanUrl)) {
    return renderTasks(res, req, 400, '文件路径不属于当前 VPS 媒体库，请从媒体库选择或先上传/扫描');
  }

  try {
    const resolvedName = await resolveTaskName(name, cleanUrl, req.session.userId);
    db.prepare(`
      INSERT INTO tasks (user_id, name, vps_id, platform, source_url, backup_urls, rtmp_url, stream_key, auto_restart, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      resolvedName || null,
      vps_id || null,
      platform || 'youtube',
      cleanUrl, backup_urls || null, rtmp_url, stream_key,
      auto_restart === '1' ? 1 : 0,
      notes || null
    );
    res.redirect('/tasks?toast=' + encodeURIComponent('任务创建成功') + '&type=success');
  } catch (e) {
    renderTasks(res, req, 500, e.message);
  }
});

router.post('/batch-start', async (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  if (ids.length === 0) return res.json({ ok: false, msg: '未选择任务' });
  for (const id of ids) taskManager.startTaskQueued(id, req.session.userId);
  res.json({ ok: true, msg: `${ids.length} 个任务已加入启动队列` });
});

router.post('/batch-stop', async (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  if (ids.length === 0) return res.json({ ok: false, msg: '未选择任务' });
  const failed = [];
  for (const id of ids) {
    try { await taskManager.stopTask(id, req.session.userId); }
    catch (_) { failed.push(id); }
  }
  const msg = failed.length === 0
    ? `${ids.length} 个任务已停止`
    : `${ids.length - failed.length} 个已停止，${failed.length} 个失败`;
  res.json({ ok: true, msg });
});

router.post('/:id/delete', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (task && ['running', 'source_retrying', 'stalled', 'target_lost', 'restarting'].includes(task.status)) {
    await taskManager.stopTask(task.id, req.session.userId).catch(() => {});
  }
  db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.redirect('/tasks?toast=' + encodeURIComponent('任务已删除') + '&type=success');
});

router.post('/:id/start', async (req, res) => {
  const taskId = parseInt(req.params.id);
  try {
    await taskManager.startTask(taskId, req.session.userId);
    const updated = db.prepare('SELECT status FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
    if (updated?.status === 'waiting_live') {
      res.json({ ok: true, msg: '主播未开播，已进入等待直播模式' });
    } else {
      res.json({ ok: true, msg: '任务已启动' });
    }
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    await taskManager.stopTask(parseInt(req.params.id), req.session.userId);
    res.json({ ok: true, msg: '任务已停止' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/toggle-restart', (req, res) => {
  const task = db.prepare('SELECT auto_restart FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!task) return res.json({ ok: false });
  const newVal = task.auto_restart ? 0 : 1;
  db.prepare('UPDATE tasks SET auto_restart=? WHERE id=? AND user_id=?').run(newVal, req.params.id, req.session.userId);
  res.json({ ok: true, auto_restart: newVal });
});

router.post('/:id/edit', (req, res) => {
  const { name, vps_id, source_url, backup_urls, rtmp_url, stream_key, auto_restart, notes } = req.body;

  if (vps_id) {
    const vps = db.prepare('SELECT id FROM vps WHERE id=? AND user_id=?').get(vps_id, req.session.userId);
    if (!vps) return res.status(403).json({ ok: false, msg: 'VPS 不存在或无权限' });
  }

  const cleanUrl = cleanSourceUrl(source_url);
  if (!validateSourceForVps(req.session.userId, vps_id, cleanUrl)) {
    return res.status(400).json({ ok: false, msg: '文件路径不属于当前 VPS 媒体库，请从媒体库选择或先上传/扫描' });
  }

  try {
    const result = db.prepare(`
      UPDATE tasks SET name=?, vps_id=?, source_url=?, backup_urls=?, rtmp_url=?, stream_key=?, auto_restart=?, notes=?
      WHERE id=? AND user_id=?
    `).run(
      name || null,
      vps_id || null,
      cleanUrl,
      backup_urls || null,
      rtmp_url,
      stream_key,
      (auto_restart === '1' || auto_restart === true || auto_restart === 1) ? 1 : 0,
      notes || null,
      req.params.id,
      req.session.userId
    );
    if (result.changes === 0) return res.status(404).json({ ok: false, msg: '任务不存在' });
    res.json({ ok: true, msg: '任务已更新' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/calibrate', async (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
  if (!task) return res.status(404).json({ ok: false, msg: '任务不存在' });
  try {
    await taskManager.checkAndStartIfLive(task);
    const updated = db.prepare('SELECT status FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
    const started = ['running', 'restarting'].includes(updated?.status);
    res.json({
      ok: true,
      started,
      status: updated?.status,
      msg: started ? '已检测到开播并启动任务' : '未检测到开播，任务继续等待',
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.post('/:id/check-youtube', async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = db.prepare(`
    SELECT t.id, t.user_id, t.youtube_video_id, sk.youtube_url,
           sk.youtube_channel_id, yc.channel_id as yt_channel_id, yc.current_live_video_id
    FROM tasks t
    LEFT JOIN stream_keys sk
      ON sk.user_id = t.user_id
     AND sk.rtmp_url = t.rtmp_url
     AND sk.stream_key = t.stream_key
    LEFT JOIN yt_channels yc ON yc.id = sk.youtube_channel_id AND yc.user_id = t.user_id
    WHERE t.id=? AND t.user_id=?
  `).get(taskId, req.session.userId);
  if (!task) return res.status(404).json({ ok: false, msg: '任务不存在' });

  const result = await youtubeMonitor.checkTask(task);
  if (result.skipped) return res.json({ ok: false, skipped: true, msg: result.msg });
  if (!result.ok) return res.json({ ok: false, msg: result.msg || 'YouTube 检测失败' });
  const updated = db.prepare(`
    SELECT youtube_live_status, youtube_viewers, youtube_views, youtube_title, youtube_last_check, youtube_check_error
    FROM tasks WHERE id=? AND user_id=?
  `).get(taskId, req.session.userId);
  res.json({ ok: true, msg: 'YouTube 状态已更新', data: updated });
});

module.exports = router;
