const express = require('express');
const router = express.Router();
const db = require('../db');
const taskManager = require('../services/task-manager');

function getFormData(userId) {
  let streamKeys = [];
  try {
    streamKeys = db.prepare('SELECT id, name, platform, rtmp_url, stream_key FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(userId);
  } catch (_) {}
  return {
    vpsList:    db.prepare('SELECT id, name FROM vps WHERE user_id=? ORDER BY name').all(userId),
    streamKeys,
  };
}

router.get('/', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, v.name as vps_name FROM tasks t
    LEFT JOIN vps v ON t.vps_id = v.id
    WHERE t.user_id = ?
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'stalled' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, t.created_at DESC
  `).all(req.session.userId);
  res.render('tasks', {
    title: '任务管理 - 转推控制台',
    currentPath: '/tasks',
    tasks, error: null,
    ...getFormData(req.session.userId),
    PLATFORM_RTMP: taskManager.PLATFORM_RTMP,
  });
});

router.post('/', (req, res) => {
  const { name, vps_id, platform, source_url, backup_urls, rtmp_url, stream_key, auto_restart, notes } = req.body;
  let cleanUrl = source_url;
  try {
    const u = new URL(source_url);
    if (/douyin\.com/i.test(u.hostname)) cleanUrl = u.origin + u.pathname;
  } catch (_) {}
  try {
    db.prepare(`
      INSERT INTO tasks (user_id, name, vps_id, platform, source_url, backup_urls, rtmp_url, stream_key, auto_restart, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.session.userId,
      name || null,
      vps_id || null,
      platform || 'youtube',
      cleanUrl, backup_urls || null, rtmp_url, stream_key,
      auto_restart === '1' ? 1 : 0,
      notes || null
    );
    res.redirect('/tasks?toast=' + encodeURIComponent('任务创建成功') + '&type=success');
  } catch (e) {
    const tasks = db.prepare('SELECT t.*, v.name as vps_name FROM tasks t LEFT JOIN vps v ON t.vps_id=v.id WHERE t.user_id=? ORDER BY t.created_at DESC').all(req.session.userId);
    res.render('tasks', { title:'任务管理 - 转推控制台', currentPath:'/tasks', tasks, error: e.message, ...getFormData(req.session.userId), PLATFORM_RTMP: taskManager.PLATFORM_RTMP });
  }
});

// 批量操作（必须放在 /:id 路由之前，否则会被当成 id 匹配）
router.post('/batch-start', async (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(Number).filter(Boolean);
  if (ids.length === 0) return res.json({ ok: false, msg: '未选择任务' });
  for (const id of ids) taskManager.startTaskQueued(id, req.session.userId);
  res.json({ ok: true, msg: `${ids.length} 个任务已加入启动队列，请稍等…` });
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
  if (task && ['running','stalled','restarting'].includes(task.status)) {
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
  let cleanUrl = source_url || '';
  try {
    const u = new URL(cleanUrl);
    if (/douyin\.com/i.test(u.hostname)) cleanUrl = u.origin + u.pathname;
  } catch (_) {}
  try {
    db.prepare(`
      UPDATE tasks SET name=?, vps_id=?, source_url=?, backup_urls=?, rtmp_url=?, stream_key=?, auto_restart=?, notes=?
      WHERE id=? AND user_id=?
    `).run(
      name || null, vps_id || null, cleanUrl, backup_urls || null,
      rtmp_url, stream_key,
      (auto_restart === '1' || auto_restart === true || auto_restart === 1) ? 1 : 0,
      notes || null,
      req.params.id,
      req.session.userId
    );
    res.json({ ok: true, msg: '任务已更新' });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// 校准：立即检测开播状态，若已开播则启动任务
router.post('/:id/calibrate', async (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
  if (!task) return res.json({ ok: false, msg: '任务不存在' });
  try {
    await taskManager.checkAndStartIfLive(task);
    const updated = db.prepare('SELECT status FROM tasks WHERE id=? AND user_id=?').get(taskId, req.session.userId);
    const started = ['running', 'restarting'].includes(updated?.status);
    res.json({
      ok: true, started,
      status: updated?.status,
      msg: started ? '检测到开播，任务已启动！' : '主播尚未开播，继续等待',
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

module.exports = router;
