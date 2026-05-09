# External Integrations

## YouTube Data API v3

**基础 URL**：`https://www.googleapis.com/youtube/v3`

### 使用场景

1. **任务直播状态监控**（`services/youtube-monitor.js`）
   - 每 60 秒扫描所有 `platform='youtube'` 且状态为 `running/stalled/source_retrying/target_lost/restarting` 的任务
   - 检测推流目标的直播状态、观看人数、视频标题

2. **YouTube 频道信息同步**（`services/youtube-channel-sync.js`）
   - 同步频道元数据（订阅数、视频数、播放列表 ID 等）
   - 获取频道最新 50 个视频并写入 `yt_videos` 表
   - 检测频道当前正在进行的直播，更新 `yt_channels.current_live_video_id`

### 调用的 API 端点

| 端点 | 参数 | 用途 |
|---|---|---|
| `GET /videos` | `part=snippet,liveStreamingDetails,statistics&id={videoId}` | 获取视频/直播详情、观看人数 |
| `GET /search` | `part=id,snippet&channelId={id}&eventType=live&type=video` | 查找频道当前直播视频 |
| `GET /search` | `part=snippet&q=@{handle}&type=channel` | 通过 handle 解析频道 ID |
| `GET /channels` | `part=snippet,contentDetails,statistics&id={channelId}` | 获取频道元数据 |
| `GET /channels` | `part=id&forHandle={handle}` | 通过 @handle 查找频道 |
| `GET /channels` | `part=id&forUsername={username}` | 通过 legacy username 查找频道 |
| `GET /playlistItems` | `part=snippet&playlistId={uploadsId}&maxResults=50` | 获取上传列表最新视频 ID |

### API Key 管理（多 Key 轮询池）

- 支持配置多个 API Key（`youtube_api_keys` 设置，换行/逗号分隔）
- 同时兼容环境变量 `YOUTUBE_API_KEYS` / `YOUTUBE_API_KEY`
- 轮询游标存储在 `settings.youtube_api_key_cursor`
- Key 状态（可用/暂停）持久化存储在 `settings.youtube_api_key_status`（JSON 格式）
- 错误分类与暂停策略：
  - `quota`（配额耗尽）：暂停 26 小时
  - `rate_limited`（速率限制）：暂停 6 小时
  - `invalid` / `forbidden`（Key 无效/禁止）：暂停 1 年（实际永久停用）
- Key Fingerprint 用 SHA-256 前 16 位标识，显示时脱敏（前 4 + 后 4 位）

### 配额节约策略

- `MAX_TASKS_PER_TICK = 12`：每次扫描最多检测 12 个任务
- 检测到配额或 Key 错误时自动切换下一个 Key 重试
- 使用固定测试视频 `dQw4w9WgXcQ` 做 Key 可用性验证（最小配额消耗）

---

## FFmpeg

FFmpeg **不在本地运行**，通过 SSH 在远端 VPS 上启动，脚本以 `nohup ... &` 方式后台运行，进程 PID 记录到数据库供后续管理。

### 核心调用方式

```bash
nohup bash -c "$(echo '<base64_script>' | base64 -d)" > /tmp/restream_<taskId>.log 2>&1 & echo $!
```

生成的 Shell 脚本（以 Base64 编码传输）包含完整的推流逻辑循环。

### 关键 FFmpeg 参数

**推流输出参数（`ffmpegOutputArgs`）**：
```
-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy
-avoid_negative_ts make_zero -flvflags no_duration_filesize
```
- `-c:v copy -c:a copy`：无转码直通（降低 CPU 消耗）
- `-f flv`：输出格式为 FLV（RTMP 推流必需）

**HTTP 输入参数（`ffmpegHttpInputArgs`）**：
```
-fflags +genpts -reconnect 1 -reconnect_streamed 1
-reconnect_delay_max 3 -rw_timeout 12000000
```
- 断线自动重连，最大重连延迟 3 秒
- 参数需兼容 Ubuntu 20.04 默认 FFmpeg 4.2.x；不要使用 `-reconnect_attempts` 这类旧版 FFmpeg 不支持的参数

**录播参数（`ffmpegRecordArgs`）**：
```
-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy -f mpegts
```
- 录制为 `.ts` 格式（MPEG-TS 容器）
- 单场最大录制时长 3600 秒（`_AUTO_REC_MAX_SECONDS`）
- 单场最大文件大小 2GB（`_AUTO_REC_MAX_BYTES=2147483648`）
- 网络直播源默认使用同一个 FFmpeg 输入同时推流和录制，避免重复拉取源站直链

**媒体库循环播放（兜底模式）**：
```bash
ffmpeg -stream_loop -1 -re -fflags +genpts -i <录播文件>
```
- 直播源中断时自动循环播放当前任务、当前场次的录播文件维持推流

### 使用场景

1. **网络直播源转推**：通过 yt-dlp 解析直链 → FFmpeg 拉取 HTTP 流 → 推送到 RTMP 目标
2. **媒体库文件推送**：本地/VPS 文件以 `-stream_loop -1` 循环推流
3. **自动录播**：推流同时写入 `.ts` 文件，支持按场次命名和旧文件清理（保留最近 2 份）
4. **兜底播放**：直播源无法获取或关播时，优先播放当前场次的临时录播快照或自动录播文件填充直播间

### 远端依赖自动安装

任务启动时自动在 VPS 检测并安装以下工具（`remoteDependencyInstallCommand`）：
- `wget`、`ca-certificates`
- `ffmpeg`
- `python3`
- `streamlink`（通过 pip 安装）
- `yt-dlp`（从 GitHub releases 下载二进制，支持 x86_64 / aarch64 / armv7l）

---

## SSH / VPS 管理

**npm 包**：`node-ssh@13.2.0`（底层基于 `ssh2`）

### 连接管理（`services/ssh.js`）

- **连接池**：`Map` 结构，Key 为 `userId:vpsId`，缓存已建立的 SSH 连接
- **连接配置**：
  - `readyTimeout: 15000`（15 秒超时）
  - `keepaliveInterval: 30000`（30 秒保活心跳）
  - `keepaliveCountMax: 3`（最多 3 次保活失败后断开）
- **认证方式**：
  - `auth_type='password'`：密码认证
  - `auth_type='key'`：SSH 私钥认证（私钥明文存储在数据库 `vps.private_key` 字段）
- **自动重连**：执行命令失败时检测连接错误类型，自动断开后重连并重试

### VPS 状态监控

- 每 2 分钟发送 `echo ok` 测试命令检测 VPS 在线状态
- 并发检测数量限制：每批最多 3 个 VPS 同时检测

### 远端文件管理

- 媒体库目录：`/root/restream_uploads`
- 日志文件：`/tmp/restream_<taskId>.log`
- 抖音检测脚本：`/opt/restream-console/check_douyin.py`（通过 Base64 编码 SSH 传输）
- 抖音 Cookie 临时文件：`/tmp/dy_ck_<taskId>.txt`

---

## Platform APIs（平台直播检测）

所有平台检测均在本地 Node.js 进程中通过 `fetch` 调用（`services/platform-api.js`），无需额外 npm 包。

### 抖音（Douyin）

支持两种 URL 格式：
- `live.douyin.com/<roomId>`（直播间数字 ID）
- `www.douyin.com/user/<secUserId>`（用户 sec_user_id）

**检测方式（三层）**：

| 方式 | API/URL | 说明 |
|---|---|---|
| HTML 解析 | `https://live.douyin.com/<roomId>` | 无 Cookie 可用，解析 `liveStatus` 字段 |
| 直播间 API | `https://live.douyin.com/webcast/room/web/enter/?aid=6383&...&web_rid=<roomId>` | 需要 Cookie，可获取推流直链（HLS/FLV） |
| 用户主页 API | `https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=<id>&aid=6383&...` | 需要 Cookie，查询直播状态和房间 ID |

**推流直链优先级**：`FULL_HD1` > `HD1` > `SD1` > 其他，HLS 优先于 FLV

**反爬保护**：
- 全局串行队列，每次请求前随机延迟 1~4 秒（`withDouyinRateLimit`）
- 请求头伪装：`User-Agent: Chrome/120.0.0.0`，`Referer: https://live.douyin.com/`

**VPS 端检测脚本**：`check_douyin.py`（Python 3）
- 调用 `webcast.amemv.com/douyin/webcast/reflow/<roomId>` 检测 offline 信号
- 通过 yt-dlp（优先 HLS）+ streamlink 解析直链
- 验证流内容：HLS 检查 `#EXT-X-ENDLIST`，FLV 检查 `Content-Length` / 无限流

### B站（Bilibili）

```
GET https://api.live.bilibili.com/room/v1/Room/get_info?room_id=<roomId>
```
- 免 Cookie 调用
- `data.live_status === 1` 表示直播中
- 视频格式偏好：`vcodec:h264`（避免 HEVC/H.265 不兼容）

### 快手（Kuaishou）

```
GET https://live.kuaishou.com/live_api/liveroom/livedetail?principalId=<userId>
```
- 可能需要 Cookie（无 Cookie 返回 403/401）
- 兜底：解析页面 HTML 中 `"isLiving":true`、`"status":"LIVING"` 等关键词

### YouTube（直播源检测）

- 访问 YouTube 频道/视频页面，解析 HTML 中 `"isLive":true`（仅用于直播源检测，非 Data API）

---

## Environment Variables

| 变量名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `NODE_ENV` | 否 | `development` | 运行环境，`production` 时启用严格安全检查 |
| `SESSION_SECRET` | 生产必填 | `restream-console-dev-secret`（仅开发） | Express 会话加密密钥，生产环境若缺失则启动失败 |
| `ADMIN_PASSWORD` | 生产必填（首次启动） | 随机生成并打印（仅开发） | 初始管理员账号密码，用户表为空时使用 |
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `TRUST_PROXY` | 否 | - | 设为 `true` 时启用 `app.set('trust proxy', 1)`，Nginx 反代必须设置 |
| `YOUTUBE_API_KEYS` | 否 | - | YouTube Data API Key 池（逗号/换行分隔，优先级低于数据库配置） |
| `YOUTUBE_API_KEY` | 否 | - | 单个 YouTube Data API Key（同上，优先级最低） |
| `ALLOW_REGISTRATION` | 否 | - | 设为 `true` 时允许开放注册 |

**注**：YouTube API Key 和抖音 Cookie 也可在网页设置页面配置，存储在 `settings` 表中，优先级高于环境变量。

---

## RTMP / Streaming

### 推流目标 RTMP 地址

系统内置两个平台的 RTMP 服务器地址（`PLATFORM_RTMP`）：

| 平台 | RTMP 地址 |
|---|---|
| YouTube | `rtmp://a.rtmp.youtube.com/live2` |
| TikTok | `rtmp://push.tiktokv.com/live` |

完整推流 URL 格式：`rtmp://<rtmp_url>/<stream_key>`

### 支持的流输入格式

- **HTTP(S) 直播流**：HLS（`.m3u8`）、FLV（`.flv`）
- **RTMP 源**：通过 yt-dlp 解析并传给 FFmpeg
- **本地媒体文件**：支持 VPS 上的任意视频文件循环推送（路径以 `/` 开头标识为媒体库文件）

### yt-dlp 参数

- B站视频格式选择：`-f "best[vcodec^=avc1]/best[vcodec*=h264]/best[vcodec!*=hevc][vcodec!*=h265]"`（强制 H.264）
- 其他平台：`-f "best"`
- 抖音额外请求头：`Referer: https://live.douyin.com/`、`User-Agent: Chrome/120`
- 错误日志：`/tmp/restream_ytdlp_<taskId>.err`

### 健康监控

任务健康检测（每 30 秒）通过 SSH 执行以下综合命令：
1. `kill -0 <pid>`：检测进程是否存活
2. `stat -c %Y <logFile>`：获取日志文件最后修改时间，检测日志停止活跃（默认超时 120 秒）
3. `cat /tmp/restream_<taskId>.status`：读取 bash 脚本写出的 JSON 状态文件
   - 推流中：`state=streaming`
   - 源重试：`state=source_retry`
   - 兜底播放：`state=fallback`
   - 目标断开：`state=target_lost` 或 `target=lost`
4. `ss -tnp`：检测是否存在到端口 1935（RTMP）或 443（RTMPS）的活跃连接

### 录播文件管理

- 录播存储路径：`/root/restream_uploads/`
- 文件命名格式：`录播_<YYYYMMDD_HHMMSS>_<频道名>_task<taskId>.ts`
- 兼容软链接：`task_<taskId>_latest.ts`（指向最新录播）
- 每个任务保留最近 2 份录播，自动清理旧文件
- 当前场次兜底优先使用 `task_<taskId>_fallback.tmp` 临时快照，其次使用当前场次自动录播文件，再次使用 `task_<taskId>_latest.ts`
