const crypto = require('crypto');

// 백엔드/웹/RN 동일 알고리즘. 16자 prefix로 충돌 가능성 극히 낮음 + 모듈 contents 부피 절약.
const computeCodeHash = (language, code) => {
  const input = `${String(language || '').toLowerCase()}\n${code || ''}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
};

module.exports = { computeCodeHash };
