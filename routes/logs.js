const express = require('express');
const router = express.Router();
const db = require('../db');
const sshService = require('../services/ssh');

// 日志列表
router.get('/', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.id, t.name, t.source_url, t.status, t.log_file, v.name as vps_name
    FROM tasks t LEFT JOIN vps v ON t.vps_id = v.id
    WHERE t.user_id=? AND t.log_file IS NOT NULL
    ORDER BY t.status='running' DESC, t.id DESC
  `).all(req.session.userId);
  res.render('logs', { title: '日志 - 转推控制台', currentPath: '/logs', tasks });
});

// 查看某任务日志（tail 远端文件）
router.get('/:taskId', async (req, res) => {
  const task = db.prepare('SELECT t.*, v.name as vps_name FROM tasks t LEFT JOIN vps v ON t.vps_id = v.id WHERE t.id = ? AND t.user_id=?').get(req.params.taskId, req.session.userId);
  if (!task) return res.redirect('/logs');

  let logContent = '';
  let slLogContent = '';
  if (task.log_file && task.vps_id) {
    try {
      const result = await sshService.exec(task.vps_id, `tail -n 200 ${task.log_file} 2>/dev/null || echo '[日志文件不存在]'`);
      logContent = result.stdout || result.stderr || '[暂无日志]';
    } catch (e) {
      logContent = `[SSH 连接失败: ${e.message}]`;
    }
    // 抖音 streamlink 辅助日志
    try {
      const slLog = `/tmp/sl_${task.id}.log`;
      const slResult = await sshService.exec(task.vps_id, `test -s ${slLog} && tail -n 50 ${slLog} 2>/dev/null || echo ''`);
      slLogContent = (slResult.stdout || '').trim();
    } catch (_) {}
  } else {
    logContent = '[任务未运行或未绑定 VPS]';
  }

  res.render('log-detail', {
    title: `日志 - ${task.name || task.id} - 转推控制台`,
    currentPath: '/logs',
    task, logContent, slLogContent,
  });
});

// HTMX 轮询日志内容
router.get('/:taskId/tail', async (req, res) => {
  res.locals.layout = false;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id=?').get(req.params.taskId, req.session.userId);
  if (!task || !task.log_file || !task.vps_id) {
    return res.send('<pre class="text-gray-300 text-xs">[暂无日志]</pre>');
  }
  try {
    const result = await sshService.exec(task.vps_id, `tail -n 200 ${task.log_file} 2>/dev/null || echo '[日志文件不存在]'`);
    const content = (result.stdout || result.stderr || '[暂无日志]').replace(/</g, '&lt;');
    res.send(`<pre class="text-gray-300 text-xs whitespace-pre-wrap break-all">${content}</pre>`);
  } catch (e) {
    res.send(`<pre class="text-red-400 text-xs">[SSH 错误: ${e.message}]</pre>`);
  }
});

module.exports = router;
