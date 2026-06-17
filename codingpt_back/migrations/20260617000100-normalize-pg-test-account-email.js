'use strict';

// PG 심사용 ID/PW 테스트 계정을 유효한 이메일(test@test.com)로 정규화 + 비밀번호 설정.
// 이유: PortOne 빌링키 발급은 customer.email 이 반드시 이메일 형식이어야 함.
//       기존 심사계정 email='testtest' 처럼 비-이메일이면 "customer.email 파라미터가 email 형식이 아닙니다" 에러.
// 비밀번호: test!@34 (scrypt 해시, utils/password.js 포맷). 모든 환경 공통.
// 멱등(idempotent) — 여러 번 실행돼도 안전.

const PW_HASH = 'scrypt$a02ac79406036cd62135715a43951b56$cbc29febe478135eae87ba4f0d545905006eff2b0959c3407dd10f5ff2949df136295ad8ed5af4480202e8224b73fecab7a52dd1761e303a3db945ecc588f848';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    // 1) 기존 비-이메일 심사계정(testtest)을 정규 이메일로 교정 (이미 test@test.com 이 있으면 건너뜀)
    await q.query(
      `UPDATE "user" SET email='test@test.com'
       WHERE email='testtest'
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE email='test@test.com');`
    );
    // 2) 없으면 생성 (login_type='local', google_id 센티넬)
    await q.query(
      `INSERT INTO "user" (email, google_id, nickname, role, password_hash, login_type, created_at)
       SELECT 'test@test.com', 'local-pwtest', 'PG심사', 'user', :hash, 'local', NOW()
       WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE email='test@test.com');`,
      { replacements: { hash: PW_HASH } }
    );
    // 3) 비밀번호/로그인 타입 보장
    await q.query(
      `UPDATE "user" SET password_hash=:hash, login_type='local' WHERE email='test@test.com';`,
      { replacements: { hash: PW_HASH } }
    );
  },

  // 데이터 시드 — 롤백 시 계정을 지우지 않음(다른 데이터 참조 위험). no-op.
  async down() {},
};
