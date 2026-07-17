'use strict';

/**
 * Apple 로그인 계정의 연동 해제(App Store 5.1.1(v))를 위해 refresh_token 과 client_id 를 저장.
 *  - apple_refresh_token: authorizationCode 교환으로 얻은 refresh_token(탈퇴 시 revoke).
 *  - apple_client_id: 그 토큰이 발급된 client_id(번들ID/ServicesID) — revoke 에 동일 값 필요.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'apple_refresh_token', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('user', 'apple_client_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user', 'apple_refresh_token');
    await queryInterface.removeColumn('user', 'apple_client_id');
  },
};
