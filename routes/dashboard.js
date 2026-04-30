const express = require('express');
const router = express.Router();
const db = require('../db');

function getStats(userId) {
  const totalVps = db.prepare('SELECT COUNT(*) as n FROM vps WHERE user_id=?').get(userId).n;
  const onlineVps = db.prepare("SELECT COUNT(*) as n FROM vps WHERE user_id=? AND status='online'").get(userId).n;
  const runningTasks = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE user_id=? AND status='running'").get(userId).n;
  const errorTasks = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE user_id=? AND status IN ('error','stalled','blocked')").get(userId).n;
  const totalTasks = db.prepare('SELECT COUNT(*) as n FROM tasks WHERE user_id=?').get(userId).n;
  return { totalVps, onlineVps, runningTasks, errorTasks, totalTasks };
}

function getRecentTasks(userId) {
  return db.prepare(`
    SELECT t.*, v.name as vps_name FROM tasks t
    LEFT JOIN vps v ON t.vps_id = v.id
    WHERE t.user_id = ?
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'stalled' THEN 1 WHEN 'restarting' THEN 2 WHEN 'waiting_live' THEN 3 WHEN 'error' THEN 4 WHEN 'blocked' THEN 5 ELSE 6 END, t.started_at DESC
    LIMIT 50
  `).all(userId);
}

router.get('/', (req, res) => {
  res.render('dashboard', {
    title: '状态面板 - 转推控制台',
    currentPath: '/dashboard',
    stats: getStats(req.session.userId),
    tasks: getRecentTasks(req.session.userId),
  });
});

// HTMX 轮询接口 — 返回统计卡片 HTML 片段（无 layout）
router.get('/stats', (req, res) => {
  res.locals.layout = false;
  const stats = getStats(req.session.userId);
  const tasks = getRecentTasks(req.session.userId);
  res.render('partials/stats', { stats, tasks });
});

module.exports = router;
