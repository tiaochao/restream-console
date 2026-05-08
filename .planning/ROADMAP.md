# Roadmap — restream-console

## Milestone 1.0 — 稳定可信赖的转推平台

**目标**：消灭已知严重 bug，加固安全性，建立可观测性基础，让系统可以放心托管给他人。

**需求覆盖**：BUG-01~04, SEC-01, OBS-01~03, QUA-01~03, FEAT-01

---

### Phase 1: 致命 Bug 修复
**Goal:** 消灭可能导致数据丢失和系统冻结的四个严重缺陷，让系统在多用户场景下可靠运行。
**Mode:** mvp
**Requirements:** BUG-01, BUG-02, BUG-03, BUG-04

**具体任务：**
1. 删除 `db.js` 中的破坏性 DELETE 语句（BUG-01），改为一次性执行的幂等迁移脚本
2. 为 `startTaskQueued` 中每个 SSH 操作加 30s AbortSignal 超时，队列卡死时自动跳过并记录错误（BUG-02）
3. 修复 `live-monitor.js` 第 156 行 `getSetting('monitor_interval')` 补传 `userId` 参数（BUG-03）
4. 将 `buildCommand()` 生成的 bash 脚本改为写出结构化 JSON 状态文件（`/tmp/restream_N.status`），`checkHealth()` 改为解析该 JSON 而非正则匹配日志文本（BUG-04）

**Success Criteria:**
1. 重启应用后，`source_channels` 表中全部频道记录仍然存在，`auto_start`、`auto_vps_id` 等配置不丢失
2. 将一个 VPS 的 SSH 连接故意设为无响应时，其余任务的自动重启在 60s 内正常触发，不被阻塞
3. 创建两个用户并分别配置不同的 `monitor_interval`，两个用户的直播检测以各自频率独立运行
4. 修改 VPS 系统 locale（使 bash 输出为英文），任务健康状态判断仍然准确，不出现 `unknown` 或误判

---

### Phase 2: 安全加固
**Goal:** 为数据库中的敏感凭证加密存储，消除数据库文件泄露带来的全面沦陷风险。
**Mode:** mvp
**Requirements:** SEC-01

**具体任务：**
1. 在 `.env` 中引入 `ENCRYPTION_KEY`（32 字节随机 hex），服务启动时验证其存在
2. 封装 `services/crypto.js`：提供 `encrypt(plaintext)` / `decrypt(ciphertext)` 基于 AES-256-GCM，IV 随机生成并与密文拼接存储
3. 对 `vps.password`、`vps.private_key` 字段和 `settings.douyin_cookies` 值，在写入时加密、读取时解密；编写一次性迁移脚本对现有数据做原地加密
4. 清理 VPS 上的 `/tmp/dy_ck_N.txt` Cookie 临时文件（任务停止时 SSH 执行 `rm -f`），防止 Cookie 明文残留

**Success Criteria:**
1. 用 SQLite 浏览器直接打开 `data/db.sqlite`，`vps.private_key` 和 `settings.douyin_cookies` 字段显示为不可读的加密字符串
2. 任务正常启动、VPS 健康检测正常运行，功能不受加密影响
3. 停止任务后，SSH 进入对应 VPS，确认 `/tmp/dy_ck_*.txt` 文件已被清除
4. 删除或修改 `ENCRYPTION_KEY` 后，应用启动时给出明确的错误提示而非静默崩溃

---

### Phase 3: 可观测性 — 告警与通知
**Goal:** 在任务状态发生关键变更时主动推送告警，让运维者无需盯着界面就能感知异常。
**Mode:** mvp
**Requirements:** OBS-01

**具体任务：**
1. 封装 `services/notifier.js`：支持 Webhook（POST JSON）和 Telegram Bot 两种渠道，渠道配置存储于 `settings` 表
2. 在系统设置页面添加通知渠道配置 UI（Webhook URL / Telegram Bot Token + Chat ID）和"测试发送"按钮
3. 在 `task-manager.js` 的状态机转换节点（掉线、恢复、启动失败、连续重试超过 3 次）调用 `notifier.send()`，附带任务名、状态、时间戳
4. 对通知发送失败做静默降级（记录日志，不影响主流程）

**Success Criteria:**
1. 配置 Webhook URL 后点击"测试发送"，目标地址能收到含 `{"type":"test","service":"restream-console"}` 的 POST 请求
2. 手动停止一个正在运行的 FFmpeg 进程（模拟掉线），Telegram / Webhook 在 60s 内收到包含任务名和状态的告警消息
3. 任务自动重启成功后，收到"已恢复"通知
4. 通知渠道 URL 填写错误时，任务继续正常运行，控制台日志中记录通知发送失败原因

---

### Phase 4: 可观测性 — 数据与仪表盘
**Goal:** 让用户在界面上直接看到任务历史统计和系统整体健康状态，无需登录服务器排查。
**Mode:** mvp
**Requirements:** OBS-02, OBS-03

**具体任务：**
1. 扩展 `task_logs` 表或新增 `task_events` 表，记录每次状态变更（时间戳、旧状态、新状态、触发原因）
2. 在任务详情页内嵌"历史统计"区域：展示累计运行时长、掉线次数、自动重启次数、近 7 天成功率折线图，支持日/周/月筛选
3. 扩展首页 Dashboard：各任务状态卡片总览（running/stalled/error 计数）、YouTube API Key 池健康状态（Key 数量/配额状态）、VPS 在线率
4. 添加全局错误处理中间件（Express 四参数 `(err, req, res, next)`），统一捕获未处理异常，生产环境返回通用错误 JSON，不暴露堆栈

**Success Criteria:**
1. 进入任意任务详情页，能看到该任务最近 30 天的掉线次数和总运行时长
2. 首页 Dashboard 显示实时的"3 个任务运行中 / 1 个出错"类型的状态摘要
3. API Key 池区域标出哪些 Key 处于配额耗尽状态
4. 主动向不存在的路由发送请求，返回 JSON 格式的错误响应，不包含 Node.js 堆栈信息

---

### Phase 5: 代码质量 — 错误处理与测试
**Goal:** 消除静默失败，建立核心模块的安全网，让 bug 可被发现而非被吞掉。
**Mode:** mvp
**Requirements:** QUA-01, QUA-02

**具体任务：**
1. 封装 `utils/log-error.js`：`logError(context, err)` 输出 `[ERROR][context] message stack` 格式，替换全代码库中的裸 `catch(_){}` 和 `catch(e){console.error(e)}`
2. 重点修复 `checkHealth()` 的异常整体吞掉问题（CONCERNS #16），确保任何编程错误都有日志可查
3. 配置 Jest，为 `task-manager.js` 中的 `buildFfmpegArgs`、`classifyApiError`、`taskTargetUrl` 和状态机转换逻辑编写单元测试（使用内存 SQLite，不 mock 数据库）
4. 为 `youtube-monitor.js` 的 `classifyApiError`、key 轮换逻辑编写单元测试

**Success Criteria:**
1. 运行 `npm test`，测试全部通过，覆盖 `buildFfmpegArgs`、`classifyApiError`、状态机转换的主要路径
2. 在 `checkHealth()` 中主动抛出一个 TypeError，控制台日志中出现带上下文的错误记录，任务状态不受影响
3. 全代码库中不再存在 `catch (_) {}` 或 `catch (e) {}` 无日志的静默吞掉模式（通过 `npm run check` 校验）
4. 新增一个故意出错的 API 路由，访问时控制台输出结构化错误日志，响应为 JSON 格式

---

### Phase 6: 代码质量 — 重构与长期可维护性
**Goal:** 拆解过大的核心文件，消除重复代码，降低后续维护和功能扩展的阻力。
**Mode:** mvp
**Requirements:** QUA-03

**具体任务：**
1. 将 `task-manager.js` 中的 FFmpeg 参数生成逻辑（`buildFfmpegArgs`、`buildCommand` 核心部分）抽取为 `services/ffmpeg-args.js`
2. 将 SSH 下发任务、检查进程、读取日志的操作抽取为 `services/task-ssh.js`
3. 将状态机判断和转换（`checkHealth` 的决策逻辑）抽取为 `services/task-state.js`
4. 将 `live-monitor.js` 和 `task-manager.js` 中重复的 `dqEsc`/`shSingleQuote` 工具函数合并到 `utils/shell-escape.js`，删除重复定义

**Success Criteria:**
1. `task-manager.js` 文件行数从 700+ 行降至 350 行以内
2. `npm test` 仍然全部通过（重构不破坏现有测试）
3. 应用启动后，所有已有功能（启动任务、停止任务、健康检测、自动重启）行为不变
4. `live-monitor.js` 和 `task-manager.js` 中不再有重复的 shell 转义函数定义

---

### Phase 7: 新功能 — VPS 自动调度
**Goal:** 创建任务时无需手动选择 VPS，系统自动分配负载最低的可用节点。
**Mode:** mvp
**Requirements:** FEAT-01

**具体任务：**
1. 实现 `services/vps-scheduler.js`：查询各在线 VPS 的当前运行任务数和 VPS 健康检测数据，返回负载最低的节点 ID
2. 在推流码的"默认 VPS"字段新增"自动"选项（`default_vps_id = NULL` 语义复用或新增 `auto_schedule` 标志）
3. 在 `startTask()` 中，当 `task.vps_id` 为空或标记为"自动"时，调用 `vps-scheduler.js` 动态分配
4. 在任务列表中显示当次自动选择的 VPS 名称，并在任务详情中记录"由调度器分配"标注

**Success Criteria:**
1. 创建任务时将"默认 VPS"设为"自动"，任务启动后，任务详情中显示系统自动分配的 VPS 名称
2. 在所有 VPS 均有任务运行时，新任务分配到任务数最少的 VPS
3. 所有 VPS 均离线时，任务启动失败并给出明确提示（"无可用 VPS"），而非崩溃或挂起
4. 手动指定 VPS 的任务不受调度器影响，仍然使用指定节点

---

*Last updated: 2026-05-08*
