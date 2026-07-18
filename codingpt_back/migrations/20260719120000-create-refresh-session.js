'use strict';

/**
 * 기기별 refresh 토큰 세션 — refresh 토큰 원문을 저장하지 않고 sha256 해시만 보관하며,
 * 기기(세션)별로 독립 폐기(revoke)할 수 있게 한다.
 *  · 기존 User.refresh_token(단일 컬럼, 평문)은 다기기에서 서로 덮어써 폐기가 불가능했다.
 *  · 이 테이블로 (a) 평문 저장 제거, (b) 세션별 폐기, (c) 회전 시 재사용 감지가 가능해진다.
 *  · 테이블 도입 전에 발급된 토큰은 refresh 시 lazy 로 세션을 생성(대량 로그아웃 방지).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('refresh_session', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      token_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true }, // sha256(refreshToken)
      expires_at: { type: Sequelize.DATE, allowNull: true },   // 토큰 exp
      revoked_at: { type: Sequelize.DATE, allowNull: true },    // 폐기(로그아웃/재사용 감지/기기 해제)
      last_used_at: { type: Sequelize.DATE, allowNull: true },  // 마지막 refresh 사용 시각
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex('refresh_session', ['user_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('refresh_session');
  },
};
