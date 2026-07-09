'use strict';

// M5 Slice1: 데몬 기기에 러너 종류(local|cloud)와 클라우드 러너 수명주기 컬럼 추가.
//  - runner_kind: 'local'(PC 데몬, 기존) | 'cloud'(격리 컨테이너 러너). 기존 행은 전부 local.
//  - container_id: 클라우드 러너의 도커 컨테이너 id(수명주기/정리용). local 은 null.
//  - workspace_id: 클라우드 러너가 바인딩된 워크스페이스(핸드오프 대상). local 은 null.
//  - dormant_at: 동면(scale-to-zero) 시각. 재개 시 null 로 되돌림.
//  모델: models/daemon-device.js

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('daemon_device', 'runner_kind', {
      type: Sequelize.STRING(16), allowNull: false, defaultValue: 'local',
    });
    await queryInterface.addColumn('daemon_device', 'container_id', {
      type: Sequelize.STRING(128), allowNull: true,
    });
    await queryInterface.addColumn('daemon_device', 'workspace_id', {
      type: Sequelize.STRING(64), allowNull: true,
    });
    await queryInterface.addColumn('daemon_device', 'dormant_at', {
      type: Sequelize.DATE, allowNull: true,
    });
    await queryInterface.addIndex('daemon_device', ['user_id', 'runner_kind']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('daemon_device', ['user_id', 'runner_kind']);
    await queryInterface.removeColumn('daemon_device', 'dormant_at');
    await queryInterface.removeColumn('daemon_device', 'workspace_id');
    await queryInterface.removeColumn('daemon_device', 'container_id');
    await queryInterface.removeColumn('daemon_device', 'runner_kind');
  },
};
