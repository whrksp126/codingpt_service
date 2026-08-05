// emulator-crossimpl — "모바일 화면" pane 이 **실제로 만들어지는지**를 고정한다.
//
// 왜 이 파일이 있나(2026-08-05 실사고): PC 헤더의 [모바일 화면] 버튼을 누르면 **터미널이 하나
//  생겼다.** 오류도 로그도 없었다. 원인은 새 pane 을 만드는 유일한 경로가 kind 를 화이트리스트로
//  받고 있었기 때문이다:
//
//    const node = kind === "preview" || kind === "ide" ? T.leaf(kind, opts) : T.leaf("terminal", …)
//                                                        ^^^^^^^^^^^^^^^^^^^^ emulator 가 여기로 떨어졌다
//
//  이런 화이트리스트는 **새 종류를 더할 때마다 조용히 틀린다** — 기본값이 "터미널"이라 화면에는
//  그럴듯한 것이 뜨고, 사용자만 "왜 터미널이 생기지?" 하게 된다. 그래서 여기서 검사하는 것은
//  개별 종류가 아니라 **불변식**이다: `tiling.leaf()` 가 아는 종류는 `splitPane` 도 알아야 한다.
//
// 좁아서 못 나눌 때 쓰는 혼합 탭 경로도 같은 모양의 화이트리스트였다(emulator → 프리뷰 탭).
import fs from 'node:fs';
import path from 'node:path';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };

// ── 1. tiling 이 아는 pane 종류 ──────────────────────────────────────────────
const tiling = read(path.join(PC, 'tiling.js'));
//  leaf(kind) 가 특별 취급하는 종류(= 터미널이 아닌 것) 전부.
const KINDS = [...tiling.matchAll(/if \(kind === "(\w+)"\) return \{ id: newPaneId\(\)/g)].map((m) => m[1]);
ok(KINDS.length >= 3, `tiling.leaf 가 아는 비터미널 pane 종류 ${KINDS.length}종`, KINDS.join(','));
ok(KINDS.includes('emulator'), 'emulator 가 그중 하나다', KINDS.join(','));

// ── 2. ★ 불변식 — 그 종류를 splitPane 이 전부 알아야 한다 ────────────────────
//  하나라도 빠지면 그 버튼은 **터미널을 만든다**(조용히).
const state = read(path.join(PC, 'state.js'));
const splitBody = state.slice(state.indexOf('export function splitPane'), state.indexOf('export function splitFocused'));
const missing = KINDS.filter((k) => !new RegExp(`kind === "${k}"`).test(splitBody));
ok(missing.length === 0,
  '★ tiling 이 아는 모든 pane 종류를 splitPane 이 만든다(빠지면 조용히 터미널이 생긴다)',
  '누락: ' + missing.join(', '));
ok(/T\.leaf\("terminal"/.test(splitBody), 'splitPane 의 기본값은 여전히 터미널이다(위 검사가 의미를 갖는 이유)');

//  위는 소스 검사라 "그 줄이 있다"까지만 말한다. splitPane 이 실제로 부르는 식을 **그대로 떼어
//  진짜 tiling 모듈에 태워** 결과 노드의 kind 를 확인한다(state.js 는 api.js→Tauri 를 물고 있어
//  통째로 import 할 수 없다 — 그래서 결정식만 가져온다).
const T = await import(path.join(PC, 'tiling.js'));
const decideExpr = /const node = ([\s\S]*?);\n/.exec(splitBody)?.[1];
ok(!!decideExpr, 'splitPane 의 node 결정식을 찾았다');
const decide = new Function('kind', 'opts', 'T', `return (${decideExpr});`);
for (const k of KINDS) {
  const node = decide(k, {}, T);
  ok(node.kind === k, `★ splitPane 결정식에 "${k}" 를 넣으면 실제로 ${k} pane 이 나온다`, `→ ${node.kind}`);
}
ok(decide('terminal', { win: 'new' }, T).kind === 'terminal', '모르는 종류는 여전히 터미널로 떨어진다');

// ── 3. 나눌 자리가 없을 때 — 혼합 탭도 같은 종류를 만들어야 한다 ─────────────
const wsv = read(path.join(PC, 'workspace-view.js'));
const mixedBody = wsv.slice(wsv.indexOf('function mixedTabFor'), wsv.indexOf('export function smartAdd'));
ok(mixedBody.length > 0, '혼합 탭 생성이 한 곳(mixedTabFor)에 모여 있다');
ok(/kind === "emulator"/.test(mixedBody),
  '★ 좁아서 못 나눌 때도 모바일 화면 탭을 만든다(예전엔 프리뷰 탭이 됐다)');
//  smartAdd 안에 옛 인라인 삼항이 되살아나면(두 곳으로 갈라지면) 다시 한쪽만 고쳐진다.
const smartBody = wsv.slice(wsv.indexOf('export function smartAdd'), wsv.indexOf('export function openSurfaces'));
ok(!/kind === "ide"\s*\n?\s*\?\s*\{ kind: "ide"/.test(smartBody),
  'smartAdd 안에 탭 생성 삼항이 다시 인라인되지 않았다');

// ── 4. 만든 탭을 실제로 그리고·치우고·가린다 ─────────────────────────────────
const pane = read(path.join(PC, 'pane.js'));
ok(/tab\.kind === "emulator"/.test(pane) && /new mod\.EmulatorView\(host/.test(pane),
  '혼합 탭 emulator 를 EmulatorView 로 그린다');
ok(/m\.emu\?\.dispose\(\)/.test(pane), '탭을 닫으면 EmulatorView 도 정리한다(프레임 루프 누수 금지)');
ok(/m\.emu\?\.setVisible\(!!on\)/.test(pane),
  '★ 가려진 탭은 프레임을 안 당긴다(한 장이 수십 KB — 안 보이는데 계속 받으면 그 자체가 결함)');
ok(/t\.kind === "emulator" \? icons\.smartphone/.test(pane), '탭 아이콘이 모바일 화면 것이다');

const emu = read(path.join(PC, 'emulator-view.js'));
ok(/setVisible\(on\)/.test(emu) && /!this\.visible/.test(emu),
  'EmulatorView.setVisible 이 루프 조건에 실제로 걸려 있다(메서드만 있고 안 쓰면 무의미)');

// ── 5. 팔레트 "열린 탭" 목록에서 모바일 화면이 터미널로 둔갑하지 않는다 ──────
const surfBody = wsv.slice(wsv.indexOf('export function openSurfaces'), wsv.indexOf('export function activateSurface'));
ok(/leaf\.kind === "emulator"/.test(surfBody), '독립 pane 도 목록에 나온다');
ok(/t\.kind === "emulator" \? "emulator"/.test(surfBody),
  '★ 혼합 탭의 모바일 화면이 "terminal" 로 분류되지 않는다');

// ── 6. 앱도 같은 종류를 안다(한쪽만 고치면 기기마다 다른 것이 열린다) ────────
const appTiling = read(path.join(APP, 'workspace/tiling.ts'));
const appKinds = /export type PaneKind = ([^;]+);/.exec(appTiling)?.[1] || '';
for (const k of KINDS) {
  ok(appKinds.includes(`'${k}'`), `앱 PaneKind 에도 ${k} 가 있다`, appKinds.trim());
}
const appPane = read(path.join(APP, 'workspace/PaneView.tsx'));
ok(/active=\{isActive\}/.test(appPane),
  '앱도 가려진 탭에 프레임을 안 당긴다(EmulatorBody active)');

console.log(`\n${fail === 0 ? 'ALL CONFORMANT' : 'NOT CONFORMANT'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
