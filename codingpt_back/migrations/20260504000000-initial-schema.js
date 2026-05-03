'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_SQL_PATH = path.join(__dirname, 'sql', '20260504000000-initial-schema.sql');

const TABLES = [
  'tts_saved_files',
  'tts_requests',
  'study_heatmap_log',
  'storecategory_product_map',
  'storecategory',
  'section_lesson_map',
  'product_review_map',
  'product_relatedproduct_map',
  'product_curriculum_map',
  'product_class_map',
  'myclass_status',
  'myclass',
  'lesson_slide_map',
  'curriculum_class_map',
  'curriculum',
  'class_section_map',
  'code_fill_gap',
  'review',
  'slide',
  'lesson',
  'section',
  'class',
  'product',
  'user',
];

module.exports = {
  async up(queryInterface) {
    const sql = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');
    await queryInterface.sequelize.query(sql);
  },

  async down(queryInterface) {
    for (const table of TABLES) {
      await queryInterface.sequelize.query(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
    }
  },
};
