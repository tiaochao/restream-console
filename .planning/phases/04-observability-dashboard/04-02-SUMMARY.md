# 04-02 执行摘要：API Key 健康统计 + 全局错误处理

## 完成时间
2026-05-08

## 修改文件一览

### 1. routes/dashboard.js

**新增 `getSetting` 导入（第 4 行）**
```js
const { getSetting } = require('../db');
```

**新增 `getApiKeyHealth` 函数（第 6–18 行）**
- 合并 `youtube_api_keys`（池）与 `youtube_api_key`（单 key 旧格式）两个设置项
- 去重后统计总数、可用数、配额耗尽数、无效数
- 返回 `{ total, active, quota, invalid }`

**扩展 `getStats` 返回值（第 27–28 行）**
- 第 27 行：`const apiKeyHealth = getApiKeyHealth(userId);`
- 第 28 行：return 中新增 `apiKeyHealth` 字段

### 2. views/partials/stats.ejs

**新增第 5 张统计卡片（第 45–63 行）**
- 标题：API Key 池
- 图标：钥匙 SVG，主色 `#818cf8`（靛蓝）
- 数值：显示 `可用数/总数`，无可用 key 时变红
- 副文本：显示配额耗尽和无效 key 的数量

### 3. server.js

**新增全局 Express 错误处理中间件（第 65–72 行）**
- 4 参数签名 `(err, req, res, next)`，位于 `app.get('/')` 之后、`const PORT` 之前
- 区分 JSON 请求（xhr 或 Accept: application/json）与 HTML 请求
- 生产环境返回通用错误信息，开发环境返回详细堆栈

## 验证结果

三项修改均通过目视代码审查，逻辑结构完整，无语法错误。
（Node.js 命令执行权限受限，改用文件内容审查方式确认）
