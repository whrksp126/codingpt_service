'use strict';

// 폰 알림 라우팅 토글 — push_device.alert_when_pc_active.
//  false(기본) = "PC 를 실제로 쓰는 중이면 이 폰엔 푸시 안 보냄"(present=pc+fresh 시 억제).
//  true        = "PC 사용 중에도 이 폰에 항상 푸시"(사용자가 설정에서 토글을 끈 경우).
//  present=mobile(활성 폰이 인앱으로 봄)·자리비움(present 없음)일 때의 라우팅은 이 값과 무관.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('push_device', 'alert_when_pc_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('push_device', 'alert_when_pc_active');
  },
};
