// 릴리스 업로드 헬퍼 — release-pc.sh 전용. back 의 aws-sdk 로 objectstore 에 배포물을 올리고
// latest.json 을 발행한다. 웹 DMG는 공개 ObjectStore의 버전별 불변 객체로 직접 제공한다.
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '../../codingpt_back');
const { S3Client, PutObjectCommand } = require(path.join(BACK, 'node_modules/@aws-sdk/client-s3'));

const [version, targz, sig, dmg, notes] = process.argv.slice(2);
if (!version || !targz || !sig || !dmg) { console.error('사용법: _release-upload.js <ver> <tar.gz> <sig> <dmg> [notes]'); process.exit(1); }

const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';
const PREFIX = 'codingpt/pc-releases/';
const DL_BASE = (process.env.PC_RELEASE_DL_BASE || 'https://codingpt-back.ghmate.com/api/pc/dl').replace(/\/$/, '');

const client = new S3Client({
  endpoint: process.env.OBJECTSTORE_ENDPOINT,
  region: process.env.OBJECTSTORE_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY,
    secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY,
  },
});

async function put(key, body, contentType, cacheControl) {
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: PREFIX + key, Body: body, ContentType: contentType,
    ...(cacheControl ? { CacheControl: cacheControl } : {}),
  }));
  console.log('  업로드:', key, typeof body === 'string' ? `${body.length}B` : `${body.length}B`);
}

(async () => {
  const tarName = `darwin-aarch64/CodingPT_${version}.app.tar.gz`;
  const dmgName = `CodingPT_${version}_aarch64.dmg`;
  await put(tarName, fs.readFileSync(targz), 'application/gzip');
  await put(dmgName, fs.readFileSync(dmg), 'application/x-apple-diskimage');
  await put('CodingPT.dmg', fs.readFileSync(dmg), 'application/x-apple-diskimage'); // back 프록시 별칭
  // 공개 URL = https://objectstore.ghmate.com/<bucket>/<key>. 버전별 객체는 내용이 변하지
  // 않으므로 장기 캐시한다. 새 릴리스는 새 key라 이전 CDN 캐시와 충돌하지 않는다.
  const publicDmgKey = `common/downloads/CodingPT-${version}-arm64.dmg`;
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: publicDmgKey,
    Body: fs.readFileSync(dmg), ContentType: 'application/x-apple-diskimage',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  console.log(`  업로드: ${publicDmgKey} (공개·immutable)`);
  const latest = {
    version,
    pub_date: new Date().toISOString(),
    notes: notes || '',
    platforms: {
      'darwin-aarch64': {
        url: `${DL_BASE}/${tarName}`,
        signature: fs.readFileSync(sig, 'utf8').trim(),
      },
    },
  };
  await put('latest.json', JSON.stringify(latest, null, 2), 'application/json');
  console.log('latest.json 발행 —', version);
})().catch((e) => { console.error('업로드 실패:', e.message); process.exit(1); });
