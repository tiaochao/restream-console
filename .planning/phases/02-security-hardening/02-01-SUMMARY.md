---
plan: 02-01
status: completed
date: 2026-05-08
---

# 02-01 执行摘要：AES-256-GCM crypto 服务

## 文件修改清单

### services/crypto.js（新建，共 43 行）
- 第 1-5 行：常量定义（ALGO、IV_BYTES、TAG_BYTES、PREFIX）
- 第 7-12 行：`getKey()` — 读取 ENCRYPTION_KEY env var，验证 64 hex char 格式
- 第 14-22 行：`encrypt(plaintext)` — 空值原样返回；随机 IV；返回 `enc:v1:<base64url>` 格式
- 第 24-33 行：`decrypt(ciphertext)` — 无 `enc:v1:` 前缀原样返回；解密失败抛错
- 第 35 行：`module.exports = { encrypt, decrypt }`

### server.js（修改，新增第 20-27 行）
- 第 20 行：读取 `process.env.ENCRYPTION_KEY`
- 第 21-27 行：验证逻辑
  - 生产环境（isProduction）：key 缺失或格式错误 → 抛出 Error，阻止启动
  - 开发环境：key 存在但格式错误 → 打印 `[security]` 警告；key 完全缺失 → 不报错

### .env.example（修改，新增第 7-11 行）
- 第 7 行：空行分隔
- 第 8-10 行：注释说明（用途 + 生成方法 + 生产强制要求）
- 第 11 行：`ENCRYPTION_KEY=your-64-char-hex-key-here`

## 往返测试结果

验证命令（需手动执行，因执行环境无 shell 权限）：

```powershell
cd "F:\008 工具库\YouTube直播转推\restream-console"
$key = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$env:ENCRYPTION_KEY = $key
node -e "const {encrypt,decrypt}=require('./services/crypto'); const ct=encrypt('hello'); console.log(ct.startsWith('enc:v1:')); console.log(decrypt(ct)==='hello'); console.log(decrypt('plaintext')==='plaintext'); process.exit(0)"
# 期望输出：true\ntrue\ntrue
```

验证 server.js 包含 ENCRYPTION_KEY：
```powershell
node -e "const s=require('fs').readFileSync('server.js','utf8'); console.log(s.includes('ENCRYPTION_KEY'))"
# 期望输出：true
```

## 设计决策

- `getKey()` 每次调用时读取 env var，不缓存，允许测试环境动态设置
- `encrypt()` 对空值原样返回，避免加密 null/undefined/''
- `decrypt()` 对无前缀值原样返回（明文过渡期兼容 Phase 02-03 迁移）
- AES-GCM 认证加密：篡改数据在 `decipher.final()` 时抛错，不静默失败
- base64url 编码避免 '+' '/' 字符，方便存入 SQLite TEXT 列
