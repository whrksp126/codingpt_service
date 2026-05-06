/**
 * 신규 HTML/CSS/JS 입문 레슨 시드 스크립트 (1회용, 멱등)
 *
 * 사용법:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/seed-new-lessons.js
 *
 * 동작:
 *   - codingpt_app/src/data/{html,css,js}_lesson/*.json 26개를 읽어
 *     Product 3개 + Class 3 + Section 3 + Lesson 26 + Slide 26 + 매핑 레코드를 생성
 *   - 모든 단계 findOrCreate로 멱등성 보장 (재실행해도 중복 생성 X)
 *   - 단일 트랜잭션, 실패 시 rollback
 *   - slide.contents = JSON.lessons[0] 객체 통째 (모바일 LessonContext의 first.sliders 분기 통과)
 */

const fs = require('fs');
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
  StoreCategoryProductMap,
} = require('../models');

const APP_DATA_ROOT = path.resolve(__dirname, '../../../codingpt_app/src/data');

// 과거 AWS S3 → 자체 ObjectStore(MinIO)로 URL 일괄 치환
const URL_OLD_BASE = 'https://s3.ghmate.com/codingpt';
const URL_NEW_BASE = 'https://objectstore.ghmate.com/codingpt';
const rewriteUrls = (obj) =>
  JSON.parse(JSON.stringify(obj).split(URL_OLD_BASE).join(URL_NEW_BASE));

const PRODUCTS = [
  {
    name: 'HTML 입문',
    description: 'HTML의 구조와 시맨틱을 익혀 첫 웹페이지를 만듭니다.',
    category: 'HTML',
    categoryId: 1,
    difficulty: '입문',
    lecture_intro: {
      summary: 'HTML 기본기를 익히는 입문 코스',
      outcomes: ['HTML 문서 구조 이해', '시맨틱 태그 활용', '기본 웹페이지 작성'],
      target: '코딩이 처음인 누구나',
    },
    dir: 'html_lesson',
    files: Array.from({ length: 10 }, (_, i) => `html_${String(i + 1).padStart(2, '0')}.json`),
  },
  {
    name: 'CSS 입문',
    description: 'CSS로 레이아웃과 스타일을 다루는 기초를 다집니다.',
    category: 'CSS',
    categoryId: 2,
    difficulty: '입문',
    lecture_intro: {
      summary: 'CSS 기본 스타일링 입문 코스',
      outcomes: ['선택자/박스모델 이해', 'Flex 레이아웃 구성', '나만의 페이지 디자인'],
      target: 'HTML을 마친 학습자',
    },
    dir: 'css_lesson',
    files: Array.from({ length: 10 }, (_, i) => `css_${String(i + 1).padStart(2, '0')}.json`),
  },
  {
    name: 'JS 입문',
    description: '자바스크립트 기본 문법으로 동작하는 웹을 만듭니다.',
    category: 'JS',
    categoryId: 3,
    difficulty: '입문',
    lecture_intro: {
      summary: 'JavaScript 기본 문법과 DOM 조작 입문 코스',
      outcomes: ['변수/함수/조건문', 'DOM 이벤트 처리', '간단한 인터랙션 구현'],
      target: 'HTML/CSS를 마친 학습자',
    },
    dir: 'js_lesson',
    files: Array.from({ length: 6 }, (_, i) => `js_${String(i + 1).padStart(2, '0')}.json`),
  },
];

async function seedOne(def, t) {
  // 1) Product
  const [product, productCreated] = await Product.findOrCreate({
    where: { name: def.name },
    defaults: {
      description: def.description,
      type: '클래스',
      price: 0,
      lecture_intro: def.lecture_intro,
      category: def.category,
      difficulty: def.difficulty,
      is_active: true,
    },
    transaction: t,
  });

  // 2) StoreCategoryProductMap
  await StoreCategoryProductMap.findOrCreate({
    where: { category_id: def.categoryId, product_id: product.id },
    transaction: t,
  });

  // 3) Class
  const [klass] = await Class.findOrCreate({
    where: { name: def.name },
    defaults: { description: def.description },
    transaction: t,
  });
  await ProductClassMap.findOrCreate({
    where: { product_id: product.id, class_id: klass.id },
    transaction: t,
  });

  // 4) Section
  const sectionName = `${def.name} 기초`;
  const [section] = await Section.findOrCreate({
    where: { name: sectionName, order_no: 1 },
    defaults: { doc_concept: {} },
    transaction: t,
  });
  await ClassSectionMap.findOrCreate({
    where: { class_id: klass.id, section_id: section.id },
    transaction: t,
  });

  // 5) Lesson + Slide (파일별)
  let createdLessons = 0;
  let skippedSlides = 0;
  for (let i = 0; i < def.files.length; i++) {
    const filePath = path.join(APP_DATA_ROOT, def.dir, def.files[i]);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const lessonObj = raw.lessons && raw.lessons[0];
    if (!lessonObj) {
      console.warn(`  ⚠️  skip (no lessons[0]): ${def.files[i]}`);
      continue;
    }

    const orderNo = i + 1;
    const lessonName = lessonObj.title || `Lesson ${orderNo}`;

    const [lesson, lessonCreated] = await Lesson.findOrCreate({
      where: { name: lessonName, order_no: orderNo, type: '이론' },
      defaults: { description: lessonName },
      transaction: t,
    });
    if (lessonCreated) createdLessons += 1;

    await SectionLessonMap.findOrCreate({
      where: { section_id: section.id, lesson_id: lesson.id },
      transaction: t,
    });

    // Slide: 이미 매핑이 있으면 skip (운영 컨텐츠 보호)
    const existingMap = await LessonSlideMap.findOne({
      where: { lesson_id: lesson.id },
      transaction: t,
    });
    if (existingMap) {
      skippedSlides += 1;
      continue;
    }

    const slide = await Slide.create({ contents: rewriteUrls(lessonObj) }, { transaction: t });
    await LessonSlideMap.create(
      { lesson_id: lesson.id, slide_id: slide.id },
      { transaction: t }
    );
  }

  console.log(
    `✓ ${def.name}: product=${product.id}${productCreated ? ' (new)' : ''}, ` +
      `class=${klass.id}, section=${section.id}, ` +
      `lessons=${def.files.length} (newly created=${createdLessons}), ` +
      `slides skipped=${skippedSlides}`
  );
}

async function main() {
  const t = await sequelize.transaction();
  try {
    for (const def of PRODUCTS) {
      await seedOne(def, t);
    }
    await t.commit();
    console.log('🎉 done');
  } catch (e) {
    await t.rollback();
    console.error('❌ rollback:', e);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

main();
