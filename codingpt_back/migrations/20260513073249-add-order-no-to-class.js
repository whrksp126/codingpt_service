'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('class', 'order_no', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.sequelize.query(
      `UPDATE "class" SET order_no = id;`
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('class', 'order_no');
  },
};
