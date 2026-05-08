# 02-03 凭证加密集成 SUMMARY

## 执行状态：完成

---

## 各文件修改详情

### 1. `routes/vps.js`

**第 7 行（新增）：**
```js
const { encrypt, decrypt } = require('../services/crypto');
```

**第 125-126 行（原明文写入 → 加密写入）：**
```js
// 修改前
input.auth_type === 'password' ? input.password : null,
input.auth_type === 'key' ? input.private_key : null

// 修改后
input.auth_type === 'password' ? encrypt(input.password) : null,
input.auth_type === 'key' ? encrypt(input.private_key) : null
```

---

### 2. `services/ssh.js`

**第 3 行（新增）：**
```js
const { decrypt } = require('./crypto');
```

**第 19-20 行（原明文读取 → 解密后使用）：**
```js
// 修改前
if (vps.auth_type === 'key' && vps.private_key) config.privateKey = vps.private_key;
else config.password = vps.password;

// 修改后
if (vps.auth_type === 'key' && vps.private_key) config.privateKey = decrypt(vps.private_key);
else config.password = decrypt(vps.password);
```

---

### 3. `routes/settings.js`

**第 7 行（新增）：**
```js
const { encrypt, decrypt } = require('../services/crypto');
```

**第 50 行（getCfg 函数中，读取时解密）：**
```js
// 修改前
douyin_cookies: getSetting(userId, 'douyin_cookies') || '',

// 修改后
douyin_cookies: decrypt(getSetting(userId, 'douyin_cookies') || '') || '',
```

**第 116 行（写入时加密）：**
```js
// 修改前
setSetting(req.session.userId, 'douyin_cookies', cookies);

// 修改后
setSetting(req.session.userId, 'douyin_cookies', cookies ? encrypt(cookies) : '');
```

---

### 4. `services/task-manager.js`

**第 7 行（新增）：**
```js
const { decrypt } = require('./crypto');
```

**第 201 行（getDouyinCookies 函数，读取时解密）：**
```js
// 修改前
return getSetting('douyin_cookies', userId) || '';

// 修改后
return decrypt(getSetting('douyin_cookies', userId) || '') || '';
```

---

### 5. `scripts/migrate-encrypt.js`（新建）

一次性幂等迁移脚本，用于将数据库中已有的明文凭证加密存储。

---

## migrate-encrypt.js 使用说明

### 前置条件
必须设置 `ENCRYPTION_KEY` 环境变量（与应用运行时使用的密钥相同）：

```bash
# Windows PowerShell
$env:ENCRYPTION_KEY = "your-32-byte-hex-key-here"
node scripts/migrate-encrypt.js

# Linux / macOS
ENCRYPTION_KEY="your-32-byte-hex-key-here" node scripts/migrate-encrypt.js
```

### 幂等性说明
- 脚本检查每条记录是否已有 `enc:v1:` 前缀
- 已加密的记录会被跳过
- 可安全重复执行，不会重复加密

### 迁移范围
| 表 | 字段 | 说明 |
|---|---|---|
| `vps` | `password` | SSH 密码认证凭证 |
| `vps` | `private_key` | SSH 密钥认证凭证 |
| `settings` | `value`（key='douyin_cookies'） | 抖音 Cookie |

---

## 额外发现的明文凭证读取点

### 已覆盖的读取点
1. `services/ssh.js` → `buildConfig(vps)` — SSH 连接时读取密码/私钥（已加解密）
2. `routes/settings.js` → `getCfg(userId)` — 设置页展示 Cookie（已解密后返回给前端）
3. `services/task-manager.js` → `getDouyinCookies(userId)` — 任务启动时读取 Cookie（已解密）

### 需注意的间接读取点
- `routes/vps.js` 中 `router.post('/:id/test', ...)` 会从数据库取出 VPS 记录，然后传给 `sshService.testConnection(vps)`，该函数内部调用 `buildConfig(vps)` 已覆盖解密，无需额外修改。
- `routes/vps.js` 中 `renderPage` 会把 VPS 列表（含加密后的 password/private_key 字段）渲染到模板。模板仅展示 name/host/port/auth_type，不展示密码字段，无泄漏风险。
- `services/task-manager.js` → `checkAllVpsStatus()` 从数据库取出所有 VPS 后调用 `sshService.testConnection(vps)`，已通过 `buildConfig` 内的 `decrypt` 覆盖。

### 不需要修改的 YouTube API Key
`settings` 表中的 `youtube_api_keys` / `youtube_api_key` 本次未加密。这些是 API Key（非用户密码），且当前版本 Plan 范围仅覆盖 SSH 凭证和抖音 Cookie，API Key 加密可在后续 Phase 中处理。

---

## 验证命令（需在项目根目录执行）

```bash
# 单模块验证
node -e "require('./routes/vps'); console.log('OK')"
node -e "require('./services/ssh'); console.log('OK')"
node -e "require('./routes/settings'); console.log('OK')"
node -e "const tm = require('./services/task-manager'); console.log('OK')"

# 全量验证
node -e "require('./routes/vps'); require('./services/ssh'); require('./routes/settings'); require('./services/task-manager'); console.log('ALL OK'); process.exit(0)"
```
