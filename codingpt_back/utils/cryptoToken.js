const crypto = require('crypto');

// GitHub user-to-server 토큰을 DB에 보관하기 위한 대칭 암호화 유틸.
// AES-256-GCM, 키는 env GITHUB_TOKEN_ENC_KEY (hex 64자 = 32바이트).
// 저장 포맷: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.GITHUB_TOKEN_ENC_KEY;
  if (!hex) {
    throw new Error('GITHUB_TOKEN_ENC_KEY 환경변수가 설정되지 않았습니다.');
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('GITHUB_TOKEN_ENC_KEY 는 hex 64자(32바이트)여야 합니다.');
  }
  return key;
}

function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM 권장 12바이트
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('암호문 포맷이 올바르지 않습니다.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
