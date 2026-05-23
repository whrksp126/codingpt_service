/**
 * 엔딩 슬라이드의 연속된 actionButton(단일) 모듈들을 actionButtons(복수) 1개로 통합 (1회용, 멱등)
 *
 * 활성 Product 에 속한 모든 레슨의 마지막 슬라이드에서, 모듈 배열의 마지막에
 * 연속된 type='actionButton' 모듈이 2개 이상 있으면 actionButtons 1개로 합친다.
 * 각 버튼의 text/role/icon/style/action/visibility 는 buttons[i] 로 보존.
 *
 * 사용법:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/merge-ending-action-buttons.js            # 실제 반영
 *   node scripts/merge-ending-action-buttons.js --dry-run  # 변경 없이 대상만 출력
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const {
  sequelize,
  Product,
  Class,
  Section,
  Lesson,
  Slide,
  ProductClassMap,
  ClassSectionMap,
  SectionLessonMap,
  LessonSlideMap,
} = require('../models');

const DRY_RUN = process.argv.includes('--dry-run');

const collectTrailingActionButtons = (modules) => {
  const trailing = [];
  for (let i = modules.length - 1; i >= 0; i--) {
    if (modules[i]?.type === 'actionButton') {
      trailing.unshift(modules[i]);
    } else {
      break;
    }
  }
  return trailing;
};

const mergeModules = (modules) => {
  const trailing = collectTrailingActionButtons(modules);
  if (trailing.length < 2) return null;

  const head = modules.slice(0, modules.length - trailing.length);
  const merged = {
    id: 'endingActions',
    type: 'actionButtons',
    buttons: trailing.map((m, i) => ({
      id: m.id != null ? String(m.id) : `btn-${i}`,
      text: m.text,
      role: m.role || 'default',
      icon: m.icon,
      style: m.style,
      action: m.action,
      visibility: m.visibility,
    })),
  };
  return [...head, merged];
};

async function run() {
  const products = await Product.findAll({
    where: { is_active: true },
    attributes: ['id', 'name'],
    include: [{
      model: Class, as: 'Classes',
      through: { model: ProductClassMap, attributes: [] },
      attributes: ['id'],
      include: [{
        model: Section, as: 'Sections',
        through: { model: ClassSectionMap, attributes: [] },
        attributes: ['id'],
        include: [{
          model: Lesson, as: 'Lessons',
          through: { model: SectionLessonMap, attributes: [] },
          attributes: ['id', 'name'],
        }],
      }],
    }],
  });

  const stats = { lessons: 0, merged: 0, skipped: 0 };

  for (const product of products) {
    for (const klass of product.Classes || []) {
      for (const section of klass.Sections || []) {
        for (const lesson of section.Lessons || []) {
          stats.lessons += 1;

          const maps = await LessonSlideMap.findAll({
            where: { lesson_id: lesson.id },
            order: [['order_no', 'ASC']],
            include: [{ model: Slide }],
          });
          if (maps.length === 0) continue;
          const slide = maps[maps.length - 1].Slide;
          if (!slide) continue;

          const contents = slide.contents || {};

          const applyMerge = (modules) => {
            const next = mergeModules(modules || []);
            return next;
          };

          let changed = false;
          if (Array.isArray(contents.sliders) && contents.sliders.length > 0) {
            const sliders = contents.sliders;
            const target = sliders[sliders.length - 1];
            const next = applyMerge(target.modules);
            if (next) {
              target.modules = next;
              slide.contents = { ...contents, sliders: [...sliders.slice(0, -1), target] };
              changed = true;
            }
          } else {
            const next = applyMerge(contents.modules);
            if (next) {
              slide.contents = { ...contents, modules: next };
              changed = true;
            }
          }

          if (!changed) { stats.skipped += 1; continue; }

          console.log(
            `${DRY_RUN ? '[dry-run] ' : ''}lesson #${lesson.id} "${lesson.name}" — slide #${slide.id} 마지막의 연속 actionButton 들을 actionButtons 로 통합`,
          );

          if (!DRY_RUN) {
            slide.changed('contents', true);
            await slide.save();
          }
          stats.merged += 1;
        }
      }
    }
  }

  console.log('\n===== Merge summary =====');
  console.log(`mode    : ${DRY_RUN ? 'DRY-RUN (변경 없음)' : 'APPLIED'}`);
  console.log(`lessons : ${stats.lessons}`);
  console.log(`merged  : ${stats.merged}`);
  console.log(`skipped : ${stats.skipped} (통합 대상 없음)`);
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error('Merge failed:', err);
    sequelize.close();
    process.exit(1);
  });
