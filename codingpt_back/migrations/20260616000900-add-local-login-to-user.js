'use strict';

// 심사용 ID/PW 로그인 지원 — password_hash, login_type 추가.
// 기존 사용자는 login_type='google' 유지(구글 OAuth). password_hash 있는 계정만 로컬 로그인 허용.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'password_hash', { type: Sequelize.STRING(255), allowNull: true });
    await queryInterface.addColumn('user', 'login_type', { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'google' });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user', 'login_type');
    await queryInterface.removeColumn('user', 'password_hash');
  },
};
