'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('product', 'is_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    await queryInterface.sequelize.query(
      `UPDATE "product" SET is_active = false WHERE id IN (1, 3, 5, 6, 8, 9, 10);`
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('product', 'is_active');
  },
};
