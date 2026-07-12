'use strict';

// 멀티 기기 모델: 기기 역할(host|controller) 추가.
//  - host: 워크스페이스를 실제로 실행하는 기기(PC 데몬 · 클라우드 러너). 기존 행은 전부 host.
//  - controller: 원격 호스트를 조작만 하는 기기(모바일 앱 등). 향후 모바일 등록 시 사용.
//  runner_kind(local|cloud, 실행 백엔드)와는 다른 축이다.
//  모델: models/daemon-device.js · 설계: docs/multi-device-design.md

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('daemon_device', 'role', {
      type: Sequelize.STRING(16), allowNull: false, defaultValue: 'host',
    });
    await queryInterface.addIndex('daemon_device', ['user_id', 'role']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('daemon_device', ['user_id', 'role']);
    await queryInterface.removeColumn('daemon_device', 'role');
  },
};
