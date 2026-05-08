// 直接调用各平台 API 检测开播状态（本地运行，无需 VPS）
const db = require('../db');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// ─── 全局反爬限速 ────────────────────────────────────────────────────────────
// 所有抖音 API 请求串行执行，每次请求前等待 1-4 秒随机延迟，防止并发触发验证码
let _douyinQueue = Promise.resolve();

function withDouyinRateLimit(fn) {
  const next = _douyinQueue.then(async () => {
    const delay = 1000 + Math.floor(Math.random() * 3000); // 1~4s 随机延迟
    await new Promise(r => setTimeout(r, delay));
    return fn();
  });
  _douyinQueue = next.catch(() => {}); // 失败也推进队列
  return next;
}

function getSetting(key, userId) {
  return db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(userId, key)?.value || '';
}

function getDouyinCookies(userId) {
  return getSetting('douyin_cookies', userId) || '';
}

async function doFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(options.headers || {}),
      },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, text, ok: res.ok, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Douyin ──────────────────────────────────────────────────────────────────

// 提取直播间数字 ID（用于 live.douyin.com/ROOMID 格式）
function extractDouyinRoomId(url) {
  const m = url.match(/live\.douyin\.com\/(\d+)/);
  return m ? m[1] : null;
}

// 提取 sec_user_id（用于 www.douyin.com/user/SECID 格式）
function extractDouyinSecUserId(url) {
  const m = url.match(/(?:www\.douyin\.com|v\.douyin\.com)\/user\/([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

function normalizeDouyinUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return raw;

  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    const u = new URL(withProtocol);
    const host = u.hostname.toLowerCase();

    if (host === 'live.douyin.com') {
      const roomId = u.pathname.match(/\/(\d+)/)?.[1];
      if (roomId) return `https://live.douyin.com/${roomId}`;
    }

    if (/douyin\.com$/i.test(host)) {
      const secUserId = u.pathname.match(/\/user\/([A-Za-z0-9_\-]+)/)?.[1];
      if (secUserId) return `https://www.douyin.com/user/${secUserId}`;
    }

    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (_) {
    return raw;
  }
}

async function resolveDouyinInputUrl(url, cookies = '') {
  let normalized = normalizeDouyinUrl(url);
  if (!/^https?:\/\/v\.douyin\.com\//i.test(normalized)) return normalized;

  try {
    const headers = { 'Accept': 'text/html,*/*', 'Referer': 'https://www.douyin.com/' };
    if (cookies) headers.Cookie = cookies;
    const res = await doFetch(normalized, { headers });
    const finalUrl = res.finalUrl || normalized;
    normalized = normalizeDouyinUrl(finalUrl);
  } catch (_) {}

  return normalized;
}

// ── 方式 A：直播间 HTML 解析（无需 Cookie）──────────────────────────

function parseDouyinHtmlStatus(html) {
  // 数据以转义 JSON 嵌在 JS 中：\"liveStatus\":\"normal\"
  const m = html.match(/\\"liveStatus\\":\\"([^\\]+)\\"/);
  if (m) return m[1];
  const m2 = html.match(/"liveStatus"\s*:\s*"([^"]+)"/);
  if (m2) return m2[1];
  // HTML entity 编码格式
  const m3 = html.match(/liveStatus&quot;:&quot;([^&]+)&quot;/);
  if (m3) return m3[1];
  // URL 编码格式
  const m4 = html.match(/liveStatus%22%3A%22([^%"&]+)/);
  if (m4) return decodeURIComponent(m4[1]);
  return null;
}

function parseDouyinAnchor(html) {
  // 跳过占位符 $undefined，取第一个真实主播名
  const re = /\\"nickname\\":\\"([^\\$][^\\]*?)\\"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] && m[1] !== '$undefined') return m[1];
  }
  const m2 = html.match(/nickname&quot;:&quot;([^&]+)&quot;/);
  if (m2 && m2[1] !== '$undefined') return m2[1];
  return '';
}

function parseDouyinHtmlRoomId(html) {
  const patterns = [
    /"roomId"\s*:\s*"?(\d{10,})"?/,
    /\\"roomId\\"\s*:\s*\\"?(\d{10,})/,
    /roomId&quot;:&quot;(\d{10,})&quot;/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return '';
}

async function checkDouyinRoomHtml(roomId, cookies) {
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Referer': 'https://www.douyin.com/',
  };
  if (cookies) headers['Cookie'] = cookies;

  const res = await doFetch(`https://live.douyin.com/${roomId}`, { headers });
  // 非 200（包括验证码重定向）→ 无法判断，返回 null 让 VPS curl 兜底
  if (res.status !== 200) return null;

  const liveStatus = parseDouyinHtmlStatus(res.text);
  if (liveStatus === null) {
    // 无法解析页面，返回 null 让调用方降级用 yt-dlp 兜底，而非错报"未开播"
    return null;
  }

  return {
    isLive: liveStatus === 'normal',
    anchorName: parseDouyinAnchor(res.text),
    roomId: parseDouyinHtmlRoomId(res.text) || roomId,
    liveStatus,
    source: 'html',
  };
}

// ── 方式 B：用户主页 API（需要 Cookie，支持 www.douyin.com/user/ 格式）──

async function checkDouyinBySecUserId(secUserId, cookies) {
  if (!cookies) return null; // 无 Cookie 无法调用

  const apiUrl = `https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=${secUserId}&device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC&downlink=10`;

  const res = await doFetch(apiUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.douyin.com/',
      'Cookie': cookies,
    },
  });

  if (!res.text || res.text.length < 20) return null;

  try {
    const json = JSON.parse(res.text);
    if (json.status_code !== 0) return null;

    const user = json.user;
    if (!user) return null;

    const isLive = user.live_status === 1 || user.live_status === 2;
    const anchorName = user.nickname || '';
    const roomId = user.room_id_str || String(user.room_id || '');

    return {
      isLive,
      anchorName,
      roomId,
      roomUrl: roomId ? `https://live.douyin.com/${roomId}` : '',
      source: 'user-api',
      tentative: isLive,
    };
  } catch (_) {
    return null;
  }
}

// ── 方式 C：直播间 API（有 Cookie 时额外可获得推流直链）──────────────

async function checkDouyinRoomApi(roomId, cookies) {
  if (!cookies) return null;

  const apiUrl = 'https://live.douyin.com/webcast/room/web/enter/' +
    `?aid=6383&app_name=douyin_web&live_id=1&device_platform=web` +
    `&language=zh-CN&browser_language=zh-CN&browser_platform=Win32` +
    `&browser_name=Chrome&browser_version=120.0.0.0` +
    `&web_rid=${roomId}&msToken=`;

  const res = await doFetch(apiUrl, {
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://live.douyin.com/',
      'Cookie': cookies,
    },
  });

  if (!res.text || res.text.length < 10) return null;

  try {
    const json = JSON.parse(res.text);
    const room = json?.data?.room;
    if (!room) return null;

    const isLive = room.status === 2;
    const anchorName = room.owner?.nickname || '';

    // 优先取 HLS（分段传输，更稳定）；其次 FLV（低延迟）
    let streamUrl = null;
    let streamProtocol = null;
    if (isLive && room.stream_url) {
      const hlsMap = room.stream_url.hls_pull_url_map || {};
      const flvMap = room.stream_url.flv_pull_url   || {};

      // HLS 优先取最高档：FULL_HD1(1080p高码率) → HD1 → SD1 → 任意
      const hlsUrl = hlsMap['FULL_HD1'] || hlsMap['HD1'] || hlsMap['SD1'] || Object.values(hlsMap)[0] || null;
      // FLV 备用同理
      const flvUrl = flvMap['FULL_HD1'] || flvMap['HD1'] || flvMap['SD1'] || Object.values(flvMap)[0] || null;

      if (hlsUrl) { streamUrl = hlsUrl; streamProtocol = 'hls'; }
      else if (flvUrl) { streamUrl = flvUrl; streamProtocol = 'flv'; }
    }

    return {
      isLive,
      anchorName,
      streamUrl,
      streamProtocol,
      source: 'room-api',
      tentative: isLive,
    };
  } catch (_) {
    return null;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────

async function checkDouyin(url, cookies = '') {
  url = await resolveDouyinInputUrl(url, cookies);

  // 1. live.douyin.com/ROOMID 格式
  const roomId = extractDouyinRoomId(url);
  if (roomId) {
    // HTML 只作为 offline/unknown 线索，不再用 liveStatus=normal 判定正在直播。
    try {
      const htmlResult = await checkDouyinRoomHtml(roomId, cookies);
      if (htmlResult && htmlResult.liveStatus && htmlResult.liveStatus !== 'normal') {
        return htmlResult;
      }
    } catch (_) {}

    // HTML 失败后，有 Cookie 时再试 API（只有明确返回 isLive:true 才信任；
    // 空 msToken 会导致 API 误报"未开播"，所以 isLive:false 不信任，返回 null 走 VPS curl）
    if (cookies) {
      try {
        const r = await checkDouyinRoomApi(roomId, cookies);
        if (r && r.isLive && r.streamUrl) return r;
        if (r && r.isLive === false && r.source === 'room-api') return null;
      } catch (_) {}
    }

    // 不在本地 API 中确认直播，返回 null 让调用方走真实流验证。
    return null;
  }

  // 2. www.douyin.com/user/SECID 格式（需要 Cookie）
  const secUserId = extractDouyinSecUserId(url);
  if (secUserId) {
    if (cookies) {
      try {
        const r = await checkDouyinBySecUserId(secUserId, cookies);
        if (r && r.isLive && r.roomId) return r;
      } catch (_) {}
    }
    return null;
  }

  return null;
}

async function getDouyinChannelInfo(url, cookies = '') {
  const normalized = await resolveDouyinInputUrl(url, cookies);
  const roomId = extractDouyinRoomId(normalized);
  if (roomId) {
    try {
      const htmlResult = await checkDouyinRoomHtml(roomId, cookies);
      if (htmlResult) {
        return {
          name: htmlResult.anchorName || `抖音直播间 ${roomId}`,
          url: normalized,
          roomId: htmlResult.roomId || roomId,
          source: 'html',
        };
      }
    } catch (_) {}
    return { name: `抖音直播间 ${roomId}`, url: normalized, roomId, source: 'url' };
  }

  const secUserId = extractDouyinSecUserId(normalized);
  if (secUserId) {
    if (cookies) {
      try {
        const r = await checkDouyinBySecUserId(secUserId, cookies);
        if (r) {
          return {
            name: r.anchorName || `抖音账号 ${secUserId.slice(-8)}`,
            url: normalized,
            roomId: r.roomId || '',
            source: 'user-api',
          };
        }
      } catch (_) {}
    }
    return { name: `抖音账号 ${secUserId.slice(-8)}`, url: normalized, roomId: '', source: 'url' };
  }

  return null;
}

// ─── Bilibili ────────────────────────────────────────────────────────────────

function extractBilibiliRoomId(url) {
  const m = url.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/);
  return m ? m[1] : null;
}

async function checkBilibili(url) {
  const roomId = extractBilibiliRoomId(url);
  if (!roomId) return null;

  try {
    const res = await doFetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`,
      { headers: { 'Accept': 'application/json', 'Referer': 'https://live.bilibili.com/' } }
    );
    const json = JSON.parse(res.text);
    if (json.code !== 0) return null;
    const data = json.data || {};
    return {
      isLive: data.live_status === 1,
      anchorName: data.uname || '',
      title: data.title || '',
      source: 'bilibili-api',
    };
  } catch (e) {
    return null;
  }
}

// ─── Kuaishou ────────────────────────────────────────────────────────────────

function extractKuaishouId(url) {
  const m = url.match(/(?:live\.kuaishou\.com\/u\/|kuaishou\.com\/short-video\/)([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

async function checkKuaishou(url) {
  const userId = extractKuaishouId(url);
  if (!userId) return null;

  // 先试 livedetail API（可能需要 cookie，无 cookie 时返回 403/401）
  try {
    const apiRes = await doFetch(
      `https://live.kuaishou.com/live_api/liveroom/livedetail?principalId=${userId}`,
      { headers: { 'Accept': 'application/json, */*', 'Referer': url } }
    );
    if (apiRes.ok && apiRes.text.length > 20) {
      const json = JSON.parse(apiRes.text);
      const result = json.result || json.data;
      if (result) {
        const isLive = result.liveStatus === 1 || result.living === true;
        return { isLive, anchorName: result.userName || result.name || '', source: 'kuaishou-api' };
      }
    }
  } catch (_) {}

  // 兜底：HTML 关键词检测（快手页面内嵌 JSON）
  try {
    const htmlRes = await doFetch(url, {
      headers: { 'Accept': 'text/html,*/*', 'Referer': 'https://live.kuaishou.com/' },
    });
    const html = htmlRes.text;
    // 快手直播中时页面有这些特征
    const isLive =
      /"isLiving"\s*:\s*true/.test(html) ||
      /"liveStatus"\s*:\s*1/.test(html) ||
      /"status"\s*:\s*"LIVING"/.test(html) ||
      /class="[^"]*living[^"]*"/.test(html);
    if (isLive || /"isLiving"\s*:\s*false/.test(html) || /"liveStatus"\s*:\s*0/.test(html)) {
      return { isLive, source: 'kuaishou-html' };
    }
  } catch (_) {}

  // 无法确定 → 返回 null，交给 yt-dlp 兜底
  return null;
}

// ─── YouTube ─────────────────────────────────────────────────────────────────

async function checkYouTube(url) {
  try {
    const res = await doFetch(url, {
      headers: { 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.5' },
    });
    const isLive = res.text.includes('"isLive":true');
    return { isLive, source: 'youtube-html' };
  } catch (e) {
    return { isLive: false, error: `YouTube 检测失败: ${e.message}` };
  }
}

// ─── 通用入口 ─────────────────────────────────────────────────────────────────

// 返回检测结果 { isLive, anchorName?, source, ... }
// 返回 null 表示不支持或无法本地检测，由调用方用 VPS yt-dlp 兜底
async function checkChannel(channel) {
  const url = (channel.url || '');
  const cookies = getDouyinCookies(channel.user_id);

  if (/douyin\.com|douyincdn\.com/i.test(url)) {
    return withDouyinRateLimit(() => checkDouyin(url, cookies));
  }
  if (/youtube\.com|youtu\.be/i.test(url)) {
    return checkYouTube(url);
  }
  if (/live\.bilibili\.com/i.test(url)) {
    return checkBilibili(url);
  }
  if (/live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(url)) {
    return checkKuaishou(url);
  }
  return null;
}

// ─── 获取可直接推流的 URL（供 FFmpeg -i 使用）────────────────────────────────

async function resolveDouyinStreamUrl(url, cookies) {
  // 通过限速队列执行，避免频繁请求触发抖音验证码
  return withDouyinRateLimit(() => _resolveDouyinStreamUrl(url, cookies));
}

async function _resolveDouyinStreamUrl(url, cookies) {
  // live.douyin.com/ROOM_ID
  const roomId = extractDouyinRoomId(url);
  if (roomId) {
    if (cookies) {
      try {
        const r = await checkDouyinRoomApi(roomId, cookies);
        if (r && r.streamUrl) return { url: r.streamUrl, protocol: r.streamProtocol || 'hls' };
      } catch (_) {}
    }
    // 无 Cookie：尝试从 HTML 提取 FLV URL
    try {
      const res = await doFetch(`https://live.douyin.com/${roomId}`, {
        headers: { 'Accept': 'text/html,*/*', 'Referer': 'https://www.douyin.com/' },
      });
      const flv = res.text.match(/\\"flv_pull_url\\":\{[^}]*?\\"([^"]+\.flv[^"]*?)\\"/);
      if (flv) return { url: flv[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/'), protocol: 'flv' };
    } catch (_) {}
    return null;
  }

  // www.douyin.com/user/SEC_USER_ID
  const secUserId = extractDouyinSecUserId(url);
  if (secUserId && cookies) {
    try {
      const userResult = await checkDouyinBySecUserId(secUserId, cookies);
      if (userResult && userResult.isLive && userResult.roomId) {
        const r = await checkDouyinRoomApi(userResult.roomId, cookies);
        if (r && r.streamUrl) return { url: r.streamUrl, protocol: r.streamProtocol || 'hls' };
      }
    } catch (_) {}
  }

  return null;
}

module.exports = { checkChannel, checkDouyin, checkYouTube, checkBilibili, checkKuaishou, resolveDouyinStreamUrl, getDouyinChannelInfo };
