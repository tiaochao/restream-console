# 03-02 SUMMARY：通知渠道配置 UI 和 settings 路由

## 完成内容

### routes/settings.js 修改

- **第 8 行**：新增 `const notifier = require('../services/notifier');`
- **第 53-55 行**：`getCfg()` 返回对象新增三个字段：
  - `notify_webhook_url`（第 53 行）
  - `notify_telegram_token`（第 54 行）
  - `notify_telegram_chat_id`（第 55 行）
- **第 168-181 行**：新增 `POST /notifications` 路由（保存通知配置，含 Webhook URL 格式校验）
- **第 183-190 行**：新增 `POST /test-notify` 路由（调用 `notifier.test()` 发送测试通知）

### views/settings.ejs 修改

- **第 229-269 行**：新增「告警通知」配置卡片，插入位置在原 `<script>` 标签之前。包含：
  - Webhook URL 输入框
  - Telegram Bot Token / Chat ID 双栏输入框
  - 「保存通知配置」表单提交按钮
  - 「发送测试通知」触发 `testNotify()` 的按钮
- **第 491-510 行**：在 `</script>` 前新增 `testNotify()` 异步函数，调用 `POST /settings/test-notify` 端点

## 验证结果

- `routes/settings.js`：结构检查通过，所有路由逻辑完整
- `views/settings.ejs`：包含 `notify_webhook_url` 和 `testNotify` 关键字，修改正确
