'use strict';

// 중앙 관리형 TTS 자산 라이브러리 테이블.
// 슬라이드(slide.contents)의 tts.assetId 가 이 테이블 id 를 참조한다(FK 없음, JSON 참조).
// 오디오/타임스탬프 실파일은 objectstore codingpt/tts/library/{id}/ 아래에 저장.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tts_asset', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      text: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      voice_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      model_id: {
        type: Sequelize.STRING(50),
        allowNull: true,
        defaultValue: 'eleven_v3',
      },
      settings: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      object_key: {
        type: Sequelize.TEXT,
        allowNull: true,
        unique: true,
      },
      duration: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      file_size: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      timestamps: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      content_hash: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('tts_asset', ['content_hash'], {
      name: 'idx_tts_asset_content_hash',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tts_asset');
  },
};
