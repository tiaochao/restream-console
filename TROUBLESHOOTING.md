# restream-console 故障排查手册

> 每次解决新问题后在本文件追加记录，避免重复踩坑。

---

## 一、环境速览

| 项目 | 值 |
|------|----|
| 控制台地址 | `107.175.194.202:3000`（Docker 容器 `restream-console`） |
| 控制台部署 | `node deploy.js`（上传源码 → docker build → 切换容器） |
| VPS 操作系统 | Ubuntu 20.04 |
| VPS FFmpeg 版本 | **4.2.x**（必须严格兼容，4.4+ 参数会静默失败） |
| VPS 网络 | 全部北美 IP，无亚太节点 |
| GitHub | https://github.com/tiaochao/restream-console.git |
| 中继配置 | `.env` 中 `RELAY_VPS_IDS=3,7,13`（生产 DB ID） |

### VPS 列表（生产数据库）

| 用户 | VPS 名 | IP |
|------|--------|-----|
| 萧炎 | 萧炎-01 ~ 萧炎-04 | 107.172.x / 107.175.x / 192.3.x |
| 伊文 | 伊文-01 ~ 伊文-02 | 64.188.x / 107.173.x |
| root | root / root2 | 107.173.x / 23.94.x |
| 桑小宝 | 桑小宝 | 204.44.x |

---

## 二、部署 SOP

```bash
# 完整部署（会重建镜像，中断推流约 3-5 分钟）
node deploy.js

# 仅部署 Python 检测脚本（不中断推流）
node deploy-kuaishou.js
```

**部署后**：正在运行的任务需要手动重启，才能使用新的 FFmpeg 参数。

---

## 三、FFmpeg 4.2.x 兼容性禁令

以下参数在 FFmpeg 4.4+ 才有，**生产 VPS 上禁止使用**：

| 禁用参数 | 原因 |
|----------|------|
| `-stats_period` | 4.4+ 新增，4.2 静默失败 |
| `onfail=ignore`（tee muxer 内部） | 需确认 4.2 是否支持，已在生产使用 |

---

## 四、各平台已知限制与解决方案

### 4.1 抖音（Douyin）

**问题：check_douyin.py 返回 `API: 无直链 (src=room-api-no-stream)`**

- **原因**：VPS 是北美 IP，抖音房间 API 对非中国 IP 返回"无直播流"
- **后果**：系统回退 yt-dlp，拿到的 m3u8 URL 可能指向已失效的 CDN slot，FFmpeg 报 404
- **解决**：给任务配置有效的抖音 Cookie（中国手机号账号登录后导出 Netscape 格式 Cookie）
- **验证**：CDN 本身（pull-q5.douyincdn.com）对北美 IP **不封锁**，TCP 连通，404 是 CDN 内容问题，非 IP 封禁

**问题：LIVE_WATCHDOG 误触发（直播正常但提示断流）**

- **原因**：抖音 HLS 片段下载延迟可达 6-8s，旧阈值 6s 太紧
- **解决**：已将 `_LIVE_STALL_LIMIT` 从 6s 改为 12s（2025-05 修复）

**抖音中继配置**（`.env`）：
```
RELAY_SECRET=    # 留空=关闭中继
RELAY_HOST=107.175.194.202:3000
RELAY_VPS_IDS=3,7,13   # 生产 DB 中未被封锁的 VPS ID
```

---

### 4.2 YouTube

**问题："两路推主 URL" YouTube Studio 警告**

- **原因**：备用服务器 URL 缺少 `?backup=1` 参数，YouTube 把备流也当主流处理
- **解决**：`youtubeBackupDest()` 函数已加 `?backup=1`（2025-05 修复）
- **备用服务器格式**：`rtmp://b.rtmp.youtube.com/live2?backup=1/STREAM_KEY`

**问题：帧率/分辨率不匹配警告（YouTube Studio）**

- **原因**：主备流走不同内容（主流推直播，备流推录播兜底），内容不一致导致 YouTube 检测到不匹配
- **解决**：实现 tee muxer，将完全相同的流同时推到主备（2025-05 修复）
  ```
  -f tee "[f=flv:flvflags=no_duration_filesize:onfail=ignore]PRIMARY_URL|[f=flv:flvflags=no_duration_filesize:onfail=ignore]BACKUP_URL"
  ```
- **注意**：`-flvflags no_duration_filesize` 必须写在每个 tee 子输出内部，tee 容器本身不认识该选项

**问题：YouTube 关键帧间隔警告（8.3s，应 ≤4s）**

- **原因**：x264 默认 GOP=250 帧，30fps 下约 8.3s
- **解决**：所有涉及 x264 的 FFmpeg 命令加 `-g 48 -keyint_min 48`（2025-05 修复）
  - `services/ffmpeg-args.js` HEVC 自动转码路径
  - `routes/media.js` "转 H.264" VPS 转码路径

---

### 4.3 媒体库转码（VPS 端 H.264 转码）

**问题：点击"转 H.264"无反应，页面静默恢复**

- **原因**：脚本用 `bash -c '...'` 嵌套 `shQuote()`（单引号），引号冲突导致 SSH 命令静默失败
- **解决**：改用 base64 编码的临时脚本文件（2025-05 修复）
  ```js
  const b64 = Buffer.from(innerScript).toString('base64');
  await sshService.exec(vpsId, `printf '%s' '${b64}' | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`);
  await sshService.exec(vpsId, `nohup ${scriptPath} >/dev/null 2>&1 &`);
  ```

**问题：转码报 "Unable to find suitable output format for '...transcoding'"**

- **原因**：FFmpeg 从扩展名推断格式，`.transcoding` 未知
- **解决**：显式加 `-f mp4`（2025-05 修复）

**问题：转码后文件仍有 8.3s 关键帧（旧文件）**

- **原因**：转码在修复前完成，已烤入旧关键帧；复制模式会保留原始帧
- **解决**：删除旧的 `_h264.mp4`，重新点"转 H.264"

---

## 五、直播兜底优先级（CLAUDE.md 约定）

```
实时直链
  → 正在录制的临时片段快照
    → 当前场次自动录播文件
      → task_<taskId>_latest.ts 兼容链接
        → 断流/重试
```

**禁止**：把兜底改为媒体库旧文件或其他任务的录播，除非用户在任务中显式选择。

---

## 六、常见 SSH / 部署问题

**问题：`node deploy.js` SSH 连接失败**

- 检查：`db.js` 里 VPS 凭据是否正确（密码/密钥是否加密存储）
- 检查：`ENCRYPTION_KEY` 在 `.env` 里是否与生产环境一致

**问题：Docker Desktop 未运行，`docker compose` 失败**

- 控制台 Docker 在远程 VPS（107.175.194.202）上，不是本机
- 本机不需要运行 Docker Desktop，通过 `node deploy.js` 部署

---

## 七、历史修复时间线

| 日期 | 修复内容 |
|------|----------|
| 2026-05 | tee muxer 同时推 YouTube 主备服务器 |
| 2026-05 | YouTube 备用 URL 加 `?backup=1` |
| 2026-05 | LIVE_WATCHDOG 阈值 6s → 12s |
| 2026-05 | x264 关键帧 `-g 48 -keyint_min 48` |
| 2026-05 | "转 H.264" base64 脚本修复 shell 引号冲突 |
| 2026-05 | 转码格式显式 `-f mp4` |
