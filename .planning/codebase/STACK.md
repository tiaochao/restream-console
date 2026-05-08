# Tech Stack

## Runtime & Language

- **Node.js v24**（Dockerfile 基础镜像 `node:24-slim`）
- 语言：JavaScript（CommonJS 模块规范，`require/module.exports`）
- 无 TypeScript / Babel，直接运行原生 Node.js
- 使用 Node.js 内置 `node:sqlite` 模块（v22.5+ 实验性 API，无需额外安装 SQLite 绑定）
- 使用 Node.js 内置 `crypto`、`fs`、`path` 模块处理密码哈希、文件操作

## Core Framework

**Express.js v4.18.3**

关键中间件配置：

| 中间件 | 作用 |
|---|---|
| `express-ejs-layouts@2.5.1` | EJS 布局系统，所有页面共享 `views/layout.ejs` |
| `express-session@1.18.0` | 服务端会话，Cookie 7 天有效，生产环境强制 HTTPS-only |
| `express.urlencoded` + `express.json` | 请求体解析 |
| 自定义 `csrfMiddleware` | CSRF Token 验证（同步 Token 模式） |
| 自定义 `requireAuth` / `requireAdmin` | 会话鉴权 + 角色守卫 |

视图引擎：**EJS v3.1.10**（`views/` 目录，服务端渲染）

## Database

**SQLite**（通过 Node.js 内置 `node:sqlite` 的 `DatabaseSync` 同步 API）

数据文件路径：`./data/db.sqlite`（Docker 挂载目录 `./data:/app/data`）

数据表结构概览：

| 表名 | 说明 |
|---|---|
| `users` | 用户账号，支持角色（`user` / `admin`），密码使用 PBKDF2-SHA256 哈希存储 |
| `vps` | VPS 配置，支持密码和 SSH 私钥两种认证方式，记录在线状态 |
| `tasks` | 转推任务，关联 VPS 和推流码，记录运行状态、PID、日志路径、YouTube 直播检测数据 |
| `stream_keys` | 推流码库，按平台分类（youtube / tiktok 等），可关联默认 VPS 和 YouTube 频道 |
| `source_channels` | 直播源频道监控列表，支持自动开播检测和自动创建任务 |
| `media_files` | VPS 上远端媒体文件的本地元数据索引 |
| `upload_sessions` | 分块上传会话管理，支持大文件断点续传 |
| `settings` | 按用户存储的键值配置（YouTube API Key、抖音 Cookie、监控间隔等） |
| `global_settings` | 全局键值配置 |
| `yt_channels` | YouTube 频道信息缓存（订阅数、上传播放列表 ID、当前直播视频 ID 等） |
| `yt_videos` | YouTube 视频记录（直播/普通视频/短视频，统计数据） |

密码哈希算法：`PBKDF2-SHA256`，310000 次迭代，盐值随机 16 字节，格式 `pbkdf2$<salt>$<hash>`

## Key Dependencies

| 包名 | 版本 | 用途 |
|---|---|---|
| `express` | ^4.18.3 | HTTP 服务器核心框架 |
| `ejs` | ^3.1.10 | 服务端 HTML 模板引擎 |
| `express-ejs-layouts` | ^2.5.1 | EJS 布局嵌套支持 |
| `express-session` | ^1.18.0 | 服务端会话管理 |
| `multer` | ^2.1.1 | 多部分表单文件上传处理（媒体文件上传） |
| `node-ssh` | ^13.2.0 | SSH 连接池，封装 VPS 远端命令执行 |

Node.js 原生 API（无需额外安装）：

- `node:sqlite`（DatabaseSync）- 数据库
- `crypto` - 密码哈希、CSRF Token 生成
- `fs` / `path` - 文件操作
- `fetch`（Node.js 18+ 内置）- 调用平台 API、YouTube Data API

## Dev Dependencies

`package.json` 中未声明任何 devDependencies。

可用的工具脚本（通过 `scripts/` 目录）：

| 脚本 | 说明 |
|---|---|
| `node scripts/check.js` | 健康检查脚本 |
| `node scripts/smoke.js` | 冒烟测试脚本 |

无 ESLint / Prettier / Jest / Mocha 等测试/Lint 工具。

## Infrastructure

**Docker**

- 基础镜像：`node:24-slim`
- 构建方式：`npm ci --omit=dev`（仅安装生产依赖）
- 工作目录：`/app`
- 数据持久化：`./data:/app/data`（SQLite 文件挂载）
- 端口：`3000`（容器内外均为 3000）
- 重启策略：`unless-stopped`
- 配置注入：通过 `.env` 文件（`env_file: .env`）

**Nginx 反代**（可选）

项目根目录有 `nginx-xiaoyan.chat.conf`，说明生产环境通过 Nginx 做 HTTPS 终止和反向代理，服务器支持 `TRUST_PROXY=true` 配置。

**VPS 部署**（无 Kubernetes）

单容器、单节点部署，FFmpeg 运行在被管理的远端 VPS 上，不在本地容器内运行。

## Build & Scripts

```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "check": "node scripts/check.js",
  "smoke": "node scripts/smoke.js"
}
```

- `npm start`：生产启动
- `npm run dev`：开发模式，使用 Node.js 原生 `--watch` 热重载
- `npm run check`：运行健康检查
- `npm run smoke`：冒烟测试
