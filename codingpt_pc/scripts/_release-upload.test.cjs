// _release-upload.cjs 머지 로직 유닛테스트 — node --test scripts/_release-upload.test.cjs
//  핵심 계약: ① darwin 만 발행하면 종전(통째 덮어쓰기) 구현과 **동일 바이트**의 latest.json
//            ② 다른 플랫폼 항목은 병합 시 보존된다(멀티플랫폼 스태거 릴리스)
const test = require('node:test');
const assert = require('node:assert');
const { targetSpec, mergeLatest } = require('./_release-upload.cjs');

const DL = 'https://codingpt-back.ghmate.com/api/pc/dl';
const T = '2026-08-10T00:00:00.000Z';

function legacyDarwinLatest(version, notes, signature) {
  // 종전 구현(darwin 하드코딩·통째 덮어쓰기)이 만들던 객체를 그대로 재현한 기준값.
  return {
    version,
    pub_date: T,
    notes: notes || '',
    platforms: {
      'darwin-aarch64': { url: `${DL}/darwin-aarch64/CodingPT_${version}.app.tar.gz`, signature },
    },
  };
}

test('targetSpec — darwin 파일명이 종전 하드코딩과 정확히 일치', () => {
  const s = targetSpec('darwin-aarch64', '0.1.262');
  assert.strictEqual(s.updaterKey, 'darwin-aarch64/CodingPT_0.1.262.app.tar.gz');
  assert.strictEqual(s.installerKey, 'CodingPT_0.1.262_aarch64.dmg');
  assert.strictEqual(s.stableAliasKey, 'CodingPT.dmg');
  assert.strictEqual(s.publicVersionedKey, 'common/downloads/CodingPT-0.1.262-arm64.dmg');
  assert.strictEqual(s.publicStableKey, 'common/downloads/CodingPT.dmg');
  assert.strictEqual(s.installerCT, 'application/x-apple-diskimage');
  assert.strictEqual(s.updaterCT, 'application/gzip');
});

test('targetSpec — windows 별칭 규칙(design.md 계약 6)', () => {
  const s = targetSpec('windows-x86_64', '0.2.0');
  assert.strictEqual(s.platformKey, 'windows-x86_64'); // back 의 ${target}-${arch} 키와 일치
  assert.strictEqual(s.updaterKey, 'windows-x86_64/CodingPT_0.2.0_x64-setup.exe');
  assert.strictEqual(s.stableAliasKey, 'CodingPT.exe');
  assert.strictEqual(s.publicVersionedKey, 'common/downloads/CodingPT-0.2.0-x64.exe');
  assert.strictEqual(s.publicStableKey, 'common/downloads/CodingPT.exe');
  assert.throws(() => targetSpec('linux-x86_64', '1.0.0'), /지원하지 않는 target/);
});

test('mergeLatest — 최초 발행(기존 없음)은 종전 darwin 출력과 바이트 동일', () => {
  const out = mergeLatest(null, {
    version: '0.1.262', notes: '노트', platformKey: 'darwin-aarch64', pubDate: T,
    entry: { url: `${DL}/darwin-aarch64/CodingPT_0.1.262.app.tar.gz`, signature: 'SIG_A' },
  });
  assert.strictEqual(JSON.stringify(out, null, 2),
    JSON.stringify(legacyDarwinLatest('0.1.262', '노트', 'SIG_A'), null, 2));
});

test('mergeLatest — darwin 만 재발행(기존도 darwin 뿐)이면 종전 덮어쓰기와 바이트 동일', () => {
  const existing = legacyDarwinLatest('0.1.261', '옛노트', 'SIG_OLD');
  const out = mergeLatest(existing, {
    version: '0.1.262', notes: '', platformKey: 'darwin-aarch64', pubDate: T,
    entry: { url: `${DL}/darwin-aarch64/CodingPT_0.1.262.app.tar.gz`, signature: 'SIG_A' },
  });
  assert.strictEqual(JSON.stringify(out, null, 2),
    JSON.stringify(legacyDarwinLatest('0.1.262', '', 'SIG_A'), null, 2));
});

test('mergeLatest — windows 발행 시 기존 darwin 항목 보존(스태거 릴리스)', () => {
  const existing = legacyDarwinLatest('0.1.262', 'n', 'SIG_A');
  const out = mergeLatest(existing, {
    version: '0.2.0', notes: 'win 첫 발행', platformKey: 'windows-x86_64', pubDate: T,
    entry: { url: `${DL}/windows-x86_64/CodingPT_0.2.0_x64-setup.exe`, signature: 'SIG_W' },
  });
  assert.deepStrictEqual(Object.keys(out.platforms), ['darwin-aarch64', 'windows-x86_64']);
  assert.strictEqual(out.platforms['darwin-aarch64'].signature, 'SIG_A'); // 무접촉 보존
  assert.strictEqual(out.platforms['windows-x86_64'].url, `${DL}/windows-x86_64/CodingPT_0.2.0_x64-setup.exe`);
  assert.strictEqual(out.version, '0.2.0');
});

test('mergeLatest — 이후 darwin 발행이 windows 항목을 지우지 않는다(구 구현의 통째 덮어쓰기 회귀 방지)', () => {
  const existing = {
    version: '0.2.0', pub_date: T, notes: '',
    platforms: {
      'darwin-aarch64': { url: `${DL}/darwin-aarch64/CodingPT_0.2.0.app.tar.gz`, signature: 'SIG_A' },
      'windows-x86_64': { url: `${DL}/windows-x86_64/CodingPT_0.2.0_x64-setup.exe`, signature: 'SIG_W' },
    },
  };
  const out = mergeLatest(existing, {
    version: '0.2.1', notes: '', platformKey: 'darwin-aarch64', pubDate: T,
    entry: { url: `${DL}/darwin-aarch64/CodingPT_0.2.1.app.tar.gz`, signature: 'SIG_A2' },
  });
  assert.deepStrictEqual(Object.keys(out.platforms), ['darwin-aarch64', 'windows-x86_64']);
  assert.strictEqual(out.platforms['windows-x86_64'].signature, 'SIG_W');
  assert.strictEqual(out.platforms['darwin-aarch64'].signature, 'SIG_A2');
});

test('mergeLatest — 깨진 기존 매니페스트(platforms 비객체)는 신규 발행처럼 취급', () => {
  const out = mergeLatest({ version: 'x', platforms: 'corrupt' }, {
    version: '1.0.0', notes: '', platformKey: 'darwin-aarch64', pubDate: T,
    entry: { url: 'u', signature: 's' },
  });
  assert.deepStrictEqual(Object.keys(out.platforms), ['darwin-aarch64']);
});
