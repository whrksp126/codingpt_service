'use strict';

// 봇(2026-11-27) — 알림 채널을 Orca Bots 식 "상주 담당 에이전트" 로 넓힌다.
//  alert_channel 이 곧 봇이다(테이블 이름은 그대로 — 웹훅 URL·기존 방을 깨지 않는다).
//  · soul/memory   : 봇의 성격·일하는 방식, 오래 기억할 것(봇이 답 안의 표식으로 고친다)
//  · webhook_secret: GitHub/Linear/Sentry/Vercel 서명 검증용(선택)
//  · bot_item      : 할 일 보드(Needs you / 진행 중 / 대기 / 계획 / 완료 / 취소)
//  · bot_automation: 자동화 — 이벤트(알림이 오면 착수) · 스케줄(요일+시각)
module.exports = {
  async up(queryInterface, Sequelize) {
    const add = (col, spec) => queryInterface.addColumn('alert_channel', col, spec);
    await add('soul', { type: Sequelize.TEXT, allowNull: true });
    await add('memory', { type: Sequelize.TEXT, allowNull: true });
    await add('template', { type: Sequelize.STRING(40), allowNull: true });
    await add('webhook_secret', { type: Sequelize.STRING(120), allowNull: true });
    await add('item_seq', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('first_run', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });

    await queryInterface.createTable('bot_item', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      channel_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'alert_channel', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      number: { type: Sequelize.INTEGER, allowNull: false },
      title: { type: Sequelize.STRING(200), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'in_progress' },
      done_means: { type: Sequelize.TEXT, allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      ask: { type: Sequelize.JSONB, allowNull: true },
      notes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      dedupe_key: { type: Sequelize.STRING(120), allowNull: true },
      source_message_id: { type: Sequelize.BIGINT, allowNull: true },
      url: { type: Sequelize.TEXT, allowNull: true },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('bot_item', ['channel_id', 'number'], { unique: true });
    await queryInterface.addIndex('bot_item', ['channel_id', 'status']);

    await queryInterface.createTable('bot_automation', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      channel_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'alert_channel', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'user', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING(80), allowNull: false },
      kind: { type: Sequelize.STRING(12), allowNull: false },          // event | schedule
      schedule: { type: Sequelize.JSONB, allowNull: true },             // { days:[0..6], time:'09:00', tz }
      filter: { type: Sequelize.JSONB, allowNull: true },               // { minLevel, source, provider }
      prompt: { type: Sequelize.TEXT, allowNull: true },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_run_at: { type: Sequelize.DATE, allowNull: true },
      next_run_at: { type: Sequelize.DATE, allowNull: true },
      run_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('bot_automation', ['channel_id']);
    await queryInterface.addIndex('bot_automation', ['enabled', 'next_run_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('bot_automation');
    await queryInterface.dropTable('bot_item');
    for (const c of ['soul', 'memory', 'template', 'webhook_secret', 'item_seq', 'first_run']) {
      await queryInterface.removeColumn('alert_channel', c);
    }
  },
};
