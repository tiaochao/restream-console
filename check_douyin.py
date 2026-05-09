#!/usr/bin/env python3
"""
抖音直播状态检测脚本
用法:
  python3 check_douyin.py <douyin URL> [cookie_string]
  python3 check_douyin.py --stream-url <douyin URL> [cookie_string]
输出: live | offline | unknown

检测逻辑（分级降级）:
  1. webcast/reflow API → status=4/5 确认 offline，立即返回
  2. yt-dlp 获取流地址 → m3u8 检查 ENDLIST / FLV 检查 Content-Length
  3. yt-dlp 失败 → 用 API 返回的流地址做同样的内容验证
  4. 全部流验证失败 → 信任 API status==2 作为最后手段返回 live
  5. 完全无法判断 → unknown
"""
import sys, re, json, time, urllib.request, urllib.error, urllib.parse, subprocess

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/120.0.0.0 Safari/537.36'
)

def http_get(url, cookies='', referer='https://live.douyin.com/', timeout=15):
    headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': referer,
    }
    if cookies:
        headers['Cookie'] = cookies
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')

def normalize_url(url, cookies=''):
    url = (url or '').strip()
    if not url:
        return ''
    if not re.match(r'https?://', url, re.I):
        url = 'https://' + url.lstrip('/')

    # Follow Douyin short links so shared URLs resolve to a room or profile URL.
    if re.search(r'://v\.douyin\.com/', url, re.I):
        headers = {'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9'}
        if cookies:
            headers['Cookie'] = cookies
        for method in ('HEAD', 'GET'):
            try:
                req = urllib.request.Request(url, headers=headers, method=method)
                with urllib.request.urlopen(req, timeout=10) as resp:
                    url = resp.geturl()
                    break
            except Exception:
                pass

    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path or '/'

    if host == 'live.douyin.com':
        room_m = re.search(r'/(\d+)', path)
        if room_m:
            return f'https://live.douyin.com/{room_m.group(1)}'

    if host.endswith('douyin.com'):
        user_m = re.search(r'/user/([A-Za-z0-9_\-]+)', path)
        if user_m:
            return f'https://www.douyin.com/user/{user_m.group(1)}'

    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, '', '', ''))


# ── API 检测（仅用于 offline 信号）──────────────────────────────────────────

def fetch_room_api(web_rid, cookies):
    url = (
        'https://live.douyin.com/webcast/room/web/enter/'
        f'?aid=6383&app_name=douyin_web&live_id=1&device_platform=web'
        f'&language=zh-CN&browser_language=zh-CN&browser_platform=Win32'
        f'&browser_name=Chrome&browser_version=120.0.0.0'
        f'&web_rid={web_rid}&msToken='
    )
    body  = http_get(url, cookies)
    return json.loads(body)

def check_room_api(web_rid, cookies):
    """返回 (is_offline: bool, room_id: str)"""
    data  = fetch_room_api(web_rid, cookies)
    room  = (data.get('data') or {}).get('room') or {}
    room_id = str(room.get('id', ''))
    status  = room.get('status')

    stream_urls = []
    stream_info = room.get('stream_url') or {}
    hls_map = stream_info.get('hls_pull_url_map') or {}
    flv_map = stream_info.get('flv_pull_url') or {}
    for q in ('FULL_HD1', 'HD1', 'SD1'):
        if q in hls_map:
            stream_urls.append((hls_map[q], 'hls')); break
    else:
        v = list(hls_map.values())
        if v: stream_urls.append((v[0], 'hls'))
    for q in ('FULL_HD1', 'HD1', 'SD1'):
        if q in flv_map:
            stream_urls.append((flv_map[q], 'flv')); break
    else:
        v = list(flv_map.values())
        if v: stream_urls.append((v[0], 'flv'))

    return {
        'is_offline': status in (4, 5),
        'room_id': room_id,
        'status': status,
        'stream_urls': stream_urls,
    }

def pick_stream_url(stream_url):
    if not isinstance(stream_url, dict):
        return ''

    hls_map = stream_url.get('hls_pull_url_map') or {}
    flv_map = stream_url.get('flv_pull_url') or {}
    flv_full = stream_url.get('flv_pull_url_full') or {}

    for source in (hls_map, flv_map, flv_full):
        if not isinstance(source, dict):
            continue
        for key in ('FULL_HD1', 'HD1', 'SD1', 'SD2', 'ORIGIN'):
            url = source.get(key)
            if isinstance(url, str) and url.startswith('http'):
                return url
        for url in source.values():
            if isinstance(url, str) and url.startswith('http'):
                return url
    return ''

def resolve_room_api_stream(web_rid, cookies):
    if not cookies:
        return '', '', 'no_cookie'
    data = fetch_room_api(web_rid, cookies)
    room = (data.get('data') or {}).get('room') or {}
    room_id = str(room.get('id', ''))
    status = room.get('status')
    if status in (4, 5):
        return '', room_id, 'offline'
    stream_url = pick_stream_url(room.get('stream_url') or {})
    return stream_url, room_id, 'room-api' if stream_url else 'room-api-no-stream'

def check_reflow_offline(room_id):
    if not room_id:
        return False
    url  = f'https://webcast.amemv.com/douyin/webcast/reflow/{room_id}'
    body = http_get(url, referer='https://live.douyin.com/')
    m    = re.search(r'"status"\s*:\s*(\d+)', body)
    return bool(m and int(m.group(1)) in (4, 5))

def check_user_profile(sec_user_id, cookies):
    """返回 (is_live: bool|None, room_id: str)。没有 Cookie 时无法可靠调用。"""
    if not cookies:
        return None, ''
    api_url = (
        'https://www.douyin.com/aweme/v1/web/user/profile/other/'
        f'?sec_user_id={urllib.parse.quote(sec_user_id)}'
        '&device_platform=webapp&aid=6383&channel=channel_pc_web'
        '&version_code=170400&version_name=17.4.0&cookie_enabled=true'
        '&platform=PC&downlink=10'
    )
    body = http_get(api_url, cookies, referer='https://www.douyin.com/')
    data = json.loads(body)
    if data.get('status_code') != 0:
        return None, ''
    user = data.get('user') or {}
    live_status = user.get('live_status')
    room_id = str(user.get('room_id_str') or user.get('room_id') or '')
    if live_status in (1, 2):
        return True, room_id
    if live_status in (0, 3, 4):
        return False, room_id
    return None, room_id


# ── 直播直链解析 ─────────────────────────────────────────────────────────────

def clean_stream_url(url):
    url = (url or '').strip().strip('"\'')
    url = url.replace('\\u0026', '&').replace('\\/', '/').replace('\\\\/', '/')
    try:
        url = bytes(url, 'utf-8').decode('unicode_escape')
    except Exception:
        pass
    return urllib.parse.unquote(url)

def extract_stream_from_html(html):
    if not html:
        return ''
    patterns = [
        r'https?:\\?/\\?/[^"\'<>\s]+?\.m3u8[^"\'<>\s]*',
        r'https?:\\?/\\?/[^"\'<>\s]+?\.flv[^"\'<>\s]*',
        r'https?://[^"\'<>\s]+?\.m3u8[^"\'<>\s]*',
        r'https?://[^"\'<>\s]+?\.flv[^"\'<>\s]*',
    ]
    for pattern in patterns:
        for raw in re.findall(pattern, html):
            url = clean_stream_url(raw)
            if url.startswith('http') and ('.m3u8' in url or '.flv' in url):
                return url
    return ''

def get_stream_url_by_streamlink(page_url, cookies):
    base = [
        'streamlink',
        '--stream-url',
        '--http-header', f'User-Agent={UA}',
        '--http-header', 'Referer=https://live.douyin.com/',
    ]
    if cookies:
        base += ['--http-header', f'Cookie={cookies}']
    try:
        r = subprocess.run(base + [page_url, 'best'],
                           capture_output=True, text=True, timeout=35)
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith('http')]
        return lines[0] if lines else ''
    except Exception:
        return ''

# ── yt-dlp 获取流地址（优先 HLS）────────────────────────────────────────────

def get_stream_url(page_url, cookies):
    page_url = normalize_url(page_url, cookies)

    room_m = re.search(r'live\.douyin\.com/(\d+)', page_url)
    if room_m:
        web_rid = room_m.group(1)
        try:
            stream_url, room_id, _ = resolve_room_api_stream(web_rid, cookies)
            if stream_url:
                return stream_url
        except Exception:
            room_id = ''

        try:
            html = http_get(f'https://live.douyin.com/{web_rid}', cookies)
            stream_url = extract_stream_from_html(html)
            if stream_url:
                return stream_url
        except Exception:
            pass

    sec_m = re.search(r'(?:www\.douyin\.com|v\.douyin\.com)/user/([A-Za-z0-9_\-]+)', page_url)
    if sec_m and cookies:
      try:
          profile_live, room_id = check_user_profile(sec_m.group(1), cookies)
          if profile_live is True and room_id:
              stream_url, _, _ = resolve_room_api_stream(room_id, cookies)
              if stream_url:
                  return stream_url
      except Exception:
          pass

    base = ['yt-dlp', '--no-warnings', '--socket-timeout', '15', '-g']
    if cookies:
        base += ['--add-header', f'Cookie:{cookies}']

    # 优先 HLS（m3u8 有 EXT-X-ENDLIST 标记，最好判断）
    try:
        r = subprocess.run(base + ['--format', 'hls*', page_url],
                           capture_output=True, text=True, timeout=35)
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith('http')]
        if lines:
            return lines[0]
    except Exception:
        pass

    # 降级：任意格式
    try:
        r = subprocess.run(base + [page_url],
                           capture_output=True, text=True, timeout=35)
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith('http')]
        if lines:
            return lines[0]
    except Exception:
        pass

    return get_stream_url_by_streamlink(page_url, cookies)


# ── 流内容验证 ───────────────────────────────────────────────────────────────

def first_hls_variant(manifest, base_url):
    lines = [line.strip() for line in manifest.splitlines()]
    for idx, line in enumerate(lines):
        if line.startswith('#EXT-X-STREAM-INF'):
            for candidate in lines[idx + 1:]:
                if not candidate or candidate.startswith('#'):
                    continue
                return urllib.parse.urljoin(base_url, candidate)
    return ''

def is_live_stream(url):
    """
    通过 HTTP 响应头 + 内容判断直播流 vs VoD 回放
      m3u8: 追踪 master playlist 到媒体 playlist 后判断：
            #EXT-X-ENDLIST / VOD → 非直播；有分片且无结束标记 → 直播
      FLV/其他: Transfer-Encoding:chunked 无 Content-Length → 直播；
               Content-Length 存在 → VoD；两者都无 → 持续读 2s 验证
    返回 True=直播中, False=非直播, None=无法判断
    """
    try:
        req  = urllib.request.Request(url, headers={'User-Agent': UA})
        resp = urllib.request.urlopen(req, timeout=10)
        ctype          = (resp.headers.get('Content-Type') or '').lower()
        content_length = resp.headers.get('Content-Length')

        # ── HLS 检测 ──
        if 'm3u8' in url or 'mpegurl' in ctype:
            manifest = resp.read(1024 * 1024).decode('utf-8', errors='replace')

            # Master playlist 自身没有 ENDLIST，不能作为直播证据；继续检查媒体 playlist。
            if '#EXT-X-STREAM-INF' in manifest and '#EXTINF' not in manifest:
                variant_url = first_hls_variant(manifest, url)
                return is_live_stream(variant_url) if variant_url else None

            if '#EXT-X-ENDLIST' in manifest or '#EXT-X-PLAYLIST-TYPE:VOD' in manifest:
                return False   # 结束标记 → VoD / 已结束
            if '#EXTINF' in manifest:
                return True    # 媒体分片存在、无结束标记 → 真实直播
            return None        # manifest 内容异常

        # ── FLV / 其他格式 ──
        # Transfer-Encoding: chunked 且无 Content-Length → 确定是无限流 → 直播
        transfer_enc = (resp.headers.get('Transfer-Encoding') or '').lower()
        if 'chunked' in transfer_enc and content_length is None:
            chunk = resp.read(8192)
            return len(chunk) > 100

        # Content-Length 存在 → 有限文件 → VoD 回放
        if content_length is not None:
            return False

        # 两个头部都不存在：持续读取验证 —— 直播流会持续产出数据，VoD 连接在传完后关闭
        chunk1 = resp.read(8192)
        if len(chunk1) < 100:
            return False
        time.sleep(2)
        try:
            chunk2 = resp.read(1)
            return True   # 2 秒后仍有数据 → 直播进行中
        except Exception:
            return False  # 连接已关闭 → VoD 已传完

    except urllib.error.HTTPError as e:
        if e.code in (403, 404, 410):
            return False
        return None
    except Exception:
        return None


def verify_live(page_url, cookies):
    """返回 True=确认直播中, False=确认未直播, None=无法判断"""
    stream_url = get_stream_url(page_url, cookies)
    if not stream_url:
        return None

    return is_live_stream(stream_url)


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    stream_mode = len(sys.argv) > 1 and sys.argv[1] == '--stream-url'
    arg_offset = 1 if stream_mode else 0
    cookies = sys.argv[2 + arg_offset] if len(sys.argv) > 2 + arg_offset else ''
    url     = normalize_url(sys.argv[1 + arg_offset] if len(sys.argv) > 1 + arg_offset else '', cookies)

    if stream_mode:
        try:
            stream_url = get_stream_url(url, cookies)
            if stream_url:
                print(stream_url)
                return
            print('')
        except Exception:
            print('')
        return

    # ── live.douyin.com/ROOMID ───────────────────────────────────────────────
    room_m = re.search(r'live\.douyin\.com/(\d+)', url)
    if room_m:
        web_rid = room_m.group(1)
        api_info = {'room_id': '', 'status': None, 'stream_urls': []}

        # 1. webcast API → 仅信任 offline 信号，保存完整返回数据
        try:
            api_info = check_room_api(web_rid, cookies)
            if api_info['is_offline']:
                print('offline'); return
        except Exception:
            pass

        room_id = api_info.get('room_id', '')

        # 2. 从 HTML 补充 room_id（API 未返回时）
        if not room_id:
            try:
                html = http_get(f'https://live.douyin.com/{web_rid}', cookies)
                rm   = re.search(r'"roomId"\s*:\s*"?(\d{15,})"?', html)
                if rm:
                    room_id = rm.group(1)
            except Exception:
                pass

        # 3. reflow API → 仅信任 offline 信号
        if room_id:
            try:
                if check_reflow_offline(room_id):
                    print('offline'); return
            except Exception:
                pass

        # 4. yt-dlp 流内容验证
        try:
            live_result = verify_live(url, cookies)
        except Exception:
            live_result = None

        if live_result is True:
            print('live'); return
        if live_result is False:
            print('offline'); return

        # 5. yt-dlp 无法判断 → 尝试 API 返回的流地址验证
        for stream_url, _ in api_info.get('stream_urls', []):
            try:
                result = is_live_stream(stream_url)
                if result is True:
                    print('live'); return
                if result is False:
                    print('offline'); return
            except Exception:
                continue

        # 6. 全部验证手段耗尽 → 信任 API 状态作为最后手段
        if api_info.get('status') == 2:
            print('live'); return

        print('unknown')
        return

    # ── www.douyin.com/user/SECID ────────────────────────────────────────────
    sec_m = re.search(r'(?:www\.douyin\.com|v\.douyin\.com)/user/([A-Za-z0-9_\-]+)', url)
    if sec_m:
        sec_user_id = sec_m.group(1)
        try:
            profile_live, room_id = check_user_profile(sec_user_id, cookies)
            if profile_live is False:
                print('offline'); return
            if profile_live is True and room_id:
                room_url = f'https://live.douyin.com/{room_id}'
                print('live' if verify_live(room_url, cookies) else 'offline')
                return
        except Exception:
            pass
        try:
            live_result = verify_live(url, cookies)
            if live_result is True:
                print('live')
            elif live_result is False:
                print('offline')
            else:
                print('unknown')
        except Exception:
            print('unknown')
        return

    print('unknown')


if __name__ == '__main__':
    main()
