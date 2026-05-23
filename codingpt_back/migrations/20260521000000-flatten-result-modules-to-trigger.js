'use strict';

// 모든 slide.contents 의 legacy 결과영역 구조(allResult/correctResult/incorrectResult/result.modules+condition)
// 와 codeRunResult 모듈을 평면 modules + simpleTerminal + trigger.afterGrading 으로 일괄 변환.
//
// 변환 유틸: utils/lessonContentsMigration.transformContents (idempotent)
//
// !! 베이스라인 백업 권장 !!
//   docker exec codingpt_postgres_local pg_dump -U codingpt -d codingpt_db \
//     --no-owner --no-privileges > codingpt_service/db/backups/full_$(date +%Y%m%d).sql
//
// down: 비가역. 롤백 필요 시 백업 SQL 로 복원.

const { transformContents } = require('../utils/lessonContentsMigration');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    const [slides] = await queryInterface.sequelize.query(
      'SELECT id, contents FROM slide WHERE contents IS NOT NULL',
    );

    let changed = 0;
    let skipped = 0;
    for (const slide of slides) {
      const before = slide.contents;
      // PG 에서 JSONB/JSON 컬럼은 이미 JS 객체로 hydrate 됨
      const after = transformContents(before);
      if (JSON.stringify(before) === JSON.stringify(after)) {
        skipped++;
        continue;
      }
      await queryInterface.sequelize.query(
        'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
        {
          replacements: {
            id: slide.id,
            contents: JSON.stringify(after),
          },
        },
      );
      changed++;
    }
    console.log(`[flatten-result-modules] 변환 ${changed} / 스킵 ${skipped} / 총 ${slides.length}`);
  },

  async down (queryInterface, Sequelize) {
    throw new Error(
      '이 마이그레이션은 비가역적입니다. 롤백이 필요하면 db/backups/full_*.sql 로 복원하세요.',
    );
  }
};
