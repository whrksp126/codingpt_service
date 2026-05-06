'use strict';

/**
 * 과거 AWS S3 기반 URL을 자체 호스팅 ObjectStore(MinIO) URL로 일괄 치환.
 *  - https://s3.ghmate.com/codingpt → https://objectstore.ghmate.com/codingpt
 *  - 영향 컬럼: slide.contents (JSON), myclass_status.results (JSON)
 */
const OLD_BASE = 'https://s3.ghmate.com/codingpt';
const NEW_BASE = 'https://objectstore.ghmate.com/codingpt';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE "slide"
         SET contents = REPLACE(contents::text, :oldBase, :newBase)::json
       WHERE contents::text LIKE :pattern;`,
      { replacements: { oldBase: OLD_BASE, newBase: NEW_BASE, pattern: `%${OLD_BASE}%` } }
    );

    await queryInterface.sequelize.query(
      `UPDATE "myclass_status"
         SET results = REPLACE(results::text, :oldBase, :newBase)::json
       WHERE results IS NOT NULL AND results::text LIKE :pattern;`,
      { replacements: { oldBase: OLD_BASE, newBase: NEW_BASE, pattern: `%${OLD_BASE}%` } }
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE "slide"
         SET contents = REPLACE(contents::text, :newBase, :oldBase)::json
       WHERE contents::text LIKE :pattern;`,
      { replacements: { oldBase: OLD_BASE, newBase: NEW_BASE, pattern: `%${NEW_BASE}%` } }
    );

    await queryInterface.sequelize.query(
      `UPDATE "myclass_status"
         SET results = REPLACE(results::text, :newBase, :oldBase)::json
       WHERE results IS NOT NULL AND results::text LIKE :pattern;`,
      { replacements: { oldBase: OLD_BASE, newBase: NEW_BASE, pattern: `%${NEW_BASE}%` } }
    );
  },
};
