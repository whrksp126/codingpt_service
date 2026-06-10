'use strict';

// 학습자 × 클래스 → GitHub 레포 매핑 테이블.
// 클래스 단위로 레포 1개를 생성/재사용하며, 레슨 완료 시 커밋 대상 레포를 식별한다.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_class_repo', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'user', key: 'id' },
        onDelete: 'CASCADE',
      },
      class_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'class', key: 'id' },
        onDelete: 'CASCADE',
      },
      repo_full_name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      default_branch: {
        type: Sequelize.STRING(100),
        allowNull: false,
        defaultValue: 'main',
      },
      html_url: {
        type: Sequelize.TEXT,
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

    await queryInterface.addIndex('user_class_repo', ['user_id', 'class_id'], {
      unique: true,
      name: 'uniq_user_class_repo',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_class_repo');
  },
};
