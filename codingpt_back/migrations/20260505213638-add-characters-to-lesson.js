'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('lesson', 'characters', {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
    });
    await queryInterface.sequelize.query(`
      UPDATE lesson
         SET characters = '["student_full","student_profile","teacher_full","teacher_profile"]'::jsonb
       WHERE published_at IS NOT NULL
    `);
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('lesson', 'characters');
  }
};
