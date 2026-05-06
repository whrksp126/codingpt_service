'use strict';

/**
 * 레슨 이미지 키(예: "html_img", "teacher_full")를 ObjectStore URL로 일괄 치환.
 *
 * 영향 컬럼:
 *   - slide.contents (JSON)
 *
 * 치환 대상 필드: 각 slide.contents 트리에서 키가 image/src/icon인 string value
 * 단, 값이 이미 http(s)://로 시작하면 건드리지 않음.
 *
 * 매핑은 codingpt_app/src/assets/images/<key>.png에 매칭되어 ObjectStore에
 * 업로드된 26개 자산 기준 (scripts/audit-lesson-assets.js + upload-lesson-assets.js).
 */

const OS_BASE = 'https://objectstore.ghmate.com/codingpt/lesson-assets/images';
const KEY_TO_URL = {
  student_full: `${OS_BASE}/student_full.png`,
  teacher_full: `${OS_BASE}/teacher_full.png`,
  html_role_img: `${OS_BASE}/html_role_img.png`,
  html_img: `${OS_BASE}/html_img.png`,
  css_img: `${OS_BASE}/css_img.png`,
  js_img: `${OS_BASE}/js_img.png`,
  html_lesson_02: `${OS_BASE}/html_lesson_02.png`,
  teacher_profile: `${OS_BASE}/teacher_profile.png`,
  html_lesson_03: `${OS_BASE}/html_lesson_03.png`,
  html_lesson_04: `${OS_BASE}/html_lesson_04.png`,
  html_lesson_09: `${OS_BASE}/html_lesson_09.png`,
  html_lesson_09_2: `${OS_BASE}/html_lesson_09_2.png`,
  css_lesson_01: `${OS_BASE}/css_lesson_01.png`,
  css_lesson_02: `${OS_BASE}/css_lesson_02.png`,
  css_lesson_04: `${OS_BASE}/css_lesson_04.png`,
  css_lesson_04_2: `${OS_BASE}/css_lesson_04_2.png`,
  css_lesson_04_3: `${OS_BASE}/css_lesson_04_3.png`,
  css_lesson_07: `${OS_BASE}/css_lesson_07.png`,
  css_lesson_08: `${OS_BASE}/css_lesson_08.png`,
  css_lesson_09_1: `${OS_BASE}/css_lesson_09_1.png`,
  css_lesson_09_2: `${OS_BASE}/css_lesson_09_2.png`,
  student_profile: `${OS_BASE}/student_profile.png`,
  js_lesson_02: `${OS_BASE}/js_lesson_02.png`,
  js_lesson_04_1: `${OS_BASE}/js_lesson_04_1.png`,
  js_lesson_04_2: `${OS_BASE}/js_lesson_04_2.png`,
  js_lesson_05_1: `${OS_BASE}/js_lesson_05_1.png`,
};

const URL_TO_KEY = Object.fromEntries(
  Object.entries(KEY_TO_URL).map(([k, v]) => [v, k]),
);

const TARGET_FIELDS = new Set(['image', 'src', 'icon']);

function transformTree(node, mapping, fields) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = transformTree(node[i], mapping, fields);
    }
    return node;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && fields.has(k) && Object.prototype.hasOwnProperty.call(mapping, v)) {
        node[k] = mapping[v];
      } else {
        node[k] = transformTree(v, mapping, fields);
      }
    }
    return node;
  }
  return node;
}

async function migrate(queryInterface, mapping) {
  const [rows] = await queryInterface.sequelize.query(
    'SELECT id, contents FROM "slide"',
  );
  let updated = 0;
  for (const row of rows) {
    if (!row.contents) continue;
    const cloned = JSON.parse(JSON.stringify(row.contents));
    const transformed = transformTree(cloned, mapping, TARGET_FIELDS);
    if (JSON.stringify(transformed) !== JSON.stringify(row.contents)) {
      await queryInterface.sequelize.query(
        'UPDATE "slide" SET contents = :contents WHERE id = :id',
        {
          replacements: {
            id: row.id,
            contents: JSON.stringify(transformed),
          },
        },
      );
      updated += 1;
    }
  }
  return updated;
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const updated = await migrate(queryInterface, KEY_TO_URL);
    console.log(`[migrate-lesson-image-keys] up: ${updated} slide rows updated`);
  },
  async down(queryInterface) {
    const updated = await migrate(queryInterface, URL_TO_KEY);
    console.log(`[migrate-lesson-image-keys] down: ${updated} slide rows reverted`);
  },
};
