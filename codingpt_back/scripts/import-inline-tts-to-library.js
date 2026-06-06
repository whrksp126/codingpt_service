/**
 * 기존 인라인 TTS({url, timestamps}) → 중앙 라이브러리(tts_asset) 임포트 + 슬라이드를 assetId 참조로 치환.
 *
 * 대상: slide.contents 안의 인라인 tts 중 objectstore 의 http(s) URL 을 가진 것.
 *   - 같은 URL 은 1개 자산으로 dedupe → 그 URL 을 쓰던 모든 슬라이드를 동일 assetId 로 치환.
 *   - 오디오는 라이브러리 경로(tts/static/library/{id}/audio.mp3)로 복사 + meta.json 생성.
 *   - voice_id/model_id 는 알 수 없으므로 null(레거시). timestamps/duration 은 인라인 값 사용.
 * 제외: local: 번들 참조, s3.ghmate.com(폐기/접근불가), assetId 이미 있는 노드.
 *
 * 사용:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/import-inline-tts-to-library.js --dry   # 미리보기
 *   node scripts/import-inline-tts-to-library.js         # 실제 반영
 *
 * 멱등: 이미 assetId 로 치환된 노드는 건너뜀. URL→assetId 매핑은 tts_asset.object_key 로 추적.
 */

const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const {
  S3Client, CopyObjectCommand, PutObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { sequelize, Slide, TTSAsset, TTSRequest } = require('../models');

const DRY = process.argv.includes('--dry');
const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';
const PUBLIC_BASE = (process.env.OBJECTSTORE_PUBLIC_BASE_URL
  || `${process.env.OBJECTSTORE_ENDPOINT}/${BUCKET}`).replace(/\/+$/, '');

const s3 = new S3Client({
  region: process.env.OBJECTSTORE_REGION || 'us-east-1',
  endpoint: process.env.OBJECTSTORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY,
  },
});

// objectstore 공개 URL → 버킷 내 객체 키 (codingpt/ 접두 제거). 그 외(host 다름)는 null.
const urlToKey = (url) => {
  if (typeof url !== 'string') return null;
  const m = url.match(/objectstore\.ghmate\.com\/codingpt\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
};

const textHint = (node) => String(node.text || node.content || node.message || '')
  .replace(/<[^>]*>/g, '').trim().slice(0, 300);

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function headExists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch (e) { console.warn(`    head err [${key}]: ${e.name} ${e.$metadata?.httpStatusCode || ''}`); return false; }
}

async function main() {
  const slides = await Slide.findAll({ attributes: ['id', 'contents'] });

  // 1) 인라인 tts(url) 수집: url → { text, timestamps } + 등장 슬라이드 집합
  const byUrl = new Map();
  for (const s of slides) {
    const visit = (node) => {
      if (node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const t = node.tts;
      if (t && typeof t === 'object' && !t.assetId && t.url) {
        const key = urlToKey(t.url);
        if (key) { // objectstore http url 만
          if (!byUrl.has(t.url)) byUrl.set(t.url, { key, text: textHint(node), timestamps: t.timestamps || null, slides: new Set() });
          byUrl.get(t.url).slides.add(s.id);
        }
      }
      for (const k of Object.keys(node)) visit(node[k]);
    };
    visit(s.contents);
  }

  console.log(`▶ objectstore 인라인 TTS URL: ${byUrl.size}개${DRY ? ' (DRY)' : ''}`);
  if (byUrl.size === 0) { await sequelize.close(); return; }

  // 2) URL별 자산 생성 + 오디오 복사 → urlToAssetId 매핑
  const urlToAssetId = new Map();
  for (const [url, info] of byUrl) {
    const srcExists = await headExists(info.key);
    if (!srcExists) { console.log(`  · skip(소스 없음) ${info.key}`); continue; }

    // 과거 tts_requests 에서 같은 텍스트(+길이)로 생성된 기록을 찾아 voice/model 복구
    const dur = info.timestamps?.total_duration ?? null;
    let recovered = null;
    if (info.text) {
      const reqs = await TTSRequest.findAll({ where: { text: info.text } });
      recovered = reqs.find((r) => dur != null && r.duration != null && Math.abs(Number(r.duration) - Number(dur)) < 0.02 && r.voice_id)
        || reqs.find((r) => r.voice_id) || null;
    }

    if (DRY) {
      console.log(`  · would-import ${info.key} (슬라이드 ${info.slides.size}곳) text="${info.text.slice(0, 24)}" voice=${recovered?.voice_id || '미상'}`);
      continue;
    }
    const asset = await TTSAsset.create({
      text: info.text || '(레거시 TTS)',
      voice_id: recovered?.voice_id || null,
      model_id: recovered?.model_id || null,
      settings: null,
      timestamps: info.timestamps,
      duration: info.timestamps?.total_duration ?? null,
      content_hash: sha(`legacy|${info.key}`),
      name: (info.text || 'legacy').replace(/[^가-힣a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 100) + '.mp3',
    });
    const audioKey = `tts/static/library/${asset.id}/audio.mp3`;
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: audioKey, CopySource: encodeURI(`/${BUCKET}/${info.key}`),
    }));
    asset.object_key = audioKey;
    await asset.save();
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `tts/static/library/${asset.id}/meta.json`,
      Body: Buffer.from(JSON.stringify({
        id: asset.id, text: asset.text, voice_id: asset.voice_id, model_id: asset.model_id,
        timestamps: asset.timestamps, duration: asset.duration, source: 'legacy-inline', source_key: info.key,
      }, null, 2), 'utf8'),
      ContentType: 'application/json',
    }));
    urlToAssetId.set(url, asset.id);
    console.log(`  · import #${asset.id} ← ${info.key} (슬라이드 ${info.slides.size}곳)`);
  }

  if (DRY) { await sequelize.close(); return; }

  // 3) 슬라이드 인라인 tts(url) → {assetId} 치환
  let rewritten = 0;
  for (const s of slides) {
    let changed = false;
    const contents = JSON.parse(JSON.stringify(s.contents));
    const visit = (node) => {
      if (node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const t = node.tts;
      if (t && typeof t === 'object' && !t.assetId && t.url && urlToAssetId.has(t.url)) {
        const next = { assetId: urlToAssetId.get(t.url) };
        if (t.enabled === false) next.enabled = false;
        node.tts = next;
        changed = true;
      }
      for (const k of Object.keys(node)) visit(node[k]);
    };
    visit(contents);
    if (changed) {
      await Slide.update({ contents, updated_at: new Date() }, { where: { id: s.id } });
      rewritten++;
    }
  }

  console.log(`✅ 완료: 자산 ${urlToAssetId.size}개 생성, 슬라이드 ${rewritten}곳 참조 치환`);
  console.log(`   공개 베이스: ${PUBLIC_BASE}`);
  await sequelize.close();
}

main().catch((err) => { console.error('❌ 실패:', err); process.exit(1); });
