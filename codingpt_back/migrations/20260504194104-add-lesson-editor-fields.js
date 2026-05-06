'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('lesson', 'default_character', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addColumn('lesson', 'meta', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: {},
    });
    await queryInterface.addColumn('lesson', 'published_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('lesson', 'created_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });
    await queryInterface.addColumn('lesson', 'updated_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });

    await queryInterface.addColumn('lesson_slide_map', 'order_no', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT lesson_id, slide_id,
               ROW_NUMBER() OVER (PARTITION BY lesson_id ORDER BY slide_id) - 1 AS rn
        FROM lesson_slide_map
      )
      UPDATE lesson_slide_map AS m
      SET order_no = ranked.rn
      FROM ranked
      WHERE m.lesson_id = ranked.lesson_id AND m.slide_id = ranked.slide_id;
    `);

    await queryInterface.addIndex('lesson_slide_map', ['lesson_id', 'order_no'], {
      name: 'idx_lesson_slide_map_lesson_order',
    });

    await queryInterface.addColumn('slide', 'created_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });
    await queryInterface.addColumn('slide', 'updated_at', {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('slide', 'updated_at');
    await queryInterface.removeColumn('slide', 'created_at');
    await queryInterface.removeIndex('lesson_slide_map', 'idx_lesson_slide_map_lesson_order');
    await queryInterface.removeColumn('lesson_slide_map', 'order_no');
    await queryInterface.removeColumn('lesson', 'updated_at');
    await queryInterface.removeColumn('lesson', 'created_at');
    await queryInterface.removeColumn('lesson', 'published_at');
    await queryInterface.removeColumn('lesson', 'meta');
    await queryInterface.removeColumn('lesson', 'default_character');
  },
};
