# 架构文档

## 概述

restream-console 是一个多用户直播转推控制台。核心功能是：将抖音、B站、快手等平台的直播流，通过远端 VPS 上的 ffmpeg 进程，实时转推到 YouTube、TikTok 等平台的 RTMP 端点。

系统以 Node.js + Express 为基础，数据持久化使用内嵌 SQLite（Node.js 原生 `node:sqlite`），无外部数据库依赖。VPS 任务通过 SSH 下发 Shell 脚本，ffmpeg 在 VPS 上以后台进程运行，控制台本身只做调度和监控，不参与实际媒体流传输。

---

## 请求流程

```
HTTP Request
  │
  ├─ express-session（Cookie 会话，7 天有效）
  ├─ csrfMiddleware（GET/HEAD/OPTIONS 放行；POST/PUT/DELETE 校验 _csrf 或 x-csrf-token）
  │
  ├─ /login, /register, /logout  ──→  auth.js 路由（无需认证）
  ├─ /healthz                    ──→  直接返回 JSON（无需认证）
  │
  └─ 其他路由  ──→  requireAuth（检查 session.authenticated + session.userId）
                   │
                   ├─ /admin/**  ──→  requireAdmin（检查 currentUser.role === 'admin'）
                   │
                   └─ 路由处理器
                         │
                         ├─ 直接查数据库（db.prepare().get/all/run）
                         └─ 调用 service（task-manager / ssh / platform-api 等）
                               │
                               └─ 返回 EJS 视图 或 JSON 响应
```

---

## 认证与多用户

- **会话认证**：使用 express-session，session 中存储 `{ authenticated, userId, username, role }`
- **Cookie 安全**：生产环境 `secure: true`（需 HTTPS），`httpOnly: true`，`sameSite: lax`
- **登录限速**：基于 IP + 用户名组合，15 分钟窗口内最多 8 次失败
- **密码存储**：PBKDF2（310000 次迭代，SHA-256，32 字节），格式 `pbkdf2$salt$hash`
- **角色体系**：`admin` / `user` 两级，admin 可管理所有用户账号和全局注册开关
- **数据隔离**：所有核心表（vps、tasks、stream_keys、source_channels、media_files、settings 等）均带 `user_id` 列，所有查询都加 `WHERE user_id=?` 过滤，级联删除通过外键 `ON DELETE CASCADE` 实现

---

## 核心服务

### task-manager.js
任务生命周期管理的核心。职责：
- `startTask(taskId, userId)`：启动单个任务——检查直播状态 → 生成 Shell 脚本 → SSH 下发 → 记录远端 PID
- `startTaskQueued(taskId, userId)`：带间隔的串行启动队列（防止多任务同时启动冲垮 VPS）
- `stopTask(taskId, userId)`：发送 SIGTERM/kill 到远端 PID，等待进程退出后同步录播文件
- `checkHealth(task)`：任务健康检测——SSH 检查进程存活、日志 mtime、日志关键词、RTMP 连接状态，更新任务状态（running / stalled / source_retrying / target_lost / blocked / error / restarting / waiting_live）
- `startMonitor()`：启动三个后台定时器（见后台进程章节）
- `buildCommand(task)`：生成完整 Shell 脚本（含录播、兜底、重试逻辑），Base64 编码后通过 SSH 执行

### ssh.js
SSH 连接池管理。职责：
- 维护一个 `Map<"userId:vpsId", NodeSSH>` 的连接池
- `exec(vpsId, command, userId)`：执行命令，自动重连（连接断开时重试一次）
- `freshExec(vpsId, command, userId)`：强制断开重连后执行（用于需要干净连接的操作）
- `testConnection(vps)`：临时连接测试（不复用连接池），验证 SSH 可通
- `disconnect(vpsId, userId)`：清理连接池中的连接

支持密码认证和私钥认证（`auth_type: 'password' | 'key'`）。

### live-monitor.js
直播间状态轮询服务。职责：
- 按可配置间隔（默认 5 分钟）轮询所有 `source_channels`
- 对每个频道调用 `checkLive()`：抖音优先用 VPS 上的 `check_douyin.py` 脚本检测，其次 API，其次 VPS yt-dlp 验证
- 若检测到开播且频道配置了 `auto_start=1`，自动调用 `ensureAutoStartTask()` 创建并启动转推任务

### youtube-monitor.js
YouTube 直播状态监控。职责：
- 每 60 秒轮询所有 platform='youtube' 且状态活跃的任务
- 调用 YouTube Data API v3（videos.list / search.list）获取直播状态、观看人数、标题
- 支持多 API Key 轮询（Key 池），自动跳过配额耗尽或无效的 Key，记录每个 Key 的状态（ok/quota/rate_limited/invalid/forbidden）
- 更新 tasks 表中的 `youtube_*` 字段

### platform-api.js
本地平台直播状态检测（无需 VPS）。支持：
- **抖音**：三路检测——HTML 解析（`liveStatus` 字段）、直播间 Room API（有 Cookie 时可获取推流直链）、用户主页 API（sec_user_id 格式）；所有抖音请求串行限速（1~4 秒随机延迟）
- **B站**：调用 `api.live.bilibili.com/room/v1/Room/get_info`
- **快手**：调用 livedetail API，兜底 HTML 关键词检测
- **YouTube**：HTML 关键词检测（`"isLive":true`）
- 提供 `resolveDouyinStreamUrl()` 解析抖音推流直链（HLS 优先，FLV 备用）

### youtube-channel-sync.js
YouTube 频道数据同步。职责：
- 通过 YouTube Data API v3 获取频道元信息（订阅数、视频数、上传播放列表 ID）
- 拉取最新 50 条视频详情（含直播历史、点赞数、并发观看数）
- 识别进行中的直播，写入 `yt_channels.current_live_video_id`
- 多 Key 轮换，自动跳过配额耗尽的 Key

---

## 数据库设计

数据库文件：`data/db.sqlite`，使用 Node.js 原生 `node:sqlite` 同步 API。

### 核心表

| 表名 | 说明 | 关键列 |
|------|------|--------|
| `users` | 用户账号 | `id`, `username`, `password_hash`, `role (admin/user)` |
| `vps` | VPS 服务器 | `id`, `user_id`, `host`, `port`, `auth_type`, `password/private_key`, `status (online/offline/unknown)` |
| `tasks` | 转推任务 | `id`, `user_id`, `vps_id`, `platform`, `source_url`, `rtmp_url`, `stream_key`, `status`, `remote_pid`, `log_file`, `auto_restart`, `backup_urls`, `youtube_*` 字段组 |
| `stream_keys` | 推流密钥库 | `id`, `user_id`, `name`, `platform`, `rtmp_url`, `stream_key`, `default_vps_id`, `youtube_url`, `youtube_channel_id` |
| `source_channels` | 直播间监控列表 | `id`, `user_id`, `name`, `platform`, `url`, `live_status`, `last_check`, `auto_start`, `auto_vps_id`, `auto_stream_key_id` |
| `media_files` | VPS 媒体文件索引 | `id`, `user_id`, `vps_id`, `name`, `remote_path`, `size` |
| `upload_sessions` | 分片上传会话 | `id (hex)`, `user_id`, `vps_id`, `remote_path`, `chunk_size`, `total_chunks`, `expires_at` |
| `settings` | 用户级配置 | `(user_id, key)` 复合主键，`value` |
| `global_settings` | 全局配置 | `key`, `value`（如注册开关 `allow_registration`） |
| `yt_channels` | YouTube 频道 | `id`, `user_id`, `channel_id`, `title`, `handle`, `subscriber_count`, `current_live_video_id`, `uploads_playlist_id` |
| `yt_videos` | YouTube 视频/直播记录 | `id`, `user_id`, `channel_id`, `video_id`, `type (video/live/shorts)`, `duration_sec`, `view_count`, `concurrent_viewers`, `live_start`, `live_end` |

### 关键关系

- `tasks.vps_id → vps.id ON DELETE SET NULL`（删除 VPS 不删任务，但解绑）
- `tasks.user_id → users.id ON DELETE CASCADE`（删除用户级联删全部数据）
- `stream_keys.default_vps_id → vps.id ON DELETE SET NULL`
- `stream_keys.youtube_channel_id → yt_channels.id ON DELETE SET NULL`
- `source_channels` 有 `UNIQUE INDEX (user_id, url)` 防止重复添加

### 用户配置键

`settings` 表中每个用户有以下默认键：
- `start_delay`（任务启动间隔秒数，默认 5）
- `stall_timeout`（日志无活动超时秒数，默认 120）
- `max_tasks_per_vps`（单 VPS 最大并发任务数，默认 5）
- `block_limit`（验证码连续触发上限，默认 8）
- `monitor_interval`（直播间轮询间隔分钟，默认 5）
- `youtube_api_key` / `youtube_api_keys`（API Key 单个/池）
- `youtube_api_key_cursor`（当前轮换位置）
- `youtube_api_key_status`（各 Key 状态 JSON）
- `douyin_cookies`（抖音 Cookie 字符串）

---

## 后台进程

服务启动后（`server.js` 调用 `startMonitor()`），同时启动三个后台循环：

### task-manager.startMonitor()

| 定时器 | 间隔 | 功能 |
|--------|------|------|
| 任务健康检测 | 30 秒 | 对所有 `running/stalled/source_retrying/target_lost` 任务，SSH 进入 VPS 检查进程存活、日志 mtime、日志关键词、RTMP 连接状态，自动处理异常（重启/停止/更新状态） |
| 等待直播检测 | 60 秒 | 对所有 `waiting_live` 任务，调用平台 API 检测是否开播，若开播自动调用 startTaskQueued 启动 |
| VPS 心跳检测 | 2 分钟 | 对所有 VPS 逐一做 SSH 连接测试，更新 `vps.status` |

### live-monitor.startLiveMonitor()

| 定时器 | 间隔 | 功能 |
|--------|------|------|
| 频道直播状态扫描 | 可配置（默认 5 分钟） | 遍历所有 `source_channels`，检测开播状态，触发 `auto_start` 逻辑自动创建并启动任务 |

### youtube-monitor.startMonitor()

| 定时器 | 间隔 | 功能 |
|--------|------|------|
| YouTube 直播状态轮询 | 60 秒 | 对所有活跃的 YouTube 平台任务，调用 YouTube Data API 更新直播状态、观看人数等字段 |

---

## VPS 任务执行模型

任务执行完全在 VPS 侧进行，控制台通过 SSH 下发脚本并监控：

1. **命令生成**（`buildCommand(task)`）：
   - 生成一个大型 Bash 脚本（含录播、兜底、重试逻辑）
   - Base64 编码后拼成：`nohup bash -c "$(echo '<b64>' | base64 -d)" > /tmp/restream_<id>.log 2>&1 & echo $!`
   - 通过 `sshService.exec()` 发送执行，获取远端 PID

2. **进程管理**：
   - 远端进程为 nohup 后台进程，与 SSH 会话脱离
   - `stopTask()` 通过 `pkill -P <pid>` + `kill <pid>` 终止整个进程组
   - 健康检测通过 `kill -0 <pid>` 检查进程是否存活

3. **依赖安装**（`ensureRemoteRuntime()`）：
   - 首次启动时自动在 VPS 上安装 ffmpeg / yt-dlp / streamlink / wget / python3
   - 将 `check_douyin.py` 脚本同步到 VPS 的 `/opt/restream-console/`

4. **日志管理**：
   - 任务日志写到 VPS 的 `/tmp/restream_<taskId>.log`
   - 健康检测通过 `stat -c %Y <logfile>` 检查 mtime 判断活跃度
   - `tail -n 200 <logfile>` 读取日志末尾做关键词检测

---

## 数据流：转推任务

```
用户提交任务（POST /tasks）
  │
  ├─ 写入 tasks 表（status='idle'）
  │
POST /tasks/:id/start 或 live-monitor 触发
  │
  ├─ checkDouyin/Bilibili/Kuaishou（本地 API 检测直播状态）
  │     ├─ isLive=false → status='waiting_live'，等待下次轮询
  │     └─ isLive=true 或无法检测 → 继续
  │
  ├─ ensureRemoteRuntime（SSH 安装 ffmpeg/yt-dlp/streamlink）
  │
  ├─ [抖音] resolveDouyinStreamUrl（API 预解析推流直链）
  │        └─ 写入 task._resolvedStreamUrl（首轮 ffmpeg 使用）
  │
  ├─ buildCommand(task)
  │     ├─ 媒体文件源：ffmpeg -stream_loop -1 -re -i <path> -f flv <rtmp_url>/<stream_key>
  │     └─ 网络直播源：
  │           bash while 循环 {
  │             1. 第一轮优先使用预解析直链（更快）
  │             2. 后续用 yt-dlp 或 check_douyin.py 解析最新直链
  │             3. ffmpeg 推流（同步录制到 /root/restream_uploads/录播_*.ts）
  │             4. 推流异常 → 用录播文件兜底（循环播放已录制内容）
  │             5. 直链过期（expire 时间戳）→ 主动刷新直链
  │           }
  │
  ├─ SSH 执行（nohup bash ...）→ 获取远端 PID
  │
  └─ 更新 tasks: status='running', remote_pid=<pid>, log_file='/tmp/restream_<id>.log'

后台健康检测（每 30 秒）
  ├─ SSH: kill -0 <pid>（存活检测）
  ├─ SSH: stat -c %Y <logfile>（日志活跃度）
  ├─ SSH: tail -n 200 <logfile>（关键词检测）
  ├─ SSH: ss -tnp（RTMP 连接检测）
  └─ 根据结果更新状态：
       running → stalled → restarting → running（自动重启）
       或 error / target_lost / source_retrying / blocked / waiting_live
```

### 推流目标

| 平台 | RTMP 地址 |
|------|-----------|
| YouTube | `rtmp://a.rtmp.youtube.com/live2` |
| TikTok | `rtmp://push.tiktokv.com/live` |
| 自定义 | 用户填写任意 rtmps?:// 地址 |

ffmpeg 参数：`-c:v copy -c:a copy`（直通，无转码），`-f flv`（FLV 封装，RTMP 标准格式）。
