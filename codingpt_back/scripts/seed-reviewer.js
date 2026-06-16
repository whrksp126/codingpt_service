// 카드사 심사용 ID/PW 계정 시드/갱신.
// 비밀번호는 셸 히스토리/프로세스 목록에 남지 않도록 stdin 으로 입력받는다.
//
// 사용법:
//   set -a && source .env.local && set +a
//   printf '%s' '심사용비밀번호' | REVIEWER_EMAIL=reviewer@codingpt.app node scripts/seed-reviewer.js
//
// (REVIEWER_EMAIL 미지정 시 reviewer@codingpt.app)

require('dotenv').config({ path: process.env.ENV_FILE || '.env.local' });
const { User, sequelize } = require('../models');
const { hashPassword } = require('../utils/password');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    if (process.stdin.isTTY) resolve(''); // TTY 면 입력 없음
  });
}

(async () => {
  const email = process.env.REVIEWER_EMAIL || 'reviewer@codingpt.app';
  const password = (await readStdin()) || process.env.REVIEWER_PASSWORD || '';
  if (!password) {
    console.error('비밀번호가 필요합니다. stdin 또는 REVIEWER_PASSWORD 로 전달하세요.');
    process.exit(1);
  }
  const password_hash = hashPassword(password);
  const now = new Date();
  let user = await User.findOne({ where: { email } });
  if (user) {
    await user.update({ password_hash, login_type: 'local' });
    console.log(`갱신: ${email} (id=${user.id})`);
  } else {
    user = await User.create({
      email, nickname: 'PG심사', google_id: `local-${Date.now()}`,
      password_hash, login_type: 'local', created_at: now,
    });
    console.log(`생성: ${email} (id=${user.id})`);
  }
  await sequelize.close();
  process.exit(0);
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
