const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'enc:v1:';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('ENCRYPTION_KEY 未设置或格式错误（需 64 位 hex）');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, enc, tag]);
  return PREFIX + payload.toString('base64url');
}

function decrypt(ciphertext) {
  if (!ciphertext || !String(ciphertext).startsWith(PREFIX)) return ciphertext;
  const key = getKey();
  const payload = Buffer.from(String(ciphertext).slice(PREFIX.length), 'base64url');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const enc = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
