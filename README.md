# Restream Console

直播转推管理控制台。在浏览器中管理多台 VPS，通过 SSH 远程控制 yt-dlp + FFmpeg，将抖音、TikTok 等平台的直播流转推到 YouTube、TikTok 等目标平台。

![Node.js](https://img.shields.io/badge/Node.js-24-green) ![SQLite](https://img.shields.io/badge/SQLite-built--in-blue) ![Docker](https://img.shields.io/badge/Docker-ready-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## 功能

- **转推任务** — 通过页面 URL 拉流（yt-dlp 解析），FFmpeg 推送到 YouTube / TikTok / 自定义 RTMP；支持自动重启、备用 URL 故障切换
- **直播监控** — 定时检测源频道开播状态，开播后自动触发对应转推任务
- **VPS 管理** — 支持密码和 SSH 私钥两种认证，一键安装 yt-dlp + FFmpeg 依赖，心跳检测在线状态
- **推流密钥库** — 集中管理 YouTube、TikTok 等多平台推流密钥，可与任务快速绑定
- **媒体库** — 通过 SSH 管理 VPS 上的媒体文件，支持上传和扫描
- **实时日志** — 在线查看远程 VPS 上的转推进程日志
- **仪表盘** — 任务状态、VPS 在线数、运行时长统计，每 15 秒自动刷新

## 技术栈

| 层 | 选型 |
|----|------|
| Web 框架 | Express.js |
| 模板引擎 | EJS + express-ejs-layouts |
| 数据库 | Node.js 内置 SQLite（node:sqlite） |
| SSH | node-ssh |
| 前端 | Tailwind CSS（CDN）|
| 容器化 | Docker + docker-compose |
| 部署 | 自定义 deploy.js 脚本，SSH 同步 + Docker 重建 |

## 快速开始

### 前置要求

- Node.js 22+（使用内置 `node:sqlite`，无需额外安装 better-sqlite3）
- 至少一台 Linux VPS，已开放 SSH 访问
- VPS 上需预装 FFmpeg 和 yt-dlp（可在应用内一键安装）

### 本地运行

```bash
git clone https://github.com/your-username/restream-console.git
cd restream-console

npm install

# 复制并编辑环境变量
cp .env.example .env
# 至少设置 SESSION_SECRET

npm start
# 访问 http://localhost:3000
```

首次启动自动创建 `data/db.sqlite`，并写入初始管理员账户（见首次登录说明）。

### Docker 部署

```bash
# 在 VPS 上
git clone https://github.com/your-username/restream-console.git
cd restream-console

cp .env.example .env
# 编辑 .env，设置 SESSION_SECRET 和管理员密码

docker compose up -d
```

服务监听 `3000` 端口，数据持久化到 `./data/` 目录。

### 一键部署到 VPS

如果 VPS 信息已录入系统，可使用内置部署脚本：

```bash
# 同步代码 + 重建容器（默认目标 VPS ID=3）
node deploy.js

# 指定其他 VPS
node deploy.js 1
```

脚本通过 SSH 将源码同步到 `/opt/restream-console`，然后重建 Docker 镜像并替换容器。

## 环境变量

复制 `.env.example` 并按需修改：

```env
SESSION_SECRET=your-random-secret-here   # 必填，生产环境强制要求
ADMIN_PASSWORD=your-admin-password        # 首次启动时自动创建 admin 账户
PORT=3000                                 # 监听端口，默认 3000
NODE_ENV=production                       # 生产环境设为 production
TRUST_PROXY=true                          # 在 Nginx 反代后面时设为 true
ALLOW_REGISTRATION=false                  # 是否开放注册，默认 false
```

## VPS 依赖

在 VPS 页面点击「安装依赖」自动执行，或手动运行：

```bash
apt install -y ffmpeg curl wget

# 安装 yt-dlp（独立二进制，无需 Python）
wget -O /usr/local/bin/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x /usr/local/bin/yt-dlp
```

## 项目结构

```
restream-console/
├── server.js              # Express 入口
├── db.js                  # SQLite 初始化 & Schema
├── deploy.js              # 一键部署脚本
├── reset-password.js      # 密码重置工具
├── middleware/
│   ├── auth.js            # Session 鉴权
│   └── csrf.js            # CSRF 防护
├── routes/                # 路由（每个模块一个文件）
│   ├── auth.js, dashboard.js, vps.js, tasks.js
│   ├── channels.js, stream-keys.js, media.js
│   ├── logs.js, settings.js
├── services/
│   ├── ssh.js             # SSH 连接池
│   ├── task-manager.js    # 任务生命周期管理
│   ├── live-monitor.js    # 开播检测调度
│   └── platform-api.js   # 各平台 API（抖音等）
├── views/                 # EJS 模板
│   ├── layout.ejs         # 全局布局（侧边栏、全局 fetch 拦截）
│   └── *.ejs              # 各页面模板
├── scripts/
│   ├── check.js           # 环境自检
│   └── smoke.js           # 冒烟测试
└── data/                  # 运行时生成（SQLite 文件）
```

## 数据库 Schema

5 张核心表：

| 表 | 说明 |
|----|------|
| `users` | 用户账户，支持角色（admin/user） |
| `vps` | VPS 配置，密码或私钥认证 |
| `tasks` | 转推任务，含 PID、日志路径、自动重启配置 |
| `stream_keys` | 推流密钥库，按平台分类 |
| `source_channels` | 源频道配置，支持自动触发规则 |

数据文件位于 `data/db.sqlite`，需做好定期备份。

## 转推原理

```
源直播间 URL
    │
    ▼ SSH
  yt-dlp -g "URL"          # 解析出真实流地址
    │
    ▼
  ffmpeg -re -i pipe:0     # 读取流
    -c:v copy -c:a copy    # 不转码，直接复制
    -f flv "RTMP/KEY"      # 推送到目标平台
    │
    ▼
  nohup 后台运行，日志写到 /tmp/restream_<taskId>.log
```

进程 PID 写入数据库，用于后续停止任务和状态检测（`kill -0 PID`）。

## Nginx 反代参考

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配合 `.env` 中设置 `TRUST_PROXY=true` 使 Session Cookie 在 HTTPS 下正常工作。

## 找回密码

```bash
# 在服务器上（容器外）
node reset-password.js admin 新密码

# Docker 环境
docker exec restream-console node reset-password.js admin 新密码
```

## 安全说明

- 所有表单和 AJAX 请求均有 CSRF 防护
- SSH 私钥加密存储（建议部署后限制 VPS 机器访问权限）
- 推流密钥在列表中默认遮蔽，点击才显示
- 生产环境必须设置强随机 `SESSION_SECRET`，Cookie 使用 `httpOnly + secure + sameSite=lax`
- Shell 命令参数均经过转义，防止注入（yt-dlp URL、RTMP 地址、文件路径）

## License

MIT
