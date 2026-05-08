const crypto = require('crypto');
const db = require('../db');
const { getSetting } = require('../db');
const { logError } = require('../utils/log-error');

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const CHECK_INTERVAL_MS = 60 * 1000;
const MAX_TASKS_PER_TICK = 12;
const TEST_VIDEO_ID = 'dQw4w9WgXcQ';
const KEY_PAUSE_MS = 6 * 60 * 60 * 1000;
const QUOTA_PAUSE_MS = 26 * 60 * 60 * 1000;

let scanning = false;

function setSetting(userId, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(user_id,key,value) VALUES(?,?,?)').run(userId, key, value);
}

function parseApiKeys(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\s,;，；]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter(v => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16);
}

function loadKeyStatusMap(userId) {
  try {
    return JSON.parse(getSetting('youtube_api_key_status', userId) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function saveKeyStatusMap(userId, statusMap) {
  setSetting(userId, 'youtube_api_key_status', JSON.stringify(statusMap || {}));
}

function getKeyStatus(userId, key) {
  return loadKeyStatusMap(userId)[keyFingerprint(key)] || null;
}

function setKeyStatus(userId, key, patch) {
  const map = loadKeyStatusMap(userId);
  const fp = keyFingerprint(key);
  map[fp] = {
    ...(map[fp] || {}),
    ...patch,
    fingerprint: fp,
    masked: maskApiKey(key),
    updatedAt: new Date().toISOString(),
  };
  saveKeyStatusMap(userId, map);
  return map[fp];
}

function isKeyPaused(status, nowMs = Date.now()) {
  return status?.pausedUntil && Date.parse(status.pausedUntil) > nowMs;
}

function classifyApiError(err) {
  const reason = String(err?.reason || '');
  const msg = String(err?.message || '');
  if (/quotaExceeded|dailyLimitExceeded/i.test(reason) || /quota|daily limit|exceeded/i.test(msg)) return 'quota';
  if (/rateLimitExceeded/i.test(reason) || /rate limit/i.test(msg)) return 'rate_limited';
  if (/keyInvalid|API_KEY_INVALID/i.test(reason) || /api key not valid|key invalid/i.test(msg)) return 'invalid';
  if (/forbidden|PERMISSION_DENIED/i.test(reason) || /forbidden|permission/i.test(msg)) return 'forbidden';
  return 'error';
}

function pauseUntilForErrorType(type) {
  if (type === 'quota') return new Date(Date.now() + QUOTA_PAUSE_MS).toISOString();
  if (type === 'invalid' || type === 'forbidden') return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  if (type === 'rate_limited') return new Date(Date.now() + KEY_PAUSE_MS).toISOString();
  return null;
}

function markKeyOk(userId, key) {
  return setKeyStatus(userId, key, {
    state: 'ok',
    lastError: '',
    errorType: '',
    pausedUntil: '',
    lastOkAt: new Date().toISOString(),
  });
}

function markKeyError(userId, key, err) {
  const errorType = classifyApiError(err);
  return setKeyStatus(userId, key, {
    state: errorType,
    lastError: err?.message || 'YouTube API 检测失败',
    errorType,
    pausedUntil: pauseUntilForErrorType(errorType) || '',
    lastFailAt: new Date().toISOString(),
  });
}

function getYouTubeApiKeys(userId) {
  const pooled = parseApiKeys(getSetting('youtube_api_keys', userId));
  const legacy = parseApiKeys(getSetting('youtube_api_key', userId));
  const envKeys = parseApiKeys(process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '');
  return [...pooled, ...legacy, ...envKeys].filter((key, index, arr) => arr.indexOf(key) === index);
}

function getUsableYouTubeApiKeys(userId) {
  const keys = getYouTubeApiKeys(userId);
  const now = Date.now();
  const usable = keys.filter(key => !isKeyPaused(getKeyStatus(userId, key), now));
  return usable.length ? usable : keys;
}

function getApiCursor(userId, size) {
  const raw = Number.parseInt(getSetting('youtube_api_key_cursor', userId) || '0', 10);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return size > 0 ? raw % size : 0;
}

function rotateApiCursor(userId, currentIndex, size) {
  if (!size) return;
  const next = (currentIndex + 1) % size;
  setSetting(userId, 'youtube_api_key_cursor', String(next));
}

function maskApiKey(key) {
  const s = String(key || '');
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function getYouTubeApiKey(userId) {
  const keys = getYouTubeApiKeys(userId);
  return keys[getApiCursor(userId, keys.length)] || '';
}

function isQuotaOrKeyError(err) {
  return ['quota', 'rate_limited', 'invalid', 'forbidden'].includes(classifyApiError(err));
}

function extractYouTubeVideoId(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
    if (host.endsWith('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'live' && parts[1]) return parts[1];
      if (parts[0] === 'shorts' && parts[1]) return parts[1];
      if (parts[0] === 'embed' && parts[1]) return parts[1];
    }
  } catch (err) { logError('extractVideoId', err); }
  return '';
}

function extractYouTubeChannelRef(url) {
  const raw = String(url || '').trim();
  if (!raw) return {};
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host.endsWith('youtube.com')) return {};
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && parts[1]) return { channelId: parts[1] };
    if (parts[0] === 'c' && parts[1]) return { handle: parts[1] };
    if (parts[0]?.startsWith('@')) return { handle: parts[0].slice(1) };
    if (parts[0] === 'user' && parts[1]) return { handle: parts[1] };
  } catch (err) { logError('extractChannelRef', err); }
  return {};
}

function normalizeLiveStatus(item) {
  const live = item.liveStreamingDetails || {};
  const snippet = item.snippet || {};
  if (live.actualEndTime) return 'complete';
  if (live.actualStartTime) return 'live';
  if (live.scheduledStartTime) return 'upcoming';
  if (snippet.liveBroadcastContent === 'live') return 'live';
  if (snippet.liveBroadcastContent === 'upcoming') return 'upcoming';
  return 'none';
}

async function youtubeApi(path, params, apiKey) {
  const u = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, value);
  }
  u.searchParams.set('key', apiKey);
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(json?.error?.message || `YouTube API HTTP ${res.status}`).replace(/<[^>]*>/g, '').trim();
    const err = new Error(msg);
    err.status = res.status;
    err.reason = json?.error?.errors?.[0]?.reason || json?.error?.status || '';
    throw err;
  }
  return json;
}

async function getVideoStatus(videoId, apiKey) {
  if (!videoId) return null;
  const json = await youtubeApi('videos', {
    part: 'snippet,liveStreamingDetails,statistics',
    id: videoId,
    maxResults: 1,
  }, apiKey);
  const item = json.items?.[0];
  if (!item) return { status: 'missing', videoId };
  return {
    status: normalizeLiveStatus(item),
    videoId: item.id || videoId,
    title: item.snippet?.title || '',
    viewers: Number.parseInt(item.liveStreamingDetails?.concurrentViewers || '', 10) || null,
    views: Number.parseInt(item.statistics?.viewCount || '', 10) || null,
    publishedAt: item.snippet?.publishedAt || '',
    scheduledStartTime: item.liveStreamingDetails?.scheduledStartTime || '',
    actualStartTime: item.liveStreamingDetails?.actualStartTime || '',
    actualEndTime: item.liveStreamingDetails?.actualEndTime || '',
    source: 'youtube-videos-api',
  };
}

async function testApiKey(apiKey) {
  await youtubeApi('videos', {
    part: 'id',
    id: TEST_VIDEO_ID,
    maxResults: 1,
  }, apiKey);
  return { ok: true };
}

async function testApiKeyPool(userId, rawKeys = null) {
  const keys = rawKeys === null ? getYouTubeApiKeys(userId) : parseApiKeys(rawKeys);
  const results = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    try {
      await testApiKey(key);
      const status = markKeyOk(userId, key);
      results.push({ index, ok: true, state: 'ok', masked: maskApiKey(key), fingerprint: keyFingerprint(key), status });
    } catch (e) {
      const status = markKeyError(userId, key, e);
      results.push({
        index,
        ok: false,
        state: status.state,
        msg: e.message,
        masked: maskApiKey(key),
        fingerprint: keyFingerprint(key),
        pausedUntil: status.pausedUntil,
      });
    }
  }
  return {
    ok: results.length > 0 && results.some(r => r.ok),
    total: keys.length,
    usable: results.filter(r => r.ok).length,
    results,
  };
}

async function findLiveVideoByChannelId(channelId, apiKey) {
  if (!channelId) return null;
  const json = await youtubeApi('search', {
    part: 'id,snippet',
    channelId,
    eventType: 'live',
    type: 'video',
    maxResults: 1,
  }, apiKey);
  const videoId = json.items?.[0]?.id?.videoId;
  return videoId ? getVideoStatus(videoId, apiKey) : { status: 'none', videoId: '' };
}

async function resolveChannelIdByHandle(handle, apiKey) {
  if (!handle) return '';
  const normalized = String(handle).replace(/^@/, '');
  const json = await youtubeApi('search', {
    part: 'snippet',
    q: `@${normalized}`,
    type: 'channel',
    maxResults: 1,
  }, apiKey);
  return json.items?.[0]?.snippet?.channelId || json.items?.[0]?.id?.channelId || '';
}

async function checkYouTubeTarget(youtubeUrl, apiKey) {
  const videoId = extractYouTubeVideoId(youtubeUrl);
  if (videoId) return getVideoStatus(videoId, apiKey);

  const ref = extractYouTubeChannelRef(youtubeUrl);
  if (ref.channelId) return findLiveVideoByChannelId(ref.channelId, apiKey);
  if (ref.handle) {
    const channelId = await resolveChannelIdByHandle(ref.handle, apiKey);
    if (channelId) return findLiveVideoByChannelId(channelId, apiKey);
  }

  return { status: 'unknown', videoId: '', error: '未能识别 YouTube 视频或频道链接' };
}

function taskTargetUrl(task) {
  // 频道同步写入的当前直播 video_id（最精确）
  if (task.current_live_video_id) return `https://www.youtube.com/watch?v=${task.current_live_video_id}`;
  // youtube_url 仅当是频道链接时才用（watch?v= 视频链接跳过，避免旧场次污染）
  if (task.youtube_url && !/[?&]v=/.test(task.youtube_url)) return task.youtube_url;
  // 已绑定频道时用频道 ID 做频道级检测
  if (task.yt_channel_id) return `https://www.youtube.com/channel/${task.yt_channel_id}`;
  return '';
}

function patchTask(taskId, data) {
  db.prepare(`
    UPDATE tasks
    SET youtube_video_id=?,
        youtube_live_status=?,
        youtube_viewers=?,
        youtube_views=?,
        youtube_title=?,
        youtube_last_check=datetime('now'),
        youtube_check_error=?
    WHERE id=?
  `).run(
    data.videoId || null,
    data.status || 'unknown',
    Number.isInteger(data.viewers) ? data.viewers : null,
    Number.isInteger(data.views) ? data.views : null,
    data.title || null,
    data.error || null,
    taskId
  );
}

async function checkTask(task) {
  const apiKeys = getUsableYouTubeApiKeys(task.user_id);
  if (apiKeys.length === 0) return { ok: false, skipped: true, msg: '未配置 YouTube API Key' };

  const url = taskTargetUrl(task);
  if (!url) return { ok: false, skipped: true, msg: '未绑定 YouTube 直播间或频道链接' };

  const startIndex = getApiCursor(task.user_id, apiKeys.length);
  let lastError = null;
  let retryableCount = 0;

  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const keyIndex = (startIndex + attempt) % apiKeys.length;
    const apiKey = apiKeys[keyIndex];
    try {
      const data = await checkYouTubeTarget(url, apiKey);
      markKeyOk(task.user_id, apiKey);
      rotateApiCursor(task.user_id, keyIndex, apiKeys.length);
      patchTask(task.id, data || { status: 'unknown', error: '无检测结果' });
      return { ok: true, data, keyIndex, keyCount: apiKeys.length };
    } catch (e) {
      lastError = e;
      markKeyError(task.user_id, apiKey, e);
      if (!isQuotaOrKeyError(e) || attempt === apiKeys.length - 1) break;
      retryableCount++;
      console.warn(`[youtube-monitor] task ${task.id}: API Key ${maskApiKey(apiKey)} 配额/权限不可用，切换下一个`);
      rotateApiCursor(task.user_id, keyIndex, apiKeys.length);
    }
  }

  patchTask(task.id, {
    videoId: task.youtube_video_id,
    status: 'unknown',
    error: apiKeys.length > 1 && retryableCount >= apiKeys.length - 1
      ? `YouTube API Key 池均不可用：${lastError?.message || '未知错误'}`
      : lastError?.message || 'YouTube API 检测失败',
  });
  return { ok: false, msg: lastError?.message || 'YouTube API 检测失败' };
}

async function scanOnce() {
  if (scanning) return;
  scanning = true;
  try {
    const tasks = db.prepare(`
      SELECT t.id, t.user_id, t.youtube_video_id, sk.youtube_url,
             sk.youtube_channel_id, yc.channel_id as yt_channel_id, yc.current_live_video_id
      FROM tasks t
      LEFT JOIN stream_keys sk
        ON sk.user_id = t.user_id
       AND sk.rtmp_url = t.rtmp_url
       AND sk.stream_key = t.stream_key
      LEFT JOIN yt_channels yc ON yc.id = sk.youtube_channel_id AND yc.user_id = t.user_id
      WHERE t.platform='youtube'
        AND t.status IN ('running','source_retrying','stalled','target_lost','restarting')
        AND (
          t.youtube_video_id IS NOT NULL
          OR (sk.youtube_url IS NOT NULL AND trim(sk.youtube_url) != '')
          OR sk.youtube_channel_id IS NOT NULL
        )
      ORDER BY t.started_at DESC
      LIMIT ?
    `).all(MAX_TASKS_PER_TICK);

    for (const task of tasks) {
      await checkTask(task).catch(e => console.warn(`[youtube-monitor] task ${task.id}: ${e.message}`));
    }
  } finally {
    scanning = false;
  }
}

function startMonitor() {
  setTimeout(() => scanOnce().catch(() => {}), 10 * 1000);
  setInterval(() => scanOnce().catch(() => {}), CHECK_INTERVAL_MS);
  console.log('[youtube-monitor] started, interval 1 minute');
}

module.exports = {
  startMonitor,
  classifyApiError,
  scanOnce,
  checkTask,
  checkYouTubeTarget,
  getYouTubeApiKeys,
  getUsableYouTubeApiKeys,
  getYouTubeApiKey,
  testApiKeyPool,
  keyFingerprint,
  extractYouTubeVideoId,
  extractYouTubeChannelRef,
};
