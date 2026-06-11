'use strict';

// 레포 정의에 README.md 내용 보관 — 학습자 계정에 레포 최초 생성 시 시드된다.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('github_repo', 'readme', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('github_repo', 'readme');
  },
};
