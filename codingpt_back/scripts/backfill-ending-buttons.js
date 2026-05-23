/**
 * 엔딩 버튼 모듈 백필 (1회용, 멱등)
 *
 * 활성 Product(is_active=true) 에 소속된 모든 레슨의 마지막 슬라이드(또는 레거시 sliders 배열의 마지막 슬라이더)
 * 마지막 모듈로 actionButtons (다음 레슨 바로가기 / 학습 종료) 를 추가한다.
 *
 * 사용법:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/backfill-ending-buttons.js            # 실제 반영
 *   node scripts/backfill-ending-buttons.js --dry-run  # 변경 없이 대상만 출력
 *
 * 멱등성:
 *   대상 슬라이더의 마지막 모듈이 이미 actionButtons 이고 그 buttons 안에
 *   navigate_next_lesson + end_lesson 두 액션을 모두 포함하면 skip.
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

// 이전에 LessonLearningScreenV5.tsx 에 하드코딩되어 있던 스타일을 그대로 이전.
const ENDING_BUTTONS_MODULE = () => ({
  id: 'endingActions',
  type: 'actionButtons',
  buttons: [
    {
      id: 'next',
      text: '다음 레슨 바로가기',
      role: 'default',
      style: { backgroundColor: '#8B54F7', textColor: '#FFFFFF', shadowColor: '#8B54F7' },
      action: { type: 'navigate_next_lesson' },
    },
    {
      id: 'end',
      text: '학습 종료',
      role: 'default',
      style: { backgroundColor: '#F8F5FF', textColor: '#8B54F7', shadowColor: '#8B54F7' },
      action: { type: 'end_lesson' },
    },
  ],
});

const hasEndingButtons = (modules) => {
  if (!Array.isArray(modules) || modules.length === 0) return false;
  const last = modules[modules.length - 1];
  if (!last || last.type !== 'actionButtons' || !Array.isArray(last.buttons)) return false;
  const types = last.buttons.map((b) => b?.action?.type).filter(Boolean);
  return types.includes('navigate_next_lesson') && types.includes('end_lesson');
};

const appendModule = (modules) => [...(modules || []), ENDING_BUTTONS_MODULE()];

async function run() {
  const products = await Product.findAll({
    where: { is_active: true },
    attributes: ['id', 'name'],
    include: [{
      model: Class, as: 'Classes',
      through: { model: ProductClassMap, attributes: [] },
      attributes: ['id', 'name'],
      include: [{
        model: Section, as: 'Sections',
        through: { model: ClassSectionMap, attributes: [] },
        attributes: ['id', 'name'],
        include: [{
          model: Lesson, as: 'Lessons',
          through: { model: SectionLessonMap, attributes: [] },
          attributes: ['id', 'name'],
        }],
      }],
    }],
  });

  const stats = { lessons: 0, skipped: 0, updated: 0, empty: 0 };

  for (const product of products) {
    for (const klass of product.Classes || []) {
      for (const section of klass.Sections || []) {
        for (const lesson of section.Lessons || []) {
          stats.lessons += 1;

          // 레슨의 슬라이드를 order_no ASC 로 조회 — 마지막이 마지막 슬라이드.
          const maps = await LessonSlideMap.findAll({
            where: { lesson_id: lesson.id },
            order: [['order_no', 'ASC']],
            include: [{ model: Slide }],
          });
          if (maps.length === 0) { stats.empty += 1; continue; }

          const lastMap = maps[maps.length - 1];
          const slide = lastMap.Slide;
          if (!slide) { stats.empty += 1; continue; }

          const contents = slide.contents || {};
          let changed = false;

          if (Array.isArray(contents.sliders) && contents.sliders.length > 0) {
            // 레거시: 한 슬라이드 안에 sliders 배열. 마지막 슬라이더의 modules 에 추가.
            const sliders = contents.sliders;
            const target = sliders[sliders.length - 1];
            const modules = Array.isArray(target.modules) ? target.modules : [];
            if (hasEndingButtons(modules)) {
              stats.skipped += 1;
              continue;
            }
            target.modules = appendModule(modules);
            slide.contents = { ...contents, sliders: [...sliders.slice(0, -1), target] };
            changed = true;
          } else {
            // 신규: 각 슬라이드가 하나의 슬라이더. 이 슬라이드 contents.modules 에 추가.
            const modules = Array.isArray(contents.modules) ? contents.modules : [];
            if (hasEndingButtons(modules)) {
              stats.skipped += 1;
              continue;
            }
            slide.contents = { ...contents, modules: appendModule(modules) };
            changed = true;
          }

          if (!changed) continue;

          console.log(
            `${DRY_RUN ? '[dry-run] ' : ''}lesson #${lesson.id} "${lesson.name}" — slide #${slide.id} 에 endingActions 모듈 추가`,
          );

          if (!DRY_RUN) {
            slide.changed('contents', true);
            await slide.save();
          }
          stats.updated += 1;
        }
      }
    }
  }

  console.log('\n===== Backfill summary =====');
  console.log(`mode      : ${DRY_RUN ? 'DRY-RUN (변경 없음)' : 'APPLIED'}`);
  console.log(`lessons   : ${stats.lessons}`);
  console.log(`updated   : ${stats.updated}`);
  console.log(`skipped   : ${stats.skipped} (이미 엔딩 버튼 있음)`);
  console.log(`empty     : ${stats.empty} (슬라이드 없음)`);
}

run()
  .then(() => sequelize.close())
  .catch((err) => {
    console.error('Backfill failed:', err);
    sequelize.close();
    process.exit(1);
  });
