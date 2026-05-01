#!/usr/bin/env python3
"""
抖音直播状态检测脚本
用法: python3 check_douyin.py <douyin URL> [cookie_string]
输出: live | offline | unknown

检测逻辑（离线信号优先）:
  任一可靠来源说 offline → 立即返回 offline
  需要 webcast API 或 reflow 至少一个确认 live 才返回 live
  两者均 unknown → HTML 兜底（CDN 缓存，仅参考）

支持格式:
  live.douyin.com/ROOMID
  www.douyin.com/user/SECID
"""
import sys, re, json, urllib.request

UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/120.0.0.0 Safari/537.36'
)

def http_get(url, cookies='', referer='https://live.douyin.com/'):
    headers = {
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': referer,
    }
    if cookies:
        headers['Cookie'] = cookies
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode('utf-8', errors='replace')


# ── 方式 1：webcast room API ─────────────────────────────────────────────────
def check_room_api(web_rid, cookies):
    """返回 (is_live: bool|None, room_id: str)
    status 2 = 直播中, 4/5 = 已结束/封禁, 0 = 无数据(msToken缺失)
    """
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
    status  = room.get('status')

    if status == 2:          return True,  room_id
    if status in (4, 5):     return False, room_id
    return None, room_id


# ── 方式 2：webcast.amemv.com reflow（无需 Cookie，更新更快）────────────────
def check_reflow(room_id):
    """返回 bool|None。reflow 端点通常比 webcast API 更早反映直播结束。"""
    if not room_id:
        return None
    url = f'https://webcast.amemv.com/douyin/webcast/reflow/{room_id}'
    body = http_get(url, referer='https://live.douyin.com/')
    m = re.search(r'"status"\s*:\s*(\d+)', body)
    if m:
        s = int(m.group(1))
        if s == 2:           return True
        if s in (4, 5):      return False
    return None


# ── 方式 3：用户主页 API（www.douyin.com/user/SECID 格式）────────────────────
def check_user_api(sec_user_id, cookies):
    if not cookies:
        return None
    url = (
        f'https://www.douyin.com/aweme/v1/web/user/profile/other/'
        f'?sec_user_id={sec_user_id}&device_platform=webapp&aid=6383'
        f'&channel=channel_pc_web&version_code=170400&version_name=17.4.0'
        f'&cookie_enabled=true&platform=PC&downlink=10'
    )
    body = http_get(url, cookies, referer='https://www.douyin.com/')
    data = json.loads(body)
    if data.get('status_code') != 0:
        return None
    live_status = (data.get('user') or {}).get('live_status')
    if live_status in (1, 2): return True
    if live_status == 0:      return False
    return None


# ── 方式 4：HTML 解析（CDN 缓存，仅兜底）────────────────────────────────────
def check_html(web_rid, cookies, prefetched_body=None):
    body = prefetched_body or http_get(f'https://live.douyin.com/{web_rid}', cookies)
    patterns = [
        r'\\"liveStatus\\":\\"([^\\"]+)\\"',
        r'"liveStatus"\s*:\s*"([^"]+)"',
        r'liveStatus&quot;:&quot;([^&]+)&quot;',
    ]
    live_vals = {'normal', 'LIVE', 'live', 'Living', 'NORMAL'}
    for p in patterns:
        m = re.search(p, body)
        if m:
            return m.group(1) in live_vals
    m = re.search(r'"status"\s*:\s*(\d+)', body)
    if m:
        return int(m.group(1)) == 2
    return None


# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    url     = sys.argv[1] if len(sys.argv) > 1 else ''
    cookies = sys.argv[2] if len(sys.argv) > 2 else ''

    # ── live.douyin.com/ROOMID 格式 ──────────────────────────────────────────
    room_m = re.search(r'live\.douyin\.com/(\d+)', url)
    if room_m:
        web_rid  = room_m.group(1)
        room_id  = ''
        api_live = None

        # 1. webcast API
        try:
            api_live, room_id = check_room_api(web_rid, cookies)
            if api_live == False:
                print('offline'); return      # 离线信号立刻相信
        except Exception:
            pass

        # 2. 若无 room_id，从 HTML 提取（顺便缓存 body 供方式4复用）
        html_body = None
        if not room_id:
            try:
                html_body = http_get(f'https://live.douyin.com/{web_rid}', cookies)
                rm = re.search(r'"roomId"\s*:\s*"?(\d{15,})"?', html_body)
                if rm:
                    room_id = rm.group(1)
            except Exception:
                pass

        # 3. reflow 交叉验证（比 webcast API 更新更快，无需 Cookie）
        if room_id:
            try:
                reflow_live = check_reflow(room_id)
                if reflow_live == False:
                    print('offline'); return  # 离线信号优先
                if reflow_live == True and api_live != False:
                    print('live'); return     # reflow 确认直播中
            except Exception:
                pass

        # 4. webcast API 确认直播中（reflow 未确认，但 API 说是）
        if api_live == True:
            print('live'); return

        # 5. HTML 兜底（CDN 缓存，仅当前两步均 unknown 时使用）
        try:
            result = check_html(web_rid, cookies, html_body)
            if result is not None:
                print('live' if result else 'offline'); return
        except Exception:
            pass

        print('unknown')
        return

    # ── www.douyin.com/user/SECID 格式 ───────────────────────────────────────
    sec_m = re.search(r'(?:www\.douyin\.com|v\.douyin\.com)/user/([A-Za-z0-9_\-]+)', url)
    if sec_m:
        sec_user_id = sec_m.group(1)
        try:
            result = check_user_api(sec_user_id, cookies)
            if result is not None:
                print('live' if result else 'offline'); return
        except Exception:
            pass
        print('unknown')
        return

    print('unknown')


if __name__ == '__main__':
    main()
