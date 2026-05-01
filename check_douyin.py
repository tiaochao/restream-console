#!/usr/bin/env python3
"""
抖音直播状态检测脚本
用法: python3 check_douyin.py <douyin URL> [cookie_string]
输出: live | offline | unknown

检测逻辑:
  1. webcast/reflow API → offline 信号 (status=4/5) 立即返回 offline
  2. API live 信号不可信（CDN 缓存），进入流内容验证
  3. yt-dlp 获取流地址 → 拿不到则 offline
  4. m3u8 检查 #EXT-X-ENDLIST 标记：
       有标记 → offline（回放或已结束）
       无标记 + 有分片 → live（真实直播中）
  5. FLV 流 → 读取前 64KB 确认有数据
"""
import sys, re, json, urllib.request, subprocess

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


# ── 方式 1：webcast room API（仅信任 offline 信号）────────────────────────────
def check_room_api(web_rid, cookies):
    """返回 (is_offline: bool|None, room_id: str)"""
    url = (
        'https://live.douyin.com/webcast/room/web/enter/'
        f'?aid=6383&app_name=douyin_web&live_id=1&device_platform=web'
        f'&language=zh-CN&browser_language=zh-CN&browser_platform=Win32'
        f'&browser_name=Chrome&browser_version=120.0.0.0'
        f'&web_rid={web_rid}&msToken='
    )
    body = http_get(url, cookies)
    data = json.loads(body)
    room = (data.get('data') or {}).get('room') or {}
    room_id = str(room.get('id', ''))
    status = room.get('status')
    if status in (4, 5):  return True, room_id   # 确认结束
    return False, room_id                          # 其他状态不可信


# ── 方式 2：reflow API（仅信任 offline 信号）────────────────────────────────
def check_reflow_offline(room_id):
    """返回 True 表示确认 offline，False 表示不确定"""
    if not room_id:
        return False
    url = f'https://webcast.amemv.com/douyin/webcast/reflow/{room_id}'
    body = http_get(url, referer='https://live.douyin.com/')
    m = re.search(r'"status"\s*:\s*(\d+)', body)
    if m and int(m.group(1)) in (4, 5):
        return True
    return False


# ── 方式 3：yt-dlp 获取流地址 ────────────────────────────────────────────────
def get_stream_url(page_url, cookies):
    cmd = ['yt-dlp', '--no-warnings', '--socket-timeout', '15', '-g', page_url]
    if cookies:
        cmd += ['--add-header', f'Cookie:{cookies}']
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
        lines = [l.strip() for l in r.stdout.strip().splitlines()
                 if l.strip().startswith('http')]
        return lines[0] if lines else ''
    except Exception:
        return ''


# ── 方式 4a：m3u8 manifest 检查（最可靠）────────────────────────────────────
def check_m3u8(url):
    """
    返回 True=直播中, False=已结束/回放, None=无法判断
    直播流 m3u8 永远没有 #EXT-X-ENDLIST
    VOD/回放 m3u8 在文件末尾有 #EXT-X-ENDLIST
    """
    try:
        manifest = http_get(url, timeout=10)
        if '#EXT-X-ENDLIST' in manifest:
            return False  # 有结束标记 → VOD 或已结束的直播
        if '#EXTINF' in manifest or '#EXT-X-STREAM-INF' in manifest:
            return True   # 有分片且无结束标记 → 真实直播
        return None
    except Exception:
        return None


# ── 方式 4b：FLV 字节验证 ─────────────────────────────────────────────────
def check_bytes(url):
    """读取前 64KB，确认流有持续数据输出"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=8) as resp:
            chunk = resp.read(65536)
            return len(chunk) > 10000
    except Exception:
        return False


# ── 终极验证：流地址 + 内容检查 ───────────────────────────────────────────
def verify_live(page_url, cookies):
    stream_url = get_stream_url(page_url, cookies)
    if not stream_url:
        return False  # 拿不到流地址 → 未开播

    if 'm3u8' in stream_url:
        result = check_m3u8(stream_url)
        if result is not None:
            return result
        # m3u8 检查失败，降级到字节验证

    return check_bytes(stream_url)


# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    url     = sys.argv[1] if len(sys.argv) > 1 else ''
    cookies = sys.argv[2] if len(sys.argv) > 2 else ''

    # ── live.douyin.com/ROOMID 格式 ──────────────────────────────────────────
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

        # 2. 从 HTML 提取 room_id（若 API 未返回）
        if not room_id:
            try:
                html = http_get(f'https://live.douyin.com/{web_rid}', cookies)
                rm = re.search(r'"roomId"\s*:\s*"?(\d{15,})"?', html)
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

    # ── www.douyin.com/user/SECID 格式 ───────────────────────────────────────
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
