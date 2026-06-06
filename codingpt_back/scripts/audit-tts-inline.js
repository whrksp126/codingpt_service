/**
 * 인라인 TTS / s3.ghmate.com 감사 스크립트 (읽기 전용, 1회용)
 *
 * slide.contents 전수를 제네릭 딥워크로 순회하여:
 *   1. 인라인 tts ({ url, timestamps }) 노드 수집 — 라이브러리 추출 대상
 *   2. tts ({ assetId }) 노드 수집 — 이미 마이그된 참조
 *   3. s3.ghmate.com 을 가리키는 모든 URL 문자열 수집 — objectstore 복제/치환 대상
 *
 * 마이그레이션(extract-inline-tts-to-library, migrate-s3-to-objectstore-objects)의
 * 사전 검증 및 멱등성 확인용. DB/objectstore 를 변경하지 않는다.
 *
 * 사용:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/audit-tts-inline.js
 *
 * 출력:
 *   codingpt_back/scripts/.audit-tts-inline.json
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const { sequelize, Slide } = require('../models');

const OUT_FILE = path.resolve(__dirname, '.audit-tts-inline.json');
const S3_HOST = 's3.ghmate.com';

// 제네릭 딥워크: 위치(lessons/sliders/modules/speeches/result …) 무관하게
// tts 필드를 가진 객체와 s3 URL 문자열을 찾는다.
function walk(node, visit) {
  if (node == null) return;
  if (typeof node === 'string') {
    visit.string(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit);
    return;
  }
  if (typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'tts')) {
      visit.tts(node);
    }
    for (const k of Object.keys(node)) walk(node[k], visit);
  }
}

function textHint(obj) {
  // 인라인 tts 가 달린 객체에서 표시 텍스트 후보 추출 (dedupe/재생성용 힌트)
  const raw = obj.text || obj.content || obj.message || '';
  return String(raw).replace(/<[^>]*>/g, '').trim().slice(0, 300);
}

async function main() {
  const slides = await Slide.findAll({ attributes: ['id', 'contents'] });

  const inlineTts = [];   // { slideId, url, hasTimestamps, textHint }
  const refTts = [];      // { slideId, assetId }
  const emptyTts = [];     // { slideId } count only
  const s3Urls = new Set();
  let s3RefSlides = new Set();

  for (const s of slides) {
    const c = s.contents;
    if (!c) continue;
    walk(c, {
      tts(obj) {
        const t = obj.tts;
        if (t && typeof t === 'object') {
          if (t.assetId != null) {
            refTts.push({ slideId: s.id, assetId: t.assetId });
          } else if (t.url) {
            inlineTts.push({
              slideId: s.id,
              url: t.url,
              hasTimestamps: !!t.timestamps,
              enabled: t.enabled,
              textHint: textHint(obj),
            });
          }
        } else if (t === '' || t == null) {
          emptyTts.push({ slideId: s.id });
        }
      },
      string(str) {
        if (str.includes(S3_HOST)) {
          // URL 토큰만 추출
          const matches = str.match(/https?:\/\/[^\s"'<>)\]]*s3\.ghmate\.com[^\s"'<>)\]]*/g);
          if (matches) {
            for (const m of matches) s3Urls.add(m);
            s3RefSlides.add(s.id);
          } else if (str.includes(S3_HOST)) {
            s3Urls.add(str.slice(0, 300));
            s3RefSlides.add(s.id);
          }
        }
      },
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalSlides: slides.length,
    summary: {
      inlineTtsCount: inlineTts.length,
      refTtsCount: refTts.length,
      emptyTtsCount: emptyTts.length,
      s3UrlCount: s3Urls.size,
      s3RefSlideCount: s3RefSlides.size,
    },
    inlineTts,
    refTts,
    s3Urls: [...s3Urls],
    s3RefSlides: [...s3RefSlides],
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log('▶ 인라인 TTS / s3 감사 완료');
  console.log(`  슬라이드 총 ${slides.length}건`);
  console.log(`  인라인 tts({url}) : ${inlineTts.length}`);
  console.log(`  참조 tts({assetId}): ${refTts.length}`);
  console.log(`  빈 tts(""/null)    : ${emptyTts.length}`);
  console.log(`  s3.ghmate.com URL  : ${s3Urls.size} (슬라이드 ${s3RefSlides.size}건)`);
  console.log(`📄 ${path.relative(process.cwd(), OUT_FILE)}`);

  await sequelize.close();
}

main().catch((err) => {
  console.error('❌ audit 실패:', err);
  process.exit(1);
});
