'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = ['class', 'section', 'product'];
    for (const table of tables) {
      await queryInterface.addColumn(table, 'created_at', {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      });
      await queryInterface.addColumn(table, 'updated_at', {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      });
      await queryInterface.sequelize.query(
        `UPDATE "${table}" SET created_at = NOW(), updated_at = NOW();`
      );
    }
  },

  async down(queryInterface) {
    const tables = ['class', 'section', 'product'];
    for (const table of tables) {
      await queryInterface.removeColumn(table, 'created_at');
      await queryInterface.removeColumn(table, 'updated_at');
    }
  },
};
