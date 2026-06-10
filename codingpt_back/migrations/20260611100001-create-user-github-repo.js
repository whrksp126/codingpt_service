'use strict';

// 학습자 × 레포정의 → 실제 GitHub 레포 매핑 테이블.
// 기존 user_class_repo(클래스 종속)를 대체한다.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_github_repo', {
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
      github_repo_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'github_repo', key: 'id' },
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

    await queryInterface.addIndex('user_github_repo', ['user_id', 'github_repo_id'], {
      unique: true,
      name: 'uniq_user_github_repo',
    });

    // 기존 클래스 종속 매핑 테이블 제거 (레포정의 기반으로 대체)
    await queryInterface.dropTable('user_class_repo');
  },

  async down(queryInterface, Sequelize) {
    // 롤백: user_class_repo 재생성 후 user_github_repo 제거
    await queryInterface.createTable('user_class_repo', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      class_id: { type: Sequelize.INTEGER, allowNull: false },
      repo_full_name: { type: Sequelize.STRING(255), allowNull: false },
      default_branch: { type: Sequelize.STRING(100), allowNull: false, defaultValue: 'main' },
      html_url: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.dropTable('user_github_repo');
  },
};
