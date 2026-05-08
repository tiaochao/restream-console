const express = require('express');
const router = express.Router();
const db = require('../db');
const { resolveChannelId, fetchChannelMeta, syncChannel } = require('../services/youtube-channel-sync');

const TITLE = 'YouTube 频道 - 转推控制台';

function fmtDuration(secs) {
  if (!secs || secs <= 0) return '--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtCount(n) {
  if (!n) return '0';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return n.toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '--';
  return String(iso).slice(0, 10);
}

router.get('/', (req, res) => {
  const channels = db.prepare(`
    SELECT yc.*,
      GROUP_CONCAT(sk.name, '|||') as linked_sk_names,
      COUNT(sk.id) as linked_sk_count
    FROM yt_channels yc
    LEFT JOIN stream_keys sk ON sk.youtube_channel_id = yc.id AND sk.user_id = yc.user_id
    WHERE yc.user_id=?
    GROUP BY yc.id
    ORDER BY yc.created_at DESC
  `).all(req.session.userId);
  channels.forEach(ch => {
    ch.linked_sk_names = ch.linked_sk_names ? ch.linked_sk_names.split('|||') : [];
  });
  res.render('youtube-channels', { title: TITLE, currentPath: '/youtube-channels', channels, fmtCount });
});

router.post('/', async (req, res) => {
  const input = String(req.body.input || '').trim().slice(0, 300);
  if (!input) {
    return res.redirect('/youtube-channels?toast=' + encodeURIComponent('请填写频道链接或 ID') + '&type=error');
  }
  try {
    const channelId = await resolveChannelId(req.session.userId, input);
    const exists = db.prepare('SELECT id FROM yt_channels WHERE user_id=? AND channel_id=?')
      .get(req.session.userId, channelId);
    if (exists) {
      return res.redirect('/youtube-channels?toast=' + encodeURIComponent('该频道已添加') + '&type=error');
    }
    const meta = await fetchChannelMeta(req.session.userId, channelId);
    db.prepare(`
      INSERT INTO yt_channels
        (user_id, channel_id, input, title, handle, thumbnail_url, subscriber_count, video_count, view_count, uploads_playlist_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(req.session.userId, channelId, input, meta.title, meta.handle, meta.thumbnailUrl,
      meta.subscriberCount, meta.videoCount, meta.viewCount, meta.uploadsPlaylistId);
    res.redirect('/youtube-channels?toast=' + encodeURIComponent(`已添加：${meta.title}`) + '&type=success');
  } catch (e) {
    res.redirect('/youtube-channels?toast=' + encodeURIComponent(e.message) + '&type=error');
  }
});

router.post('/:id/delete', (req, res) => {
  const ch = db.prepare('SELECT * FROM yt_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!ch) return res.redirect('/youtube-channels?toast=' + encodeURIComponent('频道不存在') + '&type=error');
  db.prepare('DELETE FROM yt_videos WHERE user_id=? AND channel_id=?').run(req.session.userId, ch.channel_id);
  db.prepare('DELETE FROM yt_channels WHERE id=?').run(ch.id);
  res.redirect('/youtube-channels?toast=' + encodeURIComponent('频道已删除') + '&type=success');
});

router.post('/:id/sync', async (req, res) => {
  const ch = db.prepare('SELECT id FROM yt_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!ch) return res.status(404).json({ ok: false, msg: '频道不存在' });
  try {
    const result = await syncChannel(req.session.userId, ch.id);
    res.json({ ok: true, msg: `同步完成，新增/更新 ${result.synced} 条记录（跳过 Shorts ${result.skipped} 条）`, result });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

router.get('/:id/videos', (req, res) => {
  const ch = db.prepare('SELECT * FROM yt_channels WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!ch) return res.status(404).json({ ok: false, msg: '频道不存在' });
  const type = req.query.type === 'video' ? 'video' : 'live';
  const rows = db.prepare(`
    SELECT * FROM yt_videos
    WHERE user_id=? AND channel_id=? AND type=?
    ORDER BY COALESCE(live_start, published_at) DESC
    LIMIT 100
  `).all(req.session.userId, ch.channel_id, type);
  res.json({
    ok: true,
    videos: rows.map(v => ({
      ...v,
      durationFmt: fmtDuration(v.duration_sec),
      viewFmt: fmtCount(v.view_count),
      concurrentFmt: v.concurrent_viewers ? fmtCount(v.concurrent_viewers) : '--',
      dateStr: fmtDate(v.live_start || v.published_at),
      url: `https://www.youtube.com/watch?v=${v.video_id}`,
    })),
  });
});

module.exports = router;
