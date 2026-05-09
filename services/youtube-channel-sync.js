const db = require('../db');
const { getUsableYouTubeApiKeys, getEffectiveApiUserId } = require('./youtube-monitor');

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function ytApi(endpoint, params, apiKey) {
  const u = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, v);
  }
  u.searchParams.set('key', apiKey);
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(stripHtml(json?.error?.message) || `YouTube API ${res.status}`);
    err.reason = json?.error?.errors?.[0]?.reason || '';
    err.status = res.status;
    throw err;
  }
  return json;
}

function parseDuration(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function isQuotaError(e) {
  return /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|keyInvalid|API_KEY_INVALID/i.test(
    String(e?.reason || '') + String(e?.message || '')
  );
}

async function withKey(userId, fn) {
  const effectiveUserId = getEffectiveApiUserId(userId);
  const keys = getUsableYouTubeApiKeys(effectiveUserId);
  if (!keys.length) throw new Error('未配置可用的 YouTube API Key');
  let lastErr;
  for (const key of keys) {
    try {
      return await fn(key);
    } catch (e) {
      lastErr = e;
      if (!isQuotaError(e)) throw e;
    }
  }
  throw lastErr;
}

function parseChannelInput(raw) {
  raw = String(raw || '').trim();
  if (/^UC[\w-]{22}$/.test(raw)) return { type: 'id', value: raw };
  try {
    const urlStr = /^https?:\/\//i.test(raw) ? raw : `https://youtube.com/${raw}`;
    const u = new URL(urlStr);
    if (u.hostname.endsWith('youtube.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && /^UC/.test(parts[1] || '')) return { type: 'id', value: parts[1] };
      if (parts[0]?.startsWith('@')) return { type: 'handle', value: parts[0].slice(1) };
      if (parts[0] === 'c' && parts[1]) return { type: 'handle', value: parts[1] };
      if (parts[0] === 'user' && parts[1]) return { type: 'username', value: parts[1] };
      if (parts[0] && !/^(watch|shorts|live|embed)$/i.test(parts[0])) return { type: 'handle', value: parts[0] };
    }
  } catch (_) {}
  if (raw.startsWith('@')) return { type: 'handle', value: raw.slice(1) };
  return { type: 'handle', value: raw };
}

async function resolveChannelId(userId, input) {
  const parsed = parseChannelInput(input);
  if (parsed.type === 'id') return parsed.value;

  return withKey(userId, async (key) => {
    if (parsed.type === 'handle' || parsed.type === 'username') {
      // Try forHandle first (modern @handle)
      const r1 = await ytApi('channels', { part: 'id', forHandle: parsed.value, maxResults: 1 }, key);
      if (r1.items?.[0]?.id) return r1.items[0].id;
      // Try forUsername (legacy)
      const r2 = await ytApi('channels', { part: 'id', forUsername: parsed.value, maxResults: 1 }, key);
      if (r2.items?.[0]?.id) return r2.items[0].id;
    }
    throw new Error('找不到该 YouTube 频道，请检查链接或 ID 格式');
  });
}

async function fetchChannelMeta(userId, channelId) {
  return withKey(userId, async (key) => {
    const r = await ytApi('channels', {
      part: 'snippet,contentDetails,statistics',
      id: channelId,
    }, key);
    const item = r.items?.[0];
    if (!item) throw new Error('频道不存在或无法访问');
    return {
      title: item.snippet?.title || '',
      handle: item.snippet?.customUrl || '',
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
      subscriberCount: parseInt(item.statistics?.subscriberCount || 0) || 0,
      videoCount: parseInt(item.statistics?.videoCount || 0) || 0,
      viewCount: parseInt(item.statistics?.viewCount || 0) || 0,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || '',
    };
  });
}

async function syncChannel(userId, channelDbId) {
  const ch = db.prepare('SELECT * FROM yt_channels WHERE id=? AND user_id=?').get(channelDbId, userId);
  if (!ch) throw new Error('频道不存在');

  const meta = await fetchChannelMeta(userId, ch.channel_id);
  db.prepare(`
    UPDATE yt_channels
    SET title=?, handle=?, thumbnail_url=?, subscriber_count=?, video_count=?, view_count=?,
        uploads_playlist_id=?, last_synced=datetime('now')
    WHERE id=?
  `).run(meta.title, meta.handle, meta.thumbnailUrl, meta.subscriberCount,
    meta.videoCount, meta.viewCount, meta.uploadsPlaylistId, channelDbId);

  if (!meta.uploadsPlaylistId) return { synced: 0, skipped: 0, total: 0 };

  // Fetch up to 50 recent video IDs from uploads playlist
  const videoIds = [];
  const plR = await withKey(userId, key => ytApi('playlistItems', {
    part: 'snippet', playlistId: meta.uploadsPlaylistId, maxResults: 50,
  }, key));
  for (const item of plR.items || []) {
    const vid = item.snippet?.resourceId?.videoId;
    if (vid) videoIds.push(vid);
  }
  if (!videoIds.length) return { synced: 0, skipped: 0, total: 0 };

  // Fetch video details
  const allVideos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const r = await withKey(userId, key => ytApi('videos', {
      part: 'snippet,contentDetails,statistics,liveStreamingDetails',
      id: videoIds.slice(i, i + 50).join(','),
    }, key));
    allVideos.push(...(r.items || []));
  }

  let synced = 0, skipped = 0;
  const now = new Date().toISOString();

  // 找出正在进行的直播（有开始时间但无结束时间）
  const ongoingLive = allVideos.find(v => v.liveStreamingDetails?.actualStartTime && !v.liveStreamingDetails?.actualEndTime);
  db.prepare('UPDATE yt_channels SET current_live_video_id=? WHERE id=?').run(ongoingLive?.id || null, channelDbId);

  for (const v of allVideos) {
    const rawDuration = parseDuration(v.contentDetails?.duration);
    const ld = v.liveStreamingDetails;
    const isLive = !!(ld?.actualStartTime || ld?.scheduledStartTime);
    const type = isLive ? 'live' : (rawDuration > 0 && rawDuration < 60 ? 'shorts' : 'video');

    if (type === 'shorts') { skipped++; continue; }

    const liveStart = ld?.actualStartTime || null;
    const liveEnd = ld?.actualEndTime || null;
    let durationSec = rawDuration;
    if (isLive && liveStart && liveEnd) {
      durationSec = Math.round((new Date(liveEnd) - new Date(liveStart)) / 1000);
    }

    db.prepare(`
      INSERT INTO yt_videos
        (user_id, channel_id, video_id, title, type, duration_sec, view_count, like_count,
         concurrent_viewers, live_start, live_end, published_at, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id, video_id) DO UPDATE SET
        title=excluded.title, type=excluded.type, duration_sec=excluded.duration_sec,
        view_count=excluded.view_count, like_count=excluded.like_count,
        concurrent_viewers=excluded.concurrent_viewers,
        live_start=excluded.live_start, live_end=excluded.live_end,
        fetched_at=excluded.fetched_at
    `).run(
      userId, ch.channel_id, v.id,
      v.snippet?.title || '', type, durationSec,
      parseInt(v.statistics?.viewCount || 0) || 0,
      parseInt(v.statistics?.likeCount || 0) || 0,
      parseInt(ld?.concurrentViewers || 0) || null,
      liveStart, liveEnd,
      v.snippet?.publishedAt || null, now
    );
    synced++;
  }

  return { synced, skipped, total: allVideos.length };
}

module.exports = { resolveChannelId, fetchChannelMeta, syncChannel };
