'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('daemon_devices', 'device_alias', {
      type: Sequelize.STRING(40),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('daemon_devices', 'device_alias');
  },
};
