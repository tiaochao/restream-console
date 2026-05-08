# Restream Console

面向多 VPS 的直播转推控制台。通过浏览器统一管理直播源、推流码、执行 VPS、媒体文件和转推任务，适合把抖音、B 站、快手、TikTok、YouTube 等直播源转推到 YouTube、TikTok 或自定义 RTMP 平台。

![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)
![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-blue)
![Docker](https://img.shields.io/badge/Docker-ready-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 项目定位

Restream Console 不是单纯的 FFmpeg 命令生成器，而是一套直播转推运维面板：

- 频道开播后自动检测、自动创建任务、自动开始转推。
- 直播直链失效时自动重试，并可切换到录播文件维持目标平台直播。
- 支持多用户、多 VPS、多推流密钥、多直播间并行管理。
- 所有执行动作通过 SSH 下发到指定 VPS，控制台负责调度、状态、日志和数据管理。

典型链路：

```text
直播间 / 媒体文件
    -> Restream Console 调度
    -> 指定 VPS 执行 yt-dlp / FFmpeg
    -> YouTube / TikTok / 自定义 RTMP
```

## 核心能力

### 频道监控与自动开播

- 支持保存抖音、B 站、快手、YouTube、TikTok、自定义直播源。
- 支持批量检测和单频道检测。
- 支持频道开播后自动选择推流码和默认 VPS 创建转推任务。
- 支持通过直播间链接、账号主页链接、短链接等输入智能识别频道信息。
- 频道名称可从直播链接自动提取，也可手动填写备注，方便后期管理。

### 直播转推任务

- 支持直播间直接转推。
- 支持多直播源备用地址，主源异常后自动切换。
- 支持纯文件转播。
- 支持直播中同步录播，源直播断开后自动切换到本场录播文件循环播放。
- 支持限制单场录播时长和文件大小，避免 VPS 磁盘被占满。
- 支持无转码 copy 模式，优先降低 CPU 占用。
- 支持自动重启、远程停止、日志查看和状态巡检。

### VPS 管理

- 支持多台执行 VPS。
- 支持 SSH 密码或私钥连接。
- 支持在线检测、依赖检查和依赖安装。
- 支持查看 VPS 上的媒体文件，便于确认、复用和清理。
- 任务按指定 VPS 执行，避免控制台服务器承担大文件上传和 FFmpeg 推流压力。

### 推流码库

- 集中管理 YouTube、TikTok、自定义 RTMP 等推流密钥。
- 支持名称、备注、平台分类和后期编辑。
- 支持绑定默认 VPS，让自动录播、文件转播和转推任务能找到正确执行机器。
- 任务列表会尽量展示频道名称和推流密钥名称，减少排查时的混淆。

### 媒体库

- 文件上传到执行 VPS，而不是控制台服务器。
- 支持将 VPS 上的媒体文件作为纯文件转播源。
- 支持作为直播中断后的兜底播放素材。
- 媒体库更偏向 VPS 文件管理入口，任务创建时也可以直接选择或上传文件。

### 多用户与隔离

- 支持管理员和普通用户。
- 用户之间的频道、任务、推流码、Cookie、VPS 绑定等数据隔离。
- 管理员可维护系统配置和用户账号。
- 敏感信息不会在列表中直接明文展示。

## 支持范围

| 类型 | 支持内容 |
| --- | --- |
| 直播源 | 抖音、B 站、快手、YouTube、TikTok、自定义 URL |
| 目标平台 | YouTube、TikTok、自定义 RTMP |
| 执行方式 | 直播转推、文件转播、直播转录播兜底 |
| VPS 连接 | SSH 密码、SSH 私钥 |
| 运行方式 | 本地 Node.js、Docker Compose、SSH 部署脚本 |

> 平台直播页面和风控策略会变化，检测和直链解析无法保证永远 100% 成功。生产环境建议配置有效 Cookie、多直播源备用、自动录播兜底和任务健康巡检。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| Web 服务 | Express.js |
| 页面模板 | EJS + express-ejs-layouts |
| 数据库 | Node.js 内置 SQLite (`node:sqlite`) |
| 远程执行 | node-ssh |
| 转推执行 | yt-dlp + FFmpeg |
| 前端样式 | Tailwind CSS |
| 部署 | Docker Compose / SSH 部署脚本 |

## 快速开始

### 环境要求

- Node.js 22+，推荐 Node.js 24。
- 一台或多台 Linux VPS。
- VPS 可通过 SSH 登录。
- VPS 上需要 `ffmpeg`、`yt-dlp`、`python3`，可在控制台内安装或同步。

### 本地运行

```bash
git clone https://github.com/your-username/restream-console.git
cd restream-console

npm install
cp .env.example .env
npm start
```

访问：

```text
http://localhost:3000
```

首次启动会自动创建 SQLite 数据库：

```text
data/db.sqlite
```

生产环境请务必备份该目录。

## Docker 部署

```bash
git clone https://github.com/your-username/restream-console.git
cd restream-console

cp .env.example .env
docker compose up -d
```

服务默认监听 `3000` 端口，建议放在 Nginx / HTTPS 反向代理后面。

## 环境变量

常用配置：

```env
PORT=3000
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret
ADMIN_PASSWORD=replace-with-a-strong-password
TRUST_PROXY=true
ALLOW_REGISTRATION=false
```

说明：

- `SESSION_SECRET`：生产环境必填，必须使用强随机字符串。
- `ADMIN_PASSWORD`：首次启动时用于创建默认管理员密码。
- `TRUST_PROXY`：使用 Nginx、宝塔、Cloudflare 等反向代理时建议开启。
- `ALLOW_REGISTRATION`：是否开放用户自助注册，默认建议关闭。

## VPS 准备

可在控制台的 VPS 页面一键安装依赖，也可以手动安装：

```bash
apt update
apt install -y ffmpeg curl wget python3

wget -O /usr/local/bin/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x /usr/local/bin/yt-dlp
```

转推任务会在执行 VPS 上运行，日志通常写入：

```text
/tmp/restream_<taskId>.log
```

## 日常使用流程

1. 添加 VPS，并确认 SSH 连接正常。
2. 添加推流码，选择目标平台和默认 VPS。
3. 添加频道监控，填入直播间链接或账号主页链接。
4. 开启自动启动开关。
5. 频道开播后，系统自动检测并创建转推任务。
6. 在任务管理中查看状态，在日志页面排查异常。
7. 如需兜底，开启直播同步录播，让源直播断开后继续播放录播文件。

## 项目结构

```text
restream-console/
├── server.js              # Express 入口
├── db.js                  # SQLite 初始化和 Schema
├── deploy.js              # SSH 同步部署脚本
├── reset-password.js      # 管理员密码重置工具
├── check_douyin.py        # 抖音检测和解析辅助脚本
├── middleware/            # 认证、CSRF 等中间件
├── routes/                # 页面和 API 路由
├── services/              # SSH、任务管理、直播监控、平台解析
├── views/                 # EJS 页面模板
├── scripts/               # 自检和冒烟测试脚本
└── data/                  # 运行时数据，包含 SQLite 数据库
```

## 运维建议

- 给不同用户配置各自的 Cookie、频道和推流码，避免数据混淆。
- 一台普通 VPS 同时跑多个直播间时，优先使用不转码模式。
- 定期清理录播文件和临时媒体文件。
- 定期备份 `data/db.sqlite`。
- YouTube Studio 里的直播事件、串流码、可见性和排程状态仍需要正确配置；系统只能确认 RTMP 连接和 FFmpeg 推流状态，不能替代 YouTube 后台的直播事件管理。
- 如果直播源平台触发风控，建议配置 Cookie、减少检测频率、使用备用直播源，并开启录播兜底。

## 安全说明

- 控制台会保存 VPS、Cookie、推流码等敏感信息，请只部署在可信环境。
- 生产环境必须使用 HTTPS。
- 不要把真实 Cookie、SSH 私钥、推流密钥提交到 GitHub。
- 普通用户和管理员权限应分开使用。
- 仅转播你拥有权利或已获授权的内容，并遵守源平台和目标平台规则。

## License

MIT
