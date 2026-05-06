/**
 * 레슨 자산(이미지) ObjectStore 업로드 스크립트
 *
 * audit-lesson-assets.js의 결과 JSON을 읽어 매칭된 로컬 이미지를
 * ObjectStore의 codingpt/lesson-assets/images/<key>.<ext> 경로로 업로드한다.
 *
 * 사용:
 *   cd codingpt_service/codingpt_back
 *   set -a && source .env.local && set +a
 *   node scripts/audit-lesson-assets.js   # 결과 JSON 갱신
 *   node scripts/upload-lesson-assets.js  # 업로드
 *
 * 옵션:
 *   --force   이미 존재해도 덮어쓰기
 *   --dry     실제 업로드 없이 시뮬레이션만
 *
 * 출력:
 *   - 콘솔 진행 상황
 *   - codingpt_back/scripts/.lesson-asset-mapping.json (key → URL 매핑)
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const AUDIT_FILE = path.resolve(__dirname, '.audit-lesson-assets.json');
const MAPPING_FILE = path.resolve(__dirname, '.lesson-asset-mapping.json');
const OBJECTSTORE_BASE = 'https://objectstore.ghmate.com/codingpt';
// Bucket이 이미 'codingpt'이므로 Key에 'codingpt/'를 또 붙이면 이중 prefix가 됨.
const LESSON_ASSETS_PREFIX = 'lesson-assets/images';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const DRY = args.has('--dry');

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

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

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function putFile(key, absPath, contentType) {
  const body = fs.readFileSync(absPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return body.length;
}

async function main() {
  if (!fs.existsSync(AUDIT_FILE)) {
    console.error(`❌ audit 결과 파일이 없습니다: ${AUDIT_FILE}`);
    console.error('   먼저 node scripts/audit-lesson-assets.js를 실행하세요.');
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));

  // 업로드 대상 = key 매칭된 항목 + WebView 상대경로 매칭된 항목
  // 키별로 가장 첫 번째 후보(보통 png) 사용
  const targets = [];
  const addedKeys = new Set();
  for (const m of audit.keyMatches || []) {
    if (addedKeys.has(m.key)) continue;
    addedKeys.add(m.key);
    const c = m.candidates[0];
    targets.push({ key: m.key, ext: c.ext, absPath: c.absPath, relPath: c.relPath });
  }
  for (const m of audit.relMatches || []) {
    if (addedKeys.has(m.base)) continue;
    addedKeys.add(m.base);
    const c = m.candidates[0];
    targets.push({ key: m.base, ext: c.ext, absPath: c.absPath, relPath: c.relPath });
  }

  console.log(`▶ 업로드 대상 ${targets.length}건${DRY ? ' (DRY-RUN)' : ''}${FORCE ? ' (FORCE)' : ''}`);

  const mapping = {};
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of targets) {
    const objKey = `${LESSON_ASSETS_PREFIX}/${t.key}.${t.ext}`;
    const url = `${OBJECTSTORE_BASE}/${objKey}`;
    const contentType = CONTENT_TYPES[t.ext] || 'application/octet-stream';

    try {
      if (!FORCE) {
        const already = await exists(objKey);
        if (already) {
          console.log(`  · skip  ${t.key}.${t.ext} (이미 존재)`);
          mapping[t.key] = { url, objKey, ext: t.ext, source: t.relPath, status: 'exists' };
          skipped++;
          continue;
        }
      }
      if (DRY) {
        console.log(`  · would-upload  ${t.key}.${t.ext} ← ${t.relPath}`);
        mapping[t.key] = { url, objKey, ext: t.ext, source: t.relPath, status: 'dry' };
        uploaded++;
        continue;
      }
      const size = await putFile(objKey, t.absPath, contentType);
      console.log(`  · upload  ${t.key}.${t.ext} ← ${t.relPath} (${size} bytes)`);
      mapping[t.key] = { url, objKey, ext: t.ext, source: t.relPath, status: 'uploaded' };
      uploaded++;
    } catch (e) {
      console.error(`  · FAIL    ${t.key}.${t.ext}: ${e.message}`);
      mapping[t.key] = { url: null, objKey, ext: t.ext, source: t.relPath, status: 'failed', error: e.message };
      failed++;
    }
  }

  fs.writeFileSync(MAPPING_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    objectstoreBase: OBJECTSTORE_BASE,
    prefix: LESSON_ASSETS_PREFIX,
    mapping,
  }, null, 2));

  console.log(`\n✅ 완료: 업로드 ${uploaded}, skip ${skipped}, 실패 ${failed}`);
  console.log(`📄 매핑 파일: ${path.relative(process.cwd(), MAPPING_FILE)}`);
}

main().catch(err => {
  console.error('❌ upload 실패:', err);
  process.exit(1);
});
