'use strict';

// 학습자별 GitHub OAuth 연동 정보 테이블.
// access_token_enc 는 AES-256-GCM 으로 암호화된 user-to-server 토큰(utils/cryptoToken.js).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_github_connection', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'user', key: 'id' },
        onDelete: 'CASCADE',
      },
      github_user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      github_login: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      access_token_enc: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      scope: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      avatar_url: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      connected_at: {
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
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_github_connection');
  },
};
