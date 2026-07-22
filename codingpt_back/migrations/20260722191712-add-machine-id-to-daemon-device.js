'use strict';

/** daemon_device.machine_id — 물리 머신 영속 식별자(재페어링 시 기기 행 재사용 업서트 키).
 *  재로그인/계정 전환마다 새 device 행이 생겨 워크스페이스 hostDeviceId 가 죽은 기기에
 *  고아로 묶이던(터미널 409 DAEMON_OFFLINE) 문제의 근본 수정. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('daemon_device', 'machine_id', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addIndex('daemon_device', ['machine_id'], { name: 'daemon_device_machine_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('daemon_device', 'daemon_device_machine_id_idx');
    await queryInterface.removeColumn('daemon_device', 'machine_id');
  },
};
