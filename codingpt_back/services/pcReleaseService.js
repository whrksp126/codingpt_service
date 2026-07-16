/**
 * PC 앱 릴리스 — 자동 업데이트 매니페스트 + 배포물 다운로드 스트림.
 *
 *  저장 위치(objectstore): codingpt/pc-releases/
 *    latest.json                          { version, pub_date, notes, platforms: { "darwin-aarch64": { url, signature } } }
 *    darwin-aarch64/CodingPT_<ver>.app.tar.gz   (Tauri updater 아티팩트)
 *    CodingPT_<ver>_aarch64.dmg / CodingPT.dmg  (수동 설치·다운로드 페이지용 별칭)
 *
 *  objectstore 는 공개 prefix 가 아니므로 다운로드는 back 이 스트리밍 프록시한다(/api/pc/dl/*).
 *  업로드는 codingpt_pc/scripts/release-pc.sh 가 수행.
 */
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const s3Service = require('./s3Service');

const PREFIX = 'codingpt/pc-releases/';
const BUCKET = process.env.OBJECTSTORE_BUCKET || 'codingpt';

async function readLatest() {
  const res = await s3Service.getFileContent(`${PREFIX}latest.json`);
  if (!res.success) return null;
  let content = res.content;
  if (res.encoding === 'base64') content = Buffer.from(content, 'base64').toString('utf-8');
  try { return JSON.parse(content); } catch (_) { return null; }
}

// 단순 semver 비교: a > b 이면 1, 같으면 0, 작으면 -1 (프리릴리스 미사용 전제).
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Tauri updater 응답 — 최신이면 null(=204), 아니면 { version, pub_date, url, signature, notes } */
async function updateManifest(target, arch, currentVersion) {
  const latest = await readLatest();
  if (!latest || !latest.version) return null;
  const key = `${target}-${arch}`; // 예: darwin-aarch64
  const plat = latest.platforms && latest.platforms[key];
  if (!plat || !plat.url || !plat.signature) return null;
  if (cmpVersion(latest.version, currentVersion) <= 0) return null;
  return {
    version: latest.version,
    pub_date: latest.pub_date || new Date().toISOString(),
    url: plat.url,
    signature: plat.signature,
    notes: latest.notes || '',
  };
}

/** 배포물 스트림 — rel 은 pc-releases/ 이하 경로(화이트리스트 검증은 컨트롤러). */
async function streamFile(rel) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + rel });
  const data = await s3Service.s3Client.send(cmd);
  return {
    body: data.Body, // Readable
    contentLength: data.ContentLength,
    contentType: data.ContentType || 'application/octet-stream',
  };
}

module.exports = { updateManifest, streamFile, readLatest, cmpVersion };
