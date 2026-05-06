'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('user', 'heart');
    await queryInterface.removeColumn('user', 'heart_missing');
    await queryInterface.removeColumn('user', 'hearts_refill_started_at');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('user', 'heart', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 5,
    });
    await queryInterface.addColumn('user', 'heart_missing', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('user', 'hearts_refill_started_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
};
