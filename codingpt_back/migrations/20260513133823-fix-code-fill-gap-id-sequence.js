'use strict';

/**
 * code_fill_gap.id 가 NOT NULL 인데 sequence(default nextval) 가 안 걸려 있어
 * INSERT 시 null violation 으로 PUT /api/lesson/code-fill-gaps/:slideId 가 500 으로 떨어짐.
 * 누락된 sequence 를 만들어 컬럼 DEFAULT 에 연결하고 다음 id 값을 보정한다.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'code_fill_gap_id_seq') THEN
          CREATE SEQUENCE code_fill_gap_id_seq OWNED BY code_fill_gap.id;
        END IF;
      END$$;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE code_fill_gap
        ALTER COLUMN id SET DEFAULT nextval('code_fill_gap_id_seq');
    `);
    await queryInterface.sequelize.query(`
      SELECT setval(
        'code_fill_gap_id_seq',
        COALESCE((SELECT MAX(id) FROM code_fill_gap), 0) + 1,
        false
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE code_fill_gap ALTER COLUMN id DROP DEFAULT;
    `);
    await queryInterface.sequelize.query(`
      DROP SEQUENCE IF EXISTS code_fill_gap_id_seq;
    `);
  },
};
