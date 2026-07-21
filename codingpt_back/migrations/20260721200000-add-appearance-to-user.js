'use strict';

/** 모양 설정(계정 전체 동기화) — {uiFont, codeFont, termStyle} JSONB. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'appearance', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user', 'appearance');
  },
};
