'use strict';

// Apple 로그인 지원 — user 테이블에 apple_id(Apple sub) 추가 + google_id 를 nullable 로 완화.
//  Apple 전용 계정은 google_id 가 없으므로 기존 NOT NULL 제약을 풀어야 가입이 가능하다.
//  기존 구글 계정 행은 영향 없음(값 그대로).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'apple_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.changeColumn('user', 'google_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('user', 'apple_id');
    // google_id NOT NULL 복원 전, Apple 전용 계정(널)이 있으면 실패하므로 임시값을 채운다(데이터 유실 방지).
    await queryInterface.sequelize.query(
      "UPDATE \"user\" SET google_id = 'apple:' || id WHERE google_id IS NULL"
    );
    await queryInterface.changeColumn('user', 'google_id', {
      type: Sequelize.STRING,
      allowNull: false,
    });
  }
};
