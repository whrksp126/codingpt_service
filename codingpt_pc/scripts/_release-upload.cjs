// 릴리스 업로드 헬퍼 — release-pc.sh 전용. back 의 aws-sdk 로 objectstore 에 배포물을 올리고
// latest.json 을 발행한다. 웹 설치본은 공개 ObjectStore의 버전별 불변 객체로 직접 제공한다.
//
// 사용법: _release-upload.cjs [--target darwin-aarch64|windows-x86_64] <ver> <updater-artifact> <sig> <installer> [notes]
//   --target 생략 시 darwin-aarch64 (기존 호출 형태와 완전 호환 — darwin 만 발행하면 결과 동일).
//   darwin  : updater-artifact = .app.tar.gz, installer = .dmg
//   windows : updater-artifact = NSIS -setup.exe (tauri v2 는 setup exe 자체가 업데이터 아티팩트),
//             installer 도 같은 exe 를 넘긴다.
//
// latest.json 은 **통째 덮어쓰지 않는다** — 기존 매니페스트를 읽어 platforms 를 병합한다.
//  (darwin 과 windows 는 각자 릴리스 시점이 다를 수 있으므로, 이번 타깃 항목만 갱신하고
//   다른 플랫폼 항목은 보존한다. 주의: 보존된 항목의 url 은 그 플랫폼의 직전 발행 버전을
//   가리킨다 — 양 플랫폼을 같은 버전으로 맞추려면 둘 다 발행해야 한다.)
const fs = require('fs');
const path = require('path');

const PREFIX = 'codingpt/pc-releases/';

// 타깃별 파일명·별칭 규칙 (design.md 계약 6)
//  · pc-releases/<platformKey>/…      : 자동 업데이트 아티팩트(back /api/pc/dl 프록시)
//  · pc-releases/<설치본>·<고정 별칭>  : back 프록시용(CodingPT.dmg / CodingPT.exe 특례)
//  · common/downloads/…               : 공개 다운로드(버전별 immutable + 고정 별칭 no-store)
function targetSpec(target, version) {
  switch (target) {
    case 'darwin-aarch64':
      return {
        platformKey: 'darwin-aarch64',
        updaterKey: `darwin-aarch64/CodingPT_${version}.app.tar.gz`,
        updaterCT: 'application/gzip',
        installerKey: `CodingPT_${version}_aarch64.dmg`,
        stableAliasKey: 'CodingPT.dmg',
        installerCT: 'application/x-apple-diskimage',
        publicVersionedKey: `common/downloads/CodingPT-${version}-arm64.dmg`,
        publicStableKey: 'common/downloads/CodingPT.dmg',
        publicStableFilename: 'CodingPT.dmg',
      };
    case 'windows-x86_64':
      return {
        platformKey: 'windows-x86_64',
        updaterKey: `windows-x86_64/CodingPT_${version}_x64-setup.exe`,
        updaterCT: 'application/x-msdownload',
        installerKey: `CodingPT_${version}_x64-setup.exe`,
        stableAliasKey: 'CodingPT.exe',
        installerCT: 'application/x-msdownload',
        publicVersionedKey: `common/downloads/CodingPT-${version}-x64.exe`,
        publicStableKey: 'common/downloads/CodingPT.exe',
        publicStableFilename: 'CodingPT.exe',
      };
    default:
      throw new Error(`지원하지 않는 target: ${target}`);
  }
}

// 기존 매니페스트(existing, 없으면 null)에 이번 타깃 항목을 병합한 latest.json 객체를 만든다.
//  키 순서는 기존 발행 포맷 그대로(version, pub_date, notes, platforms) — darwin 만 발행하는
//  경우 종전 구현과 동일한 바이트가 나오도록 유지한다(기존 platforms 순서 보존 + 신규는 뒤에).
function mergeLatest(existing, { version, notes, platformKey, entry, pubDate }) {
  const platforms = {};
  const prev = (existing && existing.platforms && typeof existing.platforms === 'object'
    && !Array.isArray(existing.platforms)) ? existing.platforms : {};
  for (const [k, v] of Object.entries(prev)) platforms[k] = v;
  platforms[platformKey] = entry;
  return {
    version,
    pub_date: pubDate || new Date().toISOString(),
    notes: notes || '',
    platforms,
  };
}

async function main() {
  // --target 플래그만 뽑고 나머지는 종전 위치 인자 그대로.
  const argv = process.argv.slice(2);
  let target = 'darwin-aarch64';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') { target = argv[++i] || ''; continue; }
    rest.push(argv[i]);
  }
  const [version, updaterArtifact, sig, installer, notes] = rest;
  if (!version || !updaterArtifact || !sig || !installer) {
    console.error('사용법: _release-upload.cjs [--target darwin-aarch64|windows-x86_64] <ver> <updater-artifact> <sig> <installer> [notes]');
    process.exit(1);
  }
  const spec = targetSpec(target, version);

  const BACK = path.resolve(__dirname, '../../codingpt_back');
  const { S3Client, PutObjectCommand, GetObjectCommand } = require(path.join(BACK, 'node_modules/@aws-sdk/client-s3'));

  const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';
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

  // 기존 latest.json 을 읽는다(병합 재료). 없으면(최초 발행) null.
  async function fetchExisting() {
    try {
      const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + 'latest.json' }));
      const text = await r.Body.transformToString();
      return JSON.parse(text);
    } catch (e) {
      if (e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)) return null;
      // 파싱 실패 등도 신규 발행으로 취급하되 알린다 — 덮어쓰기가 곧 복구다.
      console.warn('  기존 latest.json 읽기 실패(신규로 발행):', e.message);
      return null;
    }
  }

  await put(spec.updaterKey, fs.readFileSync(updaterArtifact), spec.updaterCT);
  await put(spec.installerKey, fs.readFileSync(installer), spec.installerCT);
  await put(spec.stableAliasKey, fs.readFileSync(installer), spec.installerCT); // back 프록시 별칭
  // 공개 URL = https://objectstore.ghmate.com/<bucket>/<key>. 버전별 객체는 내용이 변하지
  // 않으므로 장기 캐시한다. 새 릴리스는 새 key라 이전 CDN 캐시와 충돌하지 않는다.
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: spec.publicVersionedKey,
    Body: fs.readFileSync(installer), ContentType: spec.installerCT,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  console.log(`  업로드: ${spec.publicVersionedKey} (공개·immutable)`);
  // 웹 다운로드 정본 = ObjectStore의 고정 공개 객체. 매 릴리스 같은 key를 최신 설치본으로 교체하므로
  // 브라우저/CDN이 예전 설치본을 붙들지 않게 no-store를 객체 메타데이터에 직접 기록한다.
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: spec.publicStableKey,
    Body: fs.readFileSync(installer), ContentType: spec.installerCT,
    ContentDisposition: `attachment; filename="${spec.publicStableFilename}"`,
    CacheControl: 'no-store, no-cache, must-revalidate',
  }));
  console.log(`  업로드: ${spec.publicStableKey} (공개·최신 별칭·no-store)`);

  const existing = await fetchExisting();
  const latest = mergeLatest(existing, {
    version,
    notes,
    platformKey: spec.platformKey,
    entry: {
      url: `${DL_BASE}/${spec.updaterKey}`,
      signature: fs.readFileSync(sig, 'utf8').trim(),
    },
  });
  await put('latest.json', JSON.stringify(latest, null, 2), 'application/json');
  console.log(`latest.json 발행 — ${version} (${spec.platformKey}${existing ? ', 기존 platforms 병합' : ', 신규'})`);
}

module.exports = { targetSpec, mergeLatest, PREFIX };

if (require.main === module) {
  main().catch((e) => { console.error('업로드 실패:', e.message); process.exit(1); });
}
