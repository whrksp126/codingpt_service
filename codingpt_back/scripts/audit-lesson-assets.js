/**
 * 레슨 자산(이미지) audit 스크립트
 *
 * 활성 Product(HTML/CSS/JS 입문) 3개의 모든 Slide.contents를 walk하여
 * 모듈이 참조하는 이미지 키/URL을 수집하고 다음을 분류한다:
 *   - ✅ 이미 ObjectStore URL
 *   - 🔄 구 s3.ghmate.com URL (URL 치환 필요)
 *   - 🔧 키 형태 (매핑 필요) → 로컬 자산 매칭 후보 검색
 *   - ❓ 알 수 없음 (수동 확인 필요)
 *
 * 사용:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/audit-lesson-assets.js
 *
 * 출력:
 *   - 콘솔 요약
 *   - codingpt_back/scripts/.audit-lesson-assets.json (상세 결과)
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const {
  S3Client,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

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

const TARGET_PRODUCT_NAMES = ['HTML 입문', 'CSS 입문', 'JS 입문'];
const APP_ASSETS_ROOT = path.resolve(__dirname, '../../../codingpt_app/src/assets');
const OBJECTSTORE_BASE = 'https://objectstore.ghmate.com/codingpt';
// Bucket이 이미 'codingpt'이므로 Key에 'codingpt/'를 또 붙이면 이중 prefix가 됨.
// path-style URL https://objectstore.ghmate.com/codingpt/lesson-assets/images/<file>의
// 키 부분만 사용한다.
const LESSON_ASSETS_PREFIX = 'lesson-assets/images';
const ALLOWED_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];

const s3 = new S3Client({
  region: process.env.OBJECTSTORE_REGION || 'us-east-1',
  endpoint: process.env.OBJECTSTORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY,
  },
});
const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';

function walkLocalAssets(rootDir) {
  const found = {};
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!ALLOWED_IMAGE_EXTS.includes(ext)) continue;
        const base = path.basename(entry.name, path.extname(entry.name));
        if (!found[base]) found[base] = [];
        found[base].push({
          absPath: full,
          relPath: path.relative(APP_ASSETS_ROOT, full),
          ext,
        });
      }
    }
  }
  return found;
}

function classifyValue(value) {
  if (typeof value !== 'string') return { kind: 'invalid', value };
  const v = value.trim();
  if (!v) return { kind: 'empty', value };
  if (v.startsWith(OBJECTSTORE_BASE)) return { kind: 'objectstore', value: v };
  if (v.startsWith('https://s3.ghmate.com/')) return { kind: 'old-s3', value: v };
  if (v.startsWith('http://') || v.startsWith('https://')) return { kind: 'external', value: v };
  if (v.startsWith('data:')) return { kind: 'data-uri', value: v };
  if (v.includes('/')) return { kind: 'relative-path', value: v };
  return { kind: 'key', value: v };
}

function extractImgSrcsFromHtml(html) {
  if (typeof html !== 'string') return [];
  const out = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

const PIC_KEY_FIELDS = new Set(['image', 'src', 'icon']);

function walkContents(node, ctx, refs) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkContents(node[i], { ...ctx, pathKey: `${ctx.pathKey}[${i}]` }, refs);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const childPath = ctx.pathKey ? `${ctx.pathKey}.${k}` : k;
      if (typeof v === 'string' && PIC_KEY_FIELDS.has(k)) {
        refs.push({
          slideId: ctx.slideId,
          lessonName: ctx.lessonName,
          productName: ctx.productName,
          field: k,
          path: childPath,
          value: v,
        });
      } else if (k === 'tabs' && Array.isArray(v)) {
        v.forEach((tab, ti) => {
          if (tab && typeof tab.content === 'string') {
            const imgs = extractImgSrcsFromHtml(tab.content);
            imgs.forEach((src, ii) => {
              refs.push({
                slideId: ctx.slideId,
                lessonName: ctx.lessonName,
                productName: ctx.productName,
                field: 'webview-img',
                path: `${childPath}[${ti}].content<img[${ii}]>`,
                value: src,
              });
            });
          }
          walkContents(tab, { ...ctx, pathKey: `${childPath}[${ti}]` }, refs);
        });
      } else {
        walkContents(v, { ...ctx, pathKey: childPath }, refs);
      }
    }
  }
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function loadActiveLessonTree() {
  const products = await Product.findAll({
    where: { name: TARGET_PRODUCT_NAMES, is_active: true },
  });

  const result = [];
  for (const product of products) {
    const classMaps = await ProductClassMap.findAll({ where: { product_id: product.id } });
    const classIds = classMaps.map(m => m.class_id);
    const classes = await Class.findAll({ where: { id: classIds } });

    for (const klass of classes) {
      const sectionMaps = await ClassSectionMap.findAll({ where: { class_id: klass.id } });
      const sectionIds = sectionMaps.map(m => m.section_id);
      const sections = await Section.findAll({ where: { id: sectionIds } });

      for (const section of sections) {
        const lessonMaps = await SectionLessonMap.findAll({ where: { section_id: section.id } });
        const lessonIds = lessonMaps.map(m => m.lesson_id);
        const lessons = await Lesson.findAll({
          where: { id: lessonIds },
          order: [['order_no', 'ASC']],
        });

        for (const lesson of lessons) {
          const slideMaps = await LessonSlideMap.findAll({ where: { lesson_id: lesson.id } });
          const slideIds = slideMaps.map(m => m.slide_id);
          const slides = await Slide.findAll({ where: { id: slideIds } });
          for (const slide of slides) {
            result.push({
              productName: product.name,
              className: klass.name,
              sectionName: section.name,
              lessonName: lesson.name,
              lessonId: lesson.id,
              slideId: slide.id,
              contents: slide.contents,
            });
          }
        }
      }
    }
  }
  return result;
}

async function main() {
  console.log('▶ DB 활성 레슨 트리 로딩...');
  const slides = await loadActiveLessonTree();
  console.log(`  · 슬라이드 ${slides.length}개`);

  console.log('▶ 슬라이드 contents walk → 이미지 참조 수집...');
  const refs = [];
  for (const s of slides) {
    walkContents(
      s.contents,
      { slideId: s.slideId, lessonName: s.lessonName, productName: s.productName, pathKey: '' },
      refs,
    );
  }
  console.log(`  · 참조 ${refs.length}건`);

  console.log('▶ 로컬 assets 인덱싱...');
  const localIndex = walkLocalAssets(APP_ASSETS_ROOT);
  console.log(`  · 로컬 이미지 베이스명 ${Object.keys(localIndex).length}개`);

  // 분류
  const buckets = { objectstore: [], 'old-s3': [], external: [], 'data-uri': [], 'relative-path': [], key: [], empty: [], invalid: [] };
  for (const ref of refs) {
    const c = classifyValue(ref.value);
    buckets[c.kind].push({ ...ref, kind: c.kind });
  }

  // 키 형태 → 로컬 매칭 시도
  const keyMatches = [];
  const keyMissing = [];
  const seenKeys = new Set();
  for (const r of buckets.key) {
    if (seenKeys.has(r.value)) continue;
    seenKeys.add(r.value);
    const candidates = localIndex[r.value];
    if (candidates && candidates.length > 0) {
      keyMatches.push({ key: r.value, candidates });
    } else {
      keyMissing.push({ key: r.value });
    }
  }

  // WebView <img> 상대경로도 키처럼 처리 시도 (filename without ext)
  const seenRel = new Set();
  const relMatches = [];
  const relMissing = [];
  for (const r of buckets['relative-path']) {
    if (seenRel.has(r.value)) continue;
    seenRel.add(r.value);
    const base = path.basename(r.value, path.extname(r.value));
    const candidates = localIndex[base];
    if (candidates && candidates.length > 0) {
      relMatches.push({ relSrc: r.value, base, candidates });
    } else {
      relMissing.push({ relSrc: r.value, base });
    }
  }

  // ObjectStore에 이미 있는 키 확인
  console.log('▶ ObjectStore 존재 여부 체크 (lesson-assets/images/<key>.<ext>)...');
  const existence = {};
  const allKeys = [...keyMatches.map(m => ({ key: m.key, candidates: m.candidates })), ...relMatches.map(m => ({ key: m.base, candidates: m.candidates }))];
  for (const m of allKeys) {
    if (existence[m.key]) continue;
    const checks = {};
    for (const c of m.candidates) {
      const objKey = `${LESSON_ASSETS_PREFIX}/${m.key}.${c.ext}`;
      try {
        const exists = await objectExists(objKey);
        checks[c.ext] = { objKey, exists };
      } catch (e) {
        checks[c.ext] = { objKey, error: e.message };
      }
    }
    existence[m.key] = checks;
  }

  // 요약 출력
  console.log('\n=== AUDIT 요약 ===');
  for (const [kind, list] of Object.entries(buckets)) {
    console.log(`  · ${kind}: ${list.length}건`);
  }
  console.log(`  · 키 매칭됨(로컬 파일 존재): ${keyMatches.length}`);
  console.log(`  · 키 매칭 실패(누락): ${keyMissing.length}`);
  console.log(`  · WebView 상대경로 매칭됨: ${relMatches.length}`);
  console.log(`  · WebView 상대경로 매칭 실패: ${relMissing.length}`);

  if (keyMissing.length > 0) {
    console.log('\n[누락된 키 (로컬에서 못 찾음)]');
    for (const r of keyMissing) console.log(`  - ${r.key}`);
  }
  if (relMissing.length > 0) {
    console.log('\n[WebView 상대경로 누락]');
    for (const r of relMissing) console.log(`  - ${r.relSrc} (base=${r.base})`);
  }

  console.log('\n[키 매칭 결과 + ObjectStore 존재여부]');
  for (const m of keyMatches) {
    const existsParts = Object.entries(existence[m.key] || {}).map(([ext, v]) =>
      v.exists ? `${ext}=✅` : `${ext}=❌`).join(' ');
    console.log(`  - ${m.key}: ${m.candidates.map(c => c.relPath).join(', ')} → ${existsParts}`);
  }
  if (relMatches.length > 0) {
    console.log('\n[WebView 상대경로 매칭 결과]');
    for (const m of relMatches) {
      const existsParts = Object.entries(existence[m.base] || {}).map(([ext, v]) =>
        v.exists ? `${ext}=✅` : `${ext}=❌`).join(' ');
      console.log(`  - ${m.relSrc} (base=${m.base}): ${m.candidates.map(c => c.relPath).join(', ')} → ${existsParts}`);
    }
  }

  // JSON으로 저장
  const outPath = path.resolve(__dirname, '.audit-lesson-assets.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targetProducts: TARGET_PRODUCT_NAMES,
        slideCount: slides.length,
        refsByKind: Object.fromEntries(
          Object.entries(buckets).map(([k, v]) => [k, v.length]),
        ),
        keyMatches,
        keyMissing,
        relMatches,
        relMissing,
        existence,
        allRefs: refs,
      },
      null,
      2,
    ),
  );
  console.log(`\n📄 상세 결과: ${path.relative(process.cwd(), outPath)}`);
}

main()
  .catch(err => {
    console.error('❌ audit 실패:', err);
    process.exit(1);
  })
  .finally(async () => {
    await sequelize.close();
  });
