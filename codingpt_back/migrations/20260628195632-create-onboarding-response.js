'use strict';

// 온보딩 설문 응답(익명) 테이블. anon_id 로 식별/upsert. 모델: models/onboarding-response.js

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('onboarding_response', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      anon_id: { type: Sequelize.STRING(128), allowNull: false, unique: true },
      job: { type: Sequelize.STRING(64), allowNull: true },
      referral_source: { type: Sequelize.STRING(64), allowNull: true },
      ai_experience: { type: Sequelize.STRING(64), allowNull: true },
      purposes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'user', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('onboarding_response', ['user_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('onboarding_response');
  },
};
