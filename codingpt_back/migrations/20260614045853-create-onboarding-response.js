'use strict';

// 온보딩 설문 응답(마케팅 리드) 테이블.
// 로그인 전 익명 수집 → anon_id(기기별 키, unique)로 upsert. 로그인 성공 시 user_id 연결.
// 로그인을 끝내지 않은 응답도 보존되어 추후 관리자단에서 조회 가능.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('onboarding_response', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      anon_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'user', key: 'id' },
        onDelete: 'SET NULL',
      },
      job: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      referral_source: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      ai_experience: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      purposes: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('onboarding_response', ['user_id'], {
      name: 'idx_onboarding_response_user_id',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('onboarding_response');
  },
};
