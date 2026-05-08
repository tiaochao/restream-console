# 项目结构

## 目录布局

```
restream-console/
├── server.js                  # 应用入口：Express 配置、中间件注册、服务启动
├── db.js                      # 数据库初始化、表结构、迁移、工具函数
├── package.json               # 依赖声明
├── Dockerfile                 # 容器化部署配置
├── docker-compose.yml         # Docker Compose 编排
├── nginx-xiaoyan.chat.conf    # Nginx 反代配置示例
├── check_douyin.py            # 抖音直播检测辅助脚本（部署到 VPS 执行）
├── deploy.js                  # 部署辅助脚本
├── reset-password.js          # 管理员密码重置脚本
│
├── middleware/
│   ├── auth.js                # requireAuth / requireAdmin 中间件
│   └── csrf.js                # CSRF Token 生成与校验中间件
│
├── routes/                    # Express 路由（每文件对应一个功能模块）
│   ├── auth.js                # 登录、注册、登出
│   ├── dashboard.js           # 状态面板
│   ├── tasks.js               # 转推任务管理
│   ├── vps.js                 # VPS 管理
│   ├── channels.js            # 直播间监控频道
│   ├── stream-keys.js         # 推流密钥库
│   ├── media.js               # VPS 媒体库（上传/扫描/删除）
│   ├── logs.js                # 任务日志查看
│   ├── settings.js            # 用户设置
│   ├── youtube-channels.js    # YouTube 频道管理
│   └── admin.js               # 管理员：用户管理、全局设置
│
├── services/                  # 核心业务逻辑服务
│   ├── task-manager.js        # 任务启停、健康检测、Shell 命令生成
│   ├── ssh.js                 # SSH 连接池
│   ├── live-monitor.js        # 直播间状态轮询与自动启动
│   ├── youtube-monitor.js     # YouTube 直播状态监控（Data API）
│   ├── platform-api.js        # 各平台直播状态本地 API 检测
│   └── youtube-channel-sync.js# YouTube 频道数据同步（视频列表/直播历史）
│
├── views/                     # EJS 模板
│   ├── layout.ejs             # 主布局（导航栏、侧边栏、Toast 提示）
│   ├── layout-bare.ejs        # 空白布局（登录/注册页使用）
│   ├── login.ejs              # 登录页
│   ├── register.ejs           # 注册页
│   ├── dashboard.ejs          # 状态面板
│   ├── tasks.ejs              # 任务管理
│   ├── vps.ejs                # VPS 管理
│   ├── channels.ejs           # 频道监控
│   ├── stream-keys.ejs        # 推流码管理
│   ├── media.ejs              # 媒体库
│   ├── logs.ejs               # 日志列表
│   ├── log-detail.ejs         # 日志详情
│   ├── settings.ejs           # 用户设置
│   ├── youtube-channels.ejs   # YouTube 频道
│   ├── admin-users.ejs        # 管理员用户管理
│   └── partials/
│       └── stats.ejs          # 状态面板统计卡片（HTMX 局部刷新）
│
└── data/                      # 运行时数据（.gitignore）
    └── db.sqlite              # SQLite 数据库文件
```

---

## 关键文件

| 文件 | 作用 |
|------|------|
| `server.js` | 应用入口，注册中间件（session、CSRF）、路由、启动后台服务 |
| `db.js` | 数据库连接、全部表创建（`CREATE TABLE IF NOT EXISTS`）、列迁移（`ensureColumn`）、密码工具函数、默认配置初始化 |
| `services/task-manager.js` | 最核心的服务，包含 `buildCommand()`（生成 400+ 行 Shell 脚本）、`startTask()`、`stopTask()`、`checkHealth()`、`startMonitor()` |
| `services/ssh.js` | SSH 连接池，用于所有 VPS 远程命令执行 |
| `services/platform-api.js` | 无 VPS 本地检测各平台直播状态，抖音三路检测策略 |
| `check_douyin.py` | Python 脚本，部署到 VPS 端执行，实现比 yt-dlp 更精准的抖音开播检测 |
| `middleware/auth.js` | 认证守卫，所有受保护路由的入口检查 |

---

## 路由概览

### auth.js（挂载于 `/`，无需认证）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/login` | 显示登录页 |
| POST | `/login` | 处理登录（含限速）|
| GET | `/register` | 显示注册页（受全局开关控制）|
| POST | `/register` | 处理注册 |
| POST | `/logout` | 销毁会话，重定向到登录页 |

### dashboard.js（挂载于 `/dashboard`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/dashboard` | 渲染状态面板（统计卡片 + 近 50 条任务）|
| GET | `/dashboard/stats` | HTMX 轮询接口，返回统计卡片 HTML 片段（无 layout）|

### tasks.js（挂载于 `/tasks`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/tasks` | 任务列表页 |
| POST | `/tasks` | 创建新任务 |
| POST | `/tasks/batch-start` | 批量启动（JSON 响应）|
| POST | `/tasks/batch-stop` | 批量停止（JSON 响应）|
| POST | `/tasks/:id/start` | 启动单个任务（JSON 响应）|
| POST | `/tasks/:id/stop` | 停止单个任务（JSON 响应）|
| POST | `/tasks/:id/delete` | 删除任务（先停止再删）|
| POST | `/tasks/:id/edit` | 编辑任务（JSON 响应）|
| POST | `/tasks/:id/toggle-restart` | 切换自动重启（JSON 响应）|
| POST | `/tasks/:id/calibrate` | 手动触发开播检测（JSON 响应）|
| POST | `/tasks/:id/check-youtube` | 手动触发 YouTube 状态检测（JSON 响应）|

### vps.js（挂载于 `/vps`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/vps` | VPS 列表页 |
| POST | `/vps` | 添加 VPS |
| POST | `/vps/:id/delete` | 删除 VPS |
| POST | `/vps/:id/test` | SSH 连接测试（JSON 响应）|
| GET | `/vps/:id/stats` | VPS 系统资源统计（JSON，磁盘/内存/负载）|
| GET | `/vps/:id/media` | VPS 媒体文件列表（JSON，可带 ?scan=1 触发扫描）|
| POST | `/vps/:id/media/:fileId/delete` | 删除 VPS 媒体文件 |
| POST | `/vps/:id/install-deps` | SSH 安装 ffmpeg/yt-dlp/streamlink（JSON 响应）|
| POST | `/vps/:id/install-xray` | SSH 安装 Xray 代理（JSON 响应）|
| POST | `/vps/:id/socks5-config` | 配置 SOCKS5 代理（JSON 响应）|
| POST | `/vps/ping-all` | 批量检测所有 VPS 连接状态（JSON 响应）|

### channels.js（挂载于 `/channels`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/channels` | 频道监控列表页 |
| POST | `/channels` | 添加直播间频道 |
| POST | `/channels/:id/delete` | 删除频道 |
| POST | `/channels/:id/check` | 手动检测单个频道直播状态（JSON 响应）|
| POST | `/channels/check-all` | 检测所有频道（JSON 响应）|
| POST | `/channels/:id/toggle-auto` | 切换自动启动（JSON 响应）|
| POST | `/channels/:id/edit` | 编辑频道（JSON 响应）|
| POST | `/channels/resolve-meta` | 解析直播间元信息（名称/平台识别，JSON 响应）|

### stream-keys.js（挂载于 `/stream-keys`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/stream-keys` | 推流码列表页 |
| POST | `/stream-keys` | 添加推流码 |
| POST | `/stream-keys/:id/delete` | 删除推流码 |
| POST | `/stream-keys/:id/edit` | 编辑推流码（JSON 响应）|
| POST | `/stream-keys/:id/verify` | 用 VPS 的 ffmpeg 测试推流码有效性（JSON 响应）|
| GET | `/stream-keys/api/list` | 获取推流码列表（JSON，供任务创建表单使用）|

### media.js（挂载于 `/media`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/media` | 媒体库页（按 VPS 切换）|
| GET | `/media/api/list` | 媒体文件列表（JSON）|
| POST | `/media/:vpsId/upload-session` | 创建分片上传会话（JSON）|
| POST | `/media/:vpsId/upload-chunk` | 上传单个分片（通过 multer 直传 VPS SFTP）|
| POST | `/media/:vpsId/upload-complete` | 合并分片，完成上传（JSON）|
| POST | `/media/:vpsId/scan` | 扫描 VPS 目录，同步媒体文件索引（JSON）|
| POST | `/media/:vpsId/fix-names` | 修复乱码录播文件名（JSON）|
| GET | `/media/:vpsId/disk` | VPS 磁盘空间查询（JSON）|
| POST | `/media/:id/delete` | 删除媒体文件（同时删除 VPS 上的文件）|

### logs.js（挂载于 `/logs`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/logs` | 日志任务列表 |
| GET | `/logs/:taskId` | 查看任务日志详情（SSH tail 最后 200 行）|
| GET | `/logs/:taskId/tail` | 返回日志 HTML 片段（HTMX 局部刷新，无 layout）|

### settings.js（挂载于 `/settings`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/settings` | 设置页 |
| POST | `/settings/password` | 修改密码 |
| POST | `/settings/general` | 保存通用设置（延迟/超时/API Key/监控间隔）|
| POST | `/settings/cookies` | 保存抖音 Cookie |
| POST | `/settings/test-douyin` | 测试抖音 Cookie/链接（JSON 响应）|
| POST | `/settings/test-youtube-api-keys` | 测试 YouTube API Key 池（JSON 响应）|

### youtube-channels.js（挂载于 `/youtube-channels`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/youtube-channels` | YouTube 频道列表 |
| POST | `/youtube-channels` | 添加频道（输入链接/ID，API 解析后入库）|
| POST | `/youtube-channels/:id/delete` | 删除频道（级联删 yt_videos）|
| POST | `/youtube-channels/:id/sync` | 同步频道视频列表（JSON 响应）|
| GET | `/youtube-channels/:id/videos` | 获取频道视频/直播列表（JSON，type=video|live）|

### admin.js（挂载于 `/admin`，需 requireAdmin）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/admin/users` | 用户列表管理页 |
| POST | `/admin/users` | 创建新用户 |
| POST | `/admin/users/:id/delete` | 删除用户（不能删自己或最后一个管理员）|
| POST | `/admin/users/:id/role` | 修改用户角色（admin/user）|
| POST | `/admin/settings/registration` | 切换全局注册开关 |

---

## 视图概览

| 模板文件 | 渲染页面 | 说明 |
|----------|----------|------|
| `layout.ejs` | 主布局包装器 | 导航栏、侧边栏、全局 Toast 提示、HTMX 脚本引入 |
| `layout-bare.ejs` | 无导航布局 | 用于登录/注册等独立页面 |
| `login.ejs` | 登录页 | 用户名/密码表单，显示登录错误，显示注册入口（按开关） |
| `register.ejs` | 注册页 | 用户名/密码/确认密码表单 |
| `dashboard.ejs` | `/dashboard` | 统计卡片（VPS/任务状态）、活跃任务列表，HTMX 每 30 秒刷新 |
| `tasks.ejs` | `/tasks` | 任务列表（含状态/操作按钮）、创建任务表单（选择 VPS/推流码/直播源）|
| `vps.ejs` | `/vps` | VPS 列表（含状态/SSH 测试/资源统计）、添加 VPS 表单 |
| `channels.ejs` | `/channels` | 直播间监控列表（含实时状态/自动启动开关）、添加频道表单 |
| `stream-keys.ejs` | `/stream-keys` | 推流码列表（含校验功能）、添加推流码表单，关联 YouTube 频道 |
| `media.ejs` | `/media` | 媒体文件列表（按 VPS 切换）、分片上传界面（带进度条）|
| `logs.ejs` | `/logs` | 有日志的任务列表，点击查看详情 |
| `log-detail.ejs` | `/logs/:taskId` | 日志内容展示，HTMX 自动刷新（运行中任务）|
| `settings.ejs` | `/settings` | 通用设置（超时/API Key/Cookie）、修改密码 |
| `youtube-channels.ejs` | `/youtube-channels` | YouTube 频道卡片（含订阅数/视频数）、视频/直播历史弹窗 |
| `admin-users.ejs` | `/admin/users` | 用户列表（含角色切换/删除）、创建用户表单、注册开关 |
| `partials/stats.ejs` | HTMX 片段 | 仅统计卡片 HTML，供 `/dashboard/stats` 局部刷新 |

---

## 服务概览

| 服务文件 | 职责摘要 |
|----------|----------|
| `task-manager.js` | 任务生命周期核心：Shell 命令构建（录播/兜底/重试逻辑）、SSH 下发执行、进程健康检测、自动重启、状态机维护 |
| `ssh.js` | SSH 连接池（基于 node-ssh），支持密码/私钥认证，自动重连，连接复用 |
| `live-monitor.js` | 定时轮询 `source_channels`，检测直播状态（本地 API + VPS 脚本），触发 `auto_start` 自动创建任务 |
| `youtube-monitor.js` | 定时调用 YouTube Data API v3，更新运行中任务的直播状态/观看人数，多 Key 轮换+配额管理 |
| `platform-api.js` | 无 VPS 本地检测：抖音（HTML/RoomAPI/UserAPI 三路）、B站 API、快手 API+HTML、YouTube HTML，提供推流直链解析 |
| `youtube-channel-sync.js` | YouTube 频道元信息同步：订阅数、视频列表、直播历史、当前直播 video_id 写入 DB |
