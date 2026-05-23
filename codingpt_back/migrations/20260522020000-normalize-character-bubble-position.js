'use strict';

// characterSpeechBubble 모듈의 character.image / position 정규화:
//   - teacher_* → image = teacher_profile.png, position = 'right'
//   - student_* → image = student_profile.png, position = 'left'
// 캐릭터를 식별할 수 없거나 character 가 없는 경우는 건드리지 않는다.
// idempotent.

const CHARACTER_BASE_URL = 'https://objectstore.ghmate.com/codingpt/lesson-assets/images';

function detectRole(url) {
  if (typeof url !== 'string') return null;
  if (/\/(teacher_[^/]+)\.png/i.test(url) || /teacher/i.test(url)) return 'teacher';
  if (/\/(student_[^/]+)\.png/i.test(url) || /student/i.test(url)) return 'student';
  return null;
}

const TARGET_BY_ROLE = {
  teacher: { image: `${CHARACTER_BASE_URL}/teacher_profile.png`, position: 'right' },
  student: { image: `${CHARACTER_BASE_URL}/student_profile.png`, position: 'left' },
};

function processModule(m) {
  if (!m || m.type !== 'characterSpeechBubble') return { module: m, changed: false };
  const currentUrl = m.character && m.character.image;
  if (!currentUrl) return { module: m, changed: false };

  const role = detectRole(currentUrl);
  if (!role) return { module: m, changed: false };

  const target = TARGET_BY_ROLE[role];

  const needImageChange = currentUrl !== target.image;
  const needPositionChange = m.position !== target.position;
  if (!needImageChange && !needPositionChange) return { module: m, changed: false };

  return {
    module: {
      ...m,
      character: { ...m.character, image: target.image },
      position: target.position,
    },
    changed: true,
  };
}

function transformContents(contents) {
  if (!contents || !Array.isArray(contents.modules)) return { changed: false, contents };
  let changedAny = false;
  const newModules = contents.modules.map((m) => {
    const { module: next, changed } = processModule(m);
    if (changed) changedAny = true;
    return next;
  });
  if (!changedAny) return { changed: false, contents };
  return { changed: true, contents: { ...contents, modules: newModules } };
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [slides] = await queryInterface.sequelize.query(
      'SELECT id, contents FROM slide WHERE contents IS NOT NULL',
    );

    let converted = 0;
    let skipped = 0;
    for (const slide of slides) {
      const { changed, contents } = transformContents(slide.contents);
      if (!changed) {
        skipped++;
        continue;
      }
      await queryInterface.sequelize.query(
        'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
        { replacements: { id: slide.id, contents: JSON.stringify(contents) } },
      );
      converted++;
    }
    console.log(
      `[normalize-character-bubble-position] inspected=${slides.length} converted=${converted} skipped=${skipped}`,
    );
  },

  async down() {
    throw new Error('비가역적 마이그레이션입니다. 롤백이 필요하면 db/backups/full_*.sql 로 복원하세요.');
  },
};
