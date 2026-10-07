// owner-cover — "이 기기에 맞추기" 가림막의 판정을 고정한다.
//
// 이 표시가 조용히 망가지는 방식은 둘이다:
//  ① 내 터미널인데 가림막이 뜬다 — 탭을 바꾼 직후 직전 탭의 소유 상태가 새 탭에 비친다.
//  ② 가림막이 떠야 하는데 채팅 모드·IDE 탭 위에 뜬다(터미널 본문이 화면에 없는데도).
// 화면 모양·포커스·등장 지연은 src/owner-cover-harness.html#selftest 가 실제 DOM 에서 본다.
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };

const { ownerCoverPhase, ownerCoverText, OWNER_COVER_SETTLE_MS } = await import(path.resolve('src/js/owner-cover.js'));
const base = { viewer: true, key: 3, confirmedKey: 3, visible: true, peekKey: null };

ok(ownerCoverPhase(base) === 'cover', '뷰어 + 판정 확정 + 본문 표시 → 가림막');
ok(ownerCoverPhase({ ...base, viewer: false }) === 'hidden', '소유자(또는 주인 없음)면 안 뜬다');
ok(ownerCoverPhase({ ...base, confirmedKey: 2 }) === 'hidden', '탭 전환 직후 — 새 터미널의 판정이 오기 전에는 안 뜬다');
ok(ownerCoverPhase({ ...base, confirmedKey: null }) === 'hidden', '판정을 한 번도 못 받았으면 안 뜬다');
ok(ownerCoverPhase({ ...base, key: null, confirmedKey: null }) === 'hidden', '터미널 탭이 아니면(키 없음) 안 뜬다');
ok(ownerCoverPhase({ ...base, visible: false }) === 'hidden', '터미널 본문이 화면에 없으면(채팅 모드·IDE 탭) 안 뜬다');
ok(ownerCoverPhase({ ...base, peekKey: 3 }) === 'peek', '"그대로 보기"를 고른 터미널은 모서리 버튼만');
ok(ownerCoverPhase({ ...base, peekKey: 2 }) === 'cover', '"그대로 보기"는 그 터미널에만 적용된다');
ok(OWNER_COVER_SETTLE_MS >= 200 && OWNER_COVER_SETTLE_MS <= 600, '등장 지연이 있다(한두 틱 뒤집힘을 삼키되 굼뜨지 않게)');
ok(ownerCoverText('iPad').includes('iPad') && ownerCoverText('') === '다른 기기 크기로 보는 중', '설명 한 줄 — 기기 이름이 있으면 넣는다');

// pane.js 는 표현을 이 모듈에 맡긴다(옛 긴 문구 버튼이 되살아나지 않게).
const pane = fs.readFileSync('src/js/pane.js', 'utf8');
ok(/createOwnerCover\(/.test(pane) && !pane.includes('i18n.t("내 크기로 맞추기")'), 'pane.js 가 owner-cover 를 쓰고 긴 문구 버튼이 없다');
ok(/setOwner\(\{ viewer: !this\._isOwner/.test(pane) && /_syncOwnerCtx\(\)/.test(pane), 'pane.js 가 소유 판정과 맥락(탭·표시)을 넘긴다');

for (const lang of ['ko', 'en', 'ja', 'zh-CN', 'es', 'de', 'fr']) {
  const cat = (await import(path.resolve(`src/js/i18n/${lang}.js`))).default;
  ok(!!cat['이 기기에 맞추기'] && !!cat['그대로 보기'], `${lang} 카탈로그에 새 문구 두 개가 있다`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
