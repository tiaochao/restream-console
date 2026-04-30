const express = require('express');
const router = express.Router();
const db = require('../db');
const sshService = require('../services/ssh');

// 推流码列表
router.get('/', (req, res) => {
  const keys = db.prepare('SELECT * FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(req.session.userId);
  res.render('stream-keys', { title: '推流码管理 - 转推控制台', currentPath: '/stream-keys', keys, error: null });
});

// 新增推流码
router.post('/', (req, res) => {
  const { name, platform, rtmp_url, stream_key, notes } = req.body;
  try {
    db.prepare('INSERT INTO stream_keys (user_id,name,platform,rtmp_url,stream_key,notes) VALUES(?,?,?,?,?,?)')
      .run(req.session.userId, name, platform || 'youtube', rtmp_url, stream_key, notes || null);
    res.redirect('/stream-keys?toast=' + encodeURIComponent('推流码已添加') + '&type=success');
  } catch (e) {
    const keys = db.prepare('SELECT * FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(req.session.userId);
    res.render('stream-keys', { title:'推流码管理 - 转推控制台', currentPath:'/stream-keys', keys, error: e.message });
  }
});

// 删除推流码
router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM stream_keys WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.redirect('/stream-keys?toast=' + encodeURIComponent('已删除') + '&type=success');
});

// 校验推流码：用 ffmpeg 探测 RTMP 端点是否可达（不真正推流，只 connect）
// 需要控制台服务器本身装了 ffmpeg，或者借用某台 VPS 来测试
router.post('/:id/verify', async (req, res) => {
  const key = db.prepare('SELECT * FROM stream_keys WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!key) return res.json({ ok: false, msg: '推流码不存在' });

  // 找一台在线的 VPS 来执行测试
  const vps = db.prepare("SELECT * FROM vps WHERE user_id=? AND status='online' LIMIT 1").get(req.session.userId);
  if (!vps) return res.json({ ok: false, msg: '没有在线 VPS 可用于校验，请先测试 VPS 连接' });

  const dest = `${key.rtmp_url}/${key.stream_key}`;
  // 用 ffmpeg 生成 1 秒黑色测试信号推送到 RTMP，若能连上即为有效
  const cmd = `timeout 10 ffmpeg -re -f lavfi -i color=black:s=1280x720:r=30 -f lavfi -i anullsrc -c:v libx264 -preset ultrafast -b:v 500k -c:a aac -t 3 -f flv "${dest}" 2>&1 | tail -5`;

  try {
    const result = await sshService.freshExec(vps.id, cmd);
    const output = (result.stdout + result.stderr).toLowerCase();
    const success = output.includes('frame=') || output.includes('muxing overhead') || output.includes('video:');
    const failed  = output.includes('connection refused') || output.includes('failed') || output.includes('error') && !success;

    if (success) {
      const cleaned = (key.notes || '').replace(/\s*\[校验通过\]/g, '').trim();
      const newNotes = cleaned ? cleaned + ' [校验通过]' : '[校验通过]';
      db.prepare("UPDATE stream_keys SET notes=? WHERE id=? AND user_id=?").run(newNotes, key.id, req.session.userId);
      return res.json({ ok: true, msg: '推流码有效，RTMP 连接成功' });
    }
    if (failed) {
      return res.json({ ok: false, msg: 'RTMP 连接失败，请检查推流码是否正确或直播是否开启' });
    }
    res.json({ ok: true, msg: '测试完成（无明显错误）' });
  } catch (e) {
    res.json({ ok: false, msg: 'SSH 执行失败: ' + e.message });
  }
});

// API：返回推流码列表（供任务创建表单选择）
router.get('/api/list', (req, res) => {
  const keys = db.prepare('SELECT id, name, platform, rtmp_url, stream_key FROM stream_keys WHERE user_id=? ORDER BY platform, name').all(req.session.userId);
  res.json(keys);
});

module.exports = router;
