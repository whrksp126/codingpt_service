'use strict';

// TTS 자산을 이미지처럼 폴더로 조직화하기 위한 가상 경로 컬럼.
// 예: '', 'html', 'html/intro'. objectstore 객체 키는 그대로 opaque(id 기반).

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('tts_asset', 'folder', {
      type: Sequelize.STRING(500),
      allowNull: false,
      defaultValue: '',
    });
    await queryInterface.addIndex('tts_asset', ['folder'], { name: 'idx_tts_asset_folder' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tts_asset', 'idx_tts_asset_folder');
    await queryInterface.removeColumn('tts_asset', 'folder');
  },
};
