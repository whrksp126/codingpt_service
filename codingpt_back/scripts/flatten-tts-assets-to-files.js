/**
 * 기존 tts_asset(라이브러리 DB, library/{id}/audio.mp3 opaque)를 파일 기반으로 평탄화.
 *   - 오디오를 library/<name>.mp3 로 복사 + library/<name>.json 사이드카 작성
 *   - slide.contents 의 tts:{assetId:id} → {url, timestamps, voiceId, modelId, enabled?} 인라인 치환
 *   - 옛 library/{id}/ 폴더 + tts_asset 행 삭제
 * ObjectStore 브라우저에서 사람이 읽는 파일로 보이게 + 사이드카 규칙(.mp3↔.json) 일치.
 *
 * 사용: cd codingpt_back && set -a && source .env.local && set +a
 *       node scripts/flatten-tts-assets-to-files.js --dry
 *       node scripts/flatten-tts-assets-to-files.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
const {
  S3Client, CopyObjectCommand, PutObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { sequelize, Slide, TTSAsset } = require('../models');

const DRY = process.argv.includes('--dry');
const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';
const PUBLIC_BASE = (process.env.OBJECTSTORE_PUBLIC_BASE_URL || `${process.env.OBJECTSTORE_ENDPOINT}/${BUCKET}`).replace(/\/+$/, '');
const s3 = new S3Client({
  region: process.env.OBJECTSTORE_REGION || 'us-east-1', endpoint: process.env.OBJECTSTORE_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY, secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY },
});
const exists = async (k) => { try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k })); return true; } catch { return false; } };
const sanitize = (s) => String(s || '').replace(/\.mp3$/i, '').replace(/[^가-힣a-zA-Z0-9_\-]/g, '_').slice(0, 100) || 'tts';

async function main() {
  const assets = await TTSAsset.findAll();
  console.log(`▶ tts_asset ${assets.length}건 평탄화${DRY ? ' (DRY)' : ''}`);
  const idToUrl = new Map();

  for (const a of assets) {
    if (!a.object_key) { console.log(`  · skip #${a.id} (object_key 없음)`); continue; }
    const folder = a.folder ? `${a.folder}/` : '';
    let base = sanitize(a.name || a.text);
    let nm = base; let n = 1;
    while (await exists(`tts/static/library/${folder}${nm}.mp3`)) nm = `${base}-${n++}`;
    const newKey = `tts/static/library/${folder}${nm}.mp3`;
    const metaKey = `tts/static/library/${folder}${nm}.json`;
    const newUrl = `${PUBLIC_BASE}/${newKey}`;

    if (DRY) { console.log(`  · #${a.id} ${a.object_key} → ${newKey}`); idToUrl.set(a.id, { newUrl, ts: a.timestamps, v: a.voice_id, m: a.model_id }); continue; }

    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: newKey, CopySource: encodeURI(`/${BUCKET}/${a.object_key}`) }));
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: metaKey, ContentType: 'application/json',
      Body: Buffer.from(JSON.stringify({ text: a.text, voice_id: a.voice_id, model_id: a.model_id, timestamps: a.timestamps, duration: a.duration }, null, 2), 'utf8'),
    }));
    idToUrl.set(a.id, { newUrl, ts: a.timestamps, v: a.voice_id, m: a.model_id });
    console.log(`  · #${a.id} → ${newKey}`);
  }

  // 슬라이드 assetId 참조 → url 인라인 치환
  let rewritten = 0;
  if (!DRY) {
    const slides = await Slide.findAll({ attributes: ['id', 'contents'] });
    for (const s of slides) {
      let changed = false;
      const c = JSON.parse(JSON.stringify(s.contents));
      const visit = (node) => {
        if (node == null || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        const t = node.tts;
        if (t && typeof t === 'object' && t.assetId != null && idToUrl.has(t.assetId)) {
          const info = idToUrl.get(t.assetId);
          const next = { url: info.newUrl };
          if (info.ts) next.timestamps = info.ts;
          if (info.v) next.voiceId = info.v;
          if (info.m) next.modelId = info.m;
          if (t.enabled === false) next.enabled = false;
          node.tts = next;
          changed = true;
        }
        for (const k of Object.keys(node)) visit(node[k]);
      };
      visit(c);
      if (changed) { await Slide.update({ contents: c, updated_at: new Date() }, { where: { id: s.id } }); rewritten++; }
    }

    // 옛 폴더 + DB 행 삭제
    for (const a of assets) {
      if (!a.object_key) continue;
      const prefix = `tts/static/library/${a.id}/`;
      const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      const objs = (l.Contents || []).map((c) => ({ Key: c.Key }));
      if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs } }));
      await a.destroy();
    }
  }

  console.log(`✅ 완료: 자산 ${idToUrl.size}건 평탄화, 슬라이드 ${rewritten}곳 url 인라인 치환`);
  await sequelize.close();
}
main().catch((e) => { console.error('❌', e); process.exit(1); });
