# 03-01 SUMMARY — OBS-01 通知服务 notifier.js

## 创建结果

`services/notifier.js` 创建成功。

## 函数行号

| 函数 | 行号 |
|------|------|
| `send(userId, event)` | 第 49 行（`async function send`） |
| `test(userId)` | 第 62 行（`async function test`） |

## 使用的 Settings Key

| Key 名称 | 用途 |
|----------|------|
| `notify_webhook_url` | Webhook 通知目标 URL |
| `notify_telegram_token` | Telegram Bot Token（加密存储，读取时 decrypt） |
| `notify_telegram_chat_id` | Telegram Chat ID |

## 验证结果

```
node -e "const n = require('./services/notifier'); n.send(null, {type:'test'}).then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1); })"
# 输出：OK
```

`send(null, event)` 传入 null userId 时，所有渠道均跳过（无凭证），Promise 正常 resolve，输出 OK。

## 实现说明

- 双渠道：Webhook（任意 HTTP/HTTPS）+ Telegram Bot API
- Telegram Token 通过 `decrypt()` 解密后使用，安全存储
- 所有网络调用均有 10 秒超时保护，错误降级为 `console.warn`（不阻断主流程）
- `postJson` 使用 Node.js 内置 `http`/`https` 模块，无额外依赖

## 完成时间

2026-05-08
