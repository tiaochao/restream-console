#!/usr/bin/env python3
"""
抖音直播状态检测脚本
用法: python3 check_douyin.py <douyin URL> [cookie_string]
输出: live | offline | unknown

检测逻辑:
  1. webcast/reflow API → status=4/5 (offline 信号可信) 立即返回 offline
  2. API live 信号完全不信任 → 进入流内容验证
  3. yt-dlp 优先获取 m3u8 地址，获取不到则取 FLV
  4. m3u8: 检查 #EXT-X-ENDLIST 标记（有=回放/已结束，无=直播中）
  5. FLV:  检查 Content-Length 响应头（有=VoD 有限文件，无=无限直播流）
"""
import sys, re, json, urllib.request, urllib.error, subprocess

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


# ── API 检测（仅用于 offline 信号）──────────────────────────────────────────

def check_room_api(web_rid, cookies):
    """返回 (is_offline: bool, room_id: str)"""
    url = (
        'https://live.douyin.com/webcast/room/web/enter/'
        f'?aid=6383&app_name=douyin_web&live_id=1&device_platform=web'
        f'&language=zh-CN&browser_language=zh-CN&browser_platform=Win32'
        f'&browser_name=Chrome&browser_version=120.0.0.0'
        f'&web_rid={web_rid}&msToken='
    )
    body  = http_get(url, cookies)
    data  = json.loads(body)
    room  = (data.get('data') or {}).get('room') or {}
    room_id = str(room.get('id', ''))
    status  = room.get('status')
    return status in (4, 5), room_id   # True=确认 offline

def check_reflow_offline(room_id):
    if not room_id:
        return False
    url  = f'https://webcast.amemv.com/douyin/webcast/reflow/{room_id}'
    body = http_get(url, referer='https://live.douyin.com/')
    m    = re.search(r'"status"\s*:\s*(\d+)', body)
    return bool(m and int(m.group(1)) in (4, 5))


# ── yt-dlp 获取流地址（优先 HLS）────────────────────────────────────────────

def get_stream_url(page_url, cookies):
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
        return lines[0] if lines else ''
    except Exception:
        return ''


# ── 流内容验证 ───────────────────────────────────────────────────────────────

def is_live_stream(url):
    """
    通过 HTTP 响应头 + 内容判断直播流 vs VoD 回放
      m3u8: #EXT-X-ENDLIST 在文件末尾 → VoD；缺失 → 直播
      FLV/其他: Content-Length 存在 → 有限文件 → VoD；不存在 → 无限直播流
    返回 True=直播中, False=非直播, None=无法判断
    """
    try:
        req  = urllib.request.Request(url, headers={'User-Agent': UA})
        resp = urllib.request.urlopen(req, timeout=10)
        ctype          = (resp.headers.get('Content-Type') or '').lower()
        content_length = resp.headers.get('Content-Length')

        # ── HLS 检测 ──
        if 'm3u8' in url or 'mpegurl' in ctype:
            manifest = resp.read(16384).decode('utf-8', errors='replace')
            if '#EXT-X-ENDLIST' in manifest:
                return False   # 结束标记 → VoD / 已结束
            if '#EXTINF' in manifest or '#EXT-X-STREAM-INF' in manifest:
                return True    # 有分片、无结束标记 → 真实直播
            return None        # manifest 内容异常

        # ── FLV / 其他格式 ──
        if content_length is not None:
            # 有 Content-Length → 有限大小的文件 → VoD 回放
            return False

        # 无 Content-Length（无限流）→ 读几 KB 确认有数据
        chunk = resp.read(32768)
        return len(chunk) > 10000

    except urllib.error.HTTPError as e:
        if e.code in (403, 404, 410):
            return False
        return None
    except Exception:
        return None


def verify_live(page_url, cookies):
    stream_url = get_stream_url(page_url, cookies)
    if not stream_url:
        return False          # 拿不到流地址 → 未开播

    result = is_live_stream(stream_url)
    if result is not None:
        return result

    return False              # 无法判断时保守返回 offline


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    url     = sys.argv[1] if len(sys.argv) > 1 else ''
    cookies = sys.argv[2] if len(sys.argv) > 2 else ''

    # ── live.douyin.com/ROOMID ───────────────────────────────────────────────
    room_m = re.search(r'live\.douyin\.com/(\d+)', url)
    if room_m:
        web_rid = room_m.group(1)
        room_id = ''

        # 1. webcast API → 仅信任 offline 信号
        try:
            is_offline, room_id = check_room_api(web_rid, cookies)
            if is_offline:
                print('offline'); return
        except Exception:
            pass

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

        # 4. 流内容验证（不信任任何 API 的 live 信号）
        try:
            print('live' if verify_live(url, cookies) else 'offline')
        except Exception:
            print('unknown')
        return

    # ── www.douyin.com/user/SECID ────────────────────────────────────────────
    sec_m = re.search(r'(?:www\.douyin\.com|v\.douyin\.com)/user/([A-Za-z0-9_\-]+)', url)
    if sec_m:
        try:
            print('live' if verify_live(url, cookies) else 'offline')
        except Exception:
            print('unknown')
        return

    print('unknown')


if __name__ == '__main__':
    main()
