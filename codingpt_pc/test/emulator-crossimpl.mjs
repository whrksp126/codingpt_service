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
const T = await import(path.join(PC, 'tiling.js'));
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
const decideExpr = /const node = ([\s\S]*?);\n/.exec(splitBody)?.[1];
ok(!!decideExpr, 'splitPane 의 node 결정식을 찾았다');
const decide = new Function('kind', 'opts', 'T', `return (${decideExpr});`);
for (const k of KINDS) {
  const node = decide(k, {}, T);
  ok(node.kind === k, `★ splitPane 결정식에 "${k}" 를 넣으면 실제로 ${k} pane 이 나온다`, `→ ${node.kind}`);
}
ok(decide('terminal', { win: 'new' }, T).kind === 'terminal', '모르는 종류는 여전히 터미널로 떨어진다');

// ── 3. pane ↔ 탭 변환 — **한 곳**에서, 모든 종류가 왕복해야 한다 ──────────────
//  이 변환이 종류마다 흩어져 있으면 새 종류는 반드시 어딘가에서 누락된다(실제로 emulator 가
//  joinPaneAsTab·mergeAsTabs·moveTabToNewSplit·헤더 라벨에서 **전부** 빠져 있었다 → 모바일 화면
//  pane 을 잡아 끌 수는 있는데 다른 pane 안으로 들어가지지 않았다).
const wsv = read(path.join(PC, 'workspace-view.js'));
ok(Array.isArray(T.TAB_KINDS) && T.TAB_KINDS.length >= 3, `혼합 탭이 될 수 있는 종류 ${T.TAB_KINDS?.length}`);
ok(T.TAB_KINDS.includes('emulator'), '★ 모바일 화면이 그 목록에 있다', String(T.TAB_KINDS));
for (const k of T.TAB_KINDS) {
  const tab = T.leafToTab({ kind: k, id: 'p9' });
  ok(tab && tab.kind === k, `leafToTab: ${k} → 같은 종류의 탭`, JSON.stringify(tab));
  const back = T.tabToLeaf(tab, 'p10');
  ok(back && back.kind === k, `★ tabToLeaf: ${k} 탭 → 다시 ${k} pane(왕복해도 잃는 것이 없다)`, JSON.stringify(back));
}
ok(T.leafToTab({ kind: 'terminal' }) === null, '터미널은 이 경로로 오지 않는다(탭 배열을 이미 갖는다)');

//  변환을 쓰는 자리들이 **자기만의 표를 다시 만들지 않았는지** — 인라인 삼항이 되살아나면
//  또 한쪽만 고쳐진다.
for (const [fn, end] of [
  ['function joinPaneAsTab', 'function mergeAsTabs'],
  ['function mergeAsTabs', 'function movePane'],
  ['async function moveTabToNewSplit', 'function joinPaneAsTab'],
  ['function mixedTabFor', 'export function smartAdd'],
]) {
  const a = wsv.indexOf(fn);
  const body = a < 0 ? '' : wsv.slice(a, wsv.indexOf(end, a) > a ? wsv.indexOf(end, a) : a + 2000);
  ok(a >= 0, `${fn} 이 있다`);
  ok(/T\.(leafToTab|tabToLeaf)/.test(body), `★ ${fn} 이 변환 함수를 쓴다(자기 표를 다시 만들지 않는다)`);
  ok(!/kind: "preview", url:/.test(body), `${fn} 안에 프리뷰 탭 리터럴이 되살아나지 않았다`);
}

//  다른 pane 안으로 들어갈 수 있는가를 손으로 나열하지 않는다.
ok(/T\.TAB_KINDS\.includes\(src\.kind\)/.test(wsv),
  '★ 병합 가능 판정이 종류 목록을 쓴다(예전엔 ide/preview 만 손으로 적혀 있었다)');

//  헤더·드래그 고스트의 이름/아이콘도 한 표에서 온다.
const pane = read(path.join(PC, 'pane.js'));
ok(/export function surfaceLabel/.test(pane) && /kind === "emulator"/.test(pane),
  '★ pane 헤더가 모바일 화면을 "프리뷰" 라고 부르지 않는다');
ok(/surfaceLabel|surfaceIcon/.test(wsv), '드래그 고스트도 같은 표를 쓴다');

// ── 4. 만든 탭을 실제로 그리고·치우고·가린다 ─────────────────────────────────
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

// ── 6. 라이브 영상 — PC 와 앱이 **같은 바이트 계약**을 푼다 ──────────────────
//  폰은 back 릴레이로, PC 는 로컬 WS 로 받지만 **보내는 바이트는 글자 그대로 같다**. 두 경로가
//  다른 모양이면 화면 코드가 두 벌이 되고, 그러면 반드시 한쪽만 고쳐진다.
const appVideo = read(path.join(APP, 'workspace/EmulatorVideo.tsx'));
const pcEmu = read(path.join(PC, 'emulator-view.js'));
for (const [who, src] of [['PC', pcEmu], ['앱', appVideo]]) {
  ok(/avc1\.640028/.test(src), `${who}: 같은 코덱 문자열로 디코더를 연다`);
  ok(/optimizeForLatency/.test(src), `${who}: 지연 우선으로 설정한다(버퍼링하면 조작이 굼떠 보인다)`);
  //  Annex-B 는 첫 IDR 앞에 SPS/PPS 가 있어야 한다 — 이걸 빼면 첫 키프레임을 못 푼다.
  ok(/configBytes/.test(src) && /isKey && configBytes|isKey \? 'key'/.test(src),
    `★ ${who}: config(SPS/PPS)를 첫 키프레임에 붙인다`);
  ok(/flags & 1|FLAG_CONFIG/.test(src) && /flags & 2|FLAG_KEY/.test(src),
    `${who}: 플래그 비트 해석이 같다(1=config · 2=keyframe)`);
  //  키프레임 전의 델타를 디코더에 넣으면 오류가 난다 — 버려야 한다.
  ok(/sawKey|sawKeyFrame/.test(src), `${who}: 첫 키프레임 전의 조각은 버린다`);
}
//  데몬이 그 바이트를 실제로 그렇게 만든다.
const dstream = read(path.resolve('../codingpt_daemon/packages/runner-core/emulator-stream.js'));
ok(/const FLAG_CONFIG = 1;/.test(dstream) && /const FLAG_KEY = 2;/.test(dstream),
  '데몬의 플래그 값이 두 화면과 같다');
ok(/openRelayStream/.test(dstream), '릴레이 경로가 있다(폰·다른 PC)');
ok(/openLanStream/.test(dstream), 'LAN 직결 경로가 있다(같은 Wi-Fi — 실측 릴레이 310~420ms vs 96~109ms)');
//  ★ 세 경로(로컬 웹뷰 WS · 릴레이 WS · LAN 채널)가 **같은 attach() 를 탄다** — 갈라지면 형식이 갈라진다.
const attachBody = dstream.slice(dstream.indexOf('function attach('), dstream.indexOf('function detach('));
ok(/send\(viewer, FLAG_CONFIG/.test(attachBody),
  '★ 새로 붙은 시청자에게 config 를 먼저 준다(없으면 다음 키프레임까지 검은 화면)');
ok(/entry\.clients\.add\(viewer\)/.test(attachBody), '뷰어 집합은 attach 한 곳에서만 늘어난다');
for (const [fn, label] of [['attachWs', '로컬 웹뷰'], ['openRelayStream', '릴레이'], ['openLanStream', 'LAN 직결']]) {
  const start = dstream.indexOf(`function ${fn}(`);
  const body = dstream.slice(start, start + 2200);
  ok(start > 0 && /attach\(entry, viewer\)/.test(body),
    `★ ${label} 시청자도 같은 clients 집합에 들어간다(브로드캐스트 한 벌)`);
}

// ── 7. back 릴레이 배관이 실제로 이어져 있다 ─────────────────────────────────
const BACK = path.resolve('../codingpt_back');
const backApp = read(path.join(BACK, 'app.js'));
const backRelay = read(path.join(BACK, 'services/daemonRelayService.js'));
const backRoutes = read(path.join(BACK, 'routes/daemonRoutes.js'));
ok(/emustream/.test(backApp) && /handleEmulatorStreamUpgrade/.test(backApp),
  '★ back 이 /api/daemon/emustream 업그레이드를 라우팅한다(없으면 폰이 조용히 못 붙는다)');
ok(/router\.post\('\/emulator\/stream'/.test(backRoutes), 'back 에 표 끊는 라우트가 있다');
ok(/openStream\(sess\.userId, 'emu'/.test(backRelay), "back 이 kind='emu' 로 데몬에 지시한다");
const dcontrol = read(path.resolve('../codingpt_daemon/packages/runner-core/control.js'));
ok(/msg\.kind === 'emu'/.test(dcontrol), "★ 데몬이 kind='emu' 를 안다(없으면 '지원하지 않는 스트림 종류')");

// ── 8. 앱도 같은 종류를 안다(한쪽만 고치면 기기마다 다른 것이 열린다) ────────
const appTiling = read(path.join(APP, 'workspace/tiling.ts'));
const appKinds = /export type PaneKind = ([^;]+);/.exec(appTiling)?.[1] || '';
for (const k of KINDS) {
  ok(appKinds.includes(`'${k}'`), `앱 PaneKind 에도 ${k} 가 있다`, appKinds.trim());
}
const appPane = read(path.join(APP, 'workspace/PaneView.tsx'));
ok(/active=\{isActive\}/.test(appPane),
  '앱도 가려진 탭에 프레임을 안 당긴다(EmulatorBody active)');


// ── 9. 드래그는 **끄는 동안** 흘러야 한다(PC·앱 공통) ───────────────────────
// ★ 2026-08-06 (Orca 대조): 예전엔 뗀 뒤에 swipe(시작→끝) 한 방만 보냈다. 그러면 끄는 동안
//  화면이 꿈쩍도 안 하고(사용자가 "미러링이 아니다" 라고 느낀 지점), iOS 제스처 인식기는 그렇게
//  몰아친 입력을 아예 무시하기도 한다. 두 화면이 **같이** 스트리밍이어야 한다 — 한쪽만 고치면
//  PC 에서는 부드럽고 폰에서는 뚝뚝 끊기는, 설명할 수 없는 차이가 생긴다.
const pcView = read(path.join(PC, 'emulator-view.js'));
const appEmu = read(path.join(APP, 'workspace/EmulatorBody.tsx'));
for (const [name, src] of [['PC', pcView], ['앱', appEmu]]) {
  ok(/type:\s*['"]touch['"]/.test(src), `${name} 이 touch 스트리밍을 보낸다`);
  for (const phase of ['begin', 'move', 'end']) {
    ok(new RegExp(`['"]${phase}['"]`).test(src), `${name} 에 ${phase} 단계가 있다`);
  }
  //  구 데몬을 만나면 예전 방식으로 물러설 길이 남아 있어야 한다.
  ok(/type:\s*['"]swipe['"]/.test(src), `${name} 에 레거시 swipe 폴백이 남아 있다`);
}


// ── 10. pane 종류를 손으로 나열한 자리가 없어야 한다 ────────────────────────
// ★ 2026-08-06 실사고(두 번째): 드롭 **처리**는 TAB_KINDS 로 고쳤는데 드롭 **판정/미리보기** 만
//  `ide || preview` 로 남아 있었다. 그래서 모바일 화면 pane 은 탭바에 대도 삽입선이 안 뜨고
//  가장자리 분할로 처리됐다 — "고쳐서 잘 되던 게 갑자기 이상해졌다" 의 정체.
//  종류를 늘릴 때 빠뜨릴 자리가 없게, 나열 자체를 금지한다.
const wsView = read(path.join(PC, 'workspace-view.js'));
const enumLeft = wsView.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /kind === ['"]ide['"]\s*\|\|[^\n]*kind === ['"]preview['"]/.test(l));
ok(enumLeft.length === 0,
  'PC 드래그 판정에 종류를 손으로 나열한 자리가 없다',
  enumLeft.map(([n, l]) => `${n}: ${l.trim()}`).join(' / '));

const appWs = read(path.join(APP, 'workspace/WorkspaceView.tsx'));
const enumLeftApp = appWs.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /kind === ['"]ide['"]\s*\|\|[^\n]*kind === ['"]preview['"]/.test(l));
ok(enumLeftApp.length === 0,
  '앱 드래그 판정에도 종류를 손으로 나열한 자리가 없다',
  enumLeftApp.map(([n, l]) => `${n}: ${l.trim()}`).join(' / '));

// 탭 제목 = 기기명(양쪽) — 탭이 여러 개일 때 어느 게 어느 기기인지 알 수 있어야 한다.
ok(/metaName/.test(read(path.join(PC, 'pane.js'))), 'PC 탭 제목이 기기명(metaName)을 쓴다');
ok(/metaName/.test(read(path.join(APP, 'workspace/PaneView.tsx'))), '앱 탭 제목도 기기명을 쓴다');

// ── 11. 회전 — **두 화면이 같은 규칙**이어야 한다 ───────────────────────────
// ★ 2026-08-06: 회전을 "기기가 받아 줬는지 확인하고 나서" 그리던 앞 설계는, 사용자가 버튼을 처음
//  누르는 자리(아이폰 홈 화면·안드로이드 런처 = 둘 다 세로 고정)에서 **아무 일도 안 일어났다**.
//  이제 두 화면 모두 ① 세로/가로 두 상태를 스스로 들고 ② 보이는 프레임과 다르면 90도 돌려 그리고
//  ③ 좌표도 같은 만큼 되돌린다. 한쪽만 고치면 PC 에서만 도는 버튼이 된다.
for (const [name, src] of [['PC', pcView], ['앱', appEmu]]) {
  ok(/type:\s*['"]rotate['"]/.test(src) && /orientation:\s*!?\w+\s*\?\s*['"]landscape['"]/.test(src),
    `${name} 이 세로/가로를 **절대값**으로 보낸다(한 칸 돌리기가 아니다)`);
  ok(/wantLandscape/.test(src), `${name} 이 원하는 방향 상태를 들고 있다`);
  //  ★ 돌려 그릴 때 여백 계산에 쓰는 비율도 뒤집어야 한다 — 안 뒤집으면 화면 한복판을 눌러도
  //   "기기 밖" 으로 판정돼 조용히 무시된다(2026-08-06 실측으로 잡은 결함).
  ok(/1 \/ raw/.test(src), `${name} 이 돌린 상태의 **보이는 비율**로 여백을 계산한다`);
  ok(/x: (ry|y), y: 1 - (rx|x)/.test(src), `${name} 이 좌표를 같은 만큼 되돌린다`);
  //  회전 버튼은 하나다(좌/우 두 개는 아이콘만 보고 구분이 안 됐다).
  ok(!/rotateLeft|rotateRight/.test(src), `${name} 에 좌/우 회전 버튼이 남아 있지 않다`);
}
//  데몬이 그리라고 알려 주는 목록도 같은 어휘여야 한다(화면은 이 목록만 그린다).
const demu = read(path.resolve('../codingpt_daemon/packages/runner-core/emulator.js'));
ok(/const ANDROID_KEY_ROW = \[[^\]]*'rotate'/.test(demu) && /const IOS_KEY_ROW = \[[^\]]*'rotate'/.test(demu),
  '데몬 키 목록도 회전이 하나다(양 OS)');
ok(/const IOS_KEY_ROW = \[[^\]]*'home'/.test(demu) && /iosIcon/.test(pcView) && /ios \?\s*<House/.test(appEmu),
  '★ 아이폰 홈은 **집** 아이콘이다(안드로이드 ○ 를 돌려쓰지 않는다)');

// ── 12. 손가락은 **그림과 같은 길**로 간다(폰) ─────────────────────────────
// ★ 2026-08-06 실측: 영상은 LAN 직결로 흐르는데 조작만 프로덕션 back 을 왕복(260~490ms)하고 있었다.
//  게이트가 둘로 갈린 게 원인이다 — 영상은 openEmu(링크만 살아 있으면 감), 조작은 rpc(경로 상태기가
//  'lan' 으로 승격돼야 감). 같은 링크 위 같은 화면인데 게이트가 둘이면 언제든 다시 어긋난다.
const appDaemonSvc = read(path.join(APP, 'services/daemonService.ts'));
const appLan = read(path.join(APP, 'services/lanLink.ts'));
ok(/emuRpc/.test(appLan) && /link\.scopes\.includes\('emu'\)/.test(appLan),
  '앱 LAN 에 조작 전용 왕복(emuRpc)이 있고 게이트가 영상과 같다');
ok(/lanLink\.emuRpc<[^>]*>\(host, 'emulator\.input'/.test(appDaemonSvc),
  '★ 앱이 조작을 LAN 직결로 보낸다(서버를 안 지난다)');
ok(!/shouldDirect\(host, 'emu'\)/.test(appDaemonSvc),
  "조작이 경로 상태기 승격(shouldDirect)에 다시 묶이지 않았다");
//  데몬도 같은 등급으로 연다.
ok(/EMU_RPC_ALLOW/.test(read(path.resolve('../codingpt_daemon/packages/runner-core/lan.js'))),
  '데몬이 emulator.input 을 emu 등급으로 연다');

// ── 13. 에이전트가 **띄워 준다** — 세 화면이 같은 명령을 안다 ────────────────
// 2026-08-06 사용자 지적: 프리뷰·IDE·터미널은 에이전트가 사용자가 보고 있는 기기에 띄워 주는데
//  모바일 화면만 빠져 있었다(사용자가 손으로 열어야 했다). 명령 이름이 **네 곳에서 같아야** 한다:
//  cpt CLI → 데몬 라우팅/공개목록 → PC 핸들러 → 앱 핸들러 + 앱의 "내가 할 줄 아는 명령" 신고.
//  하나라도 빠지면 조용히 실패한다 — 서버는 그 명령을 할 줄 아는 화면이 없다고 보고 안 보내거나,
//  보내 놓고 아무 일도 일어나지 않는다.
const pcUi = read(path.join(PC, 'ui-channel.js'));
const appBridge = read(path.join(APP, 'workspace/UiCommandBridge.tsx'));
const appNames = read(path.join(APP, 'workspace/uiCommandNames.ts'));
const dsrv = read(path.resolve('../codingpt_daemon/packages/runner-core/cpt-server.js'));
ok(/case 'ui\.emulatorOpen'/.test(dsrv) && /'ui\.emulatorOpen', 'ui\.emulatorClose'/.test(dsrv),
  '데몬이 ui.emulatorOpen/Close 를 라우팅하고 공개한다');
ok(/emulatorOpen: async/.test(pcUi) && /emulatorClose: async/.test(pcUi), 'PC 가 두 명령을 실행할 줄 안다');
ok(/case 'emulatorOpen'/.test(appBridge) && /case 'emulatorClose'/.test(appBridge), '앱도 실행할 줄 안다');
ok(/'emulatorOpen', 'emulatorClose'/.test(appNames),
  "★ 앱이 그 능력을 **신고**한다(신고 안 하면 서버가 폰을 고르고도 안 보낸다)");
//  이미 열려 있으면 또 만들지 않고 그 표면의 기기만 바꾼다 — 양쪽 같은 규칙.
ok(/findEmulatorTarget/.test(pcUi), 'PC 가 이미 열린 모바일 화면을 찾는다');
ok(/findEmulator\(/.test(appBridge), '앱도 이미 열린 모바일 화면을 찾는다');
ok(/PANE_TYPES = \["terminal", "ide", "preview", "emulator"\]/.test(pcUi),
  'PC 의 pane 종류 목록에 모바일 화면이 들어 있다(layout split --type emulator)');
ok(/type === 'emulator'/.test(appBridge), '앱의 pane 생성기도 모바일 화면을 만들 줄 안다');
//  회신·조회에도 **어느 기기인지**가 실려야 한다(2026-08-06 실측으로 잡음):
//   · PC 핸들러가 알맹이를 `result` 밖에 두면 `cpt emulator show --json` 이 undefined 를 뱉는다
//   · `layout tree` 가 deviceId 를 안 실으면 에이전트는 "emulator" 라는 것만 알고 무엇이 떠 있는지 모른다
ok(/return \{ ok: true, result: \{ paneId[^}]*device \}/.test(pcUi), 'PC 가 띄운 기기를 회신에 싣는다');
ok(/if \(node\.deviceId\) out\.deviceId = node\.deviceId/.test(pcUi), 'PC layout tree 가 기기를 싣는다');

// ── 14. 조작 능력은 **낡을 수 있다** — 돌아올 때마다 다시 묻는다 ─────────────
// 2026-08-06 실사고(폰 → iOS 시뮬레이터): 버튼이 하나도 없고 터치도 안 먹었다. 기기의 조작 능력
//  (caps.input/keys)은 목록을 읽은 **그 순간**의 상태인데, 목록은 탭을 처음 열 때 한 번만 읽었다.
//  시뮬레이터가 아직 안 떠 있었으면 "조작 불가" 로 굳어 다 뜬 뒤에도 영영 버튼이 안 나온다.
for (const [name, src, hook] of [['PC', pcView, /setVisible[\s\S]{0,600}?this\.loadDevices\(\)/],
  ['앱', appEmu, /if \(!active\) return;\s*\n\s*void loadDevices\(\)/]]) {
  ok(hook.test(src), `${name} 이 탭으로 돌아올 때 기기 목록을 다시 읽는다`);
  ok(/CAP_RETRY_MAX/.test(src), `${name} 이 조작 준비를 상한 안에서 다시 물어본다(무한 폴링 금지)`);
}
//  왜 안 되는지는 **항상** 적는다 — 버튼도 없고 설명도 없으면 사용자에겐 그냥 고장이다.
ok(/if \(!canInput && dev\) \{/.test(pcView) && !/!canInput && dev && dev\.caps && dev\.caps\.inputHint/.test(pcView),
  'PC 의 이유 표시가 데몬 힌트 유무에 묶여 있지 않다');
ok(/!canInput && dev \?/.test(appEmu) && !/dev\.caps\.inputHint \?/.test(appEmu),
  '앱의 이유 표시도 힌트 유무에 묶여 있지 않다');
ok(/inputWhy/.test(appEmu), '앱이 힌트가 없을 때도 이유를 적는다');


// ── 15. 캡처 — "내가 본 것"을 **보고 있는 곳**으로 건넨다 ────────────────────────
// 2026-08-06 사용자 요구: 모바일 화면에 캡처 버튼을 붙이고, 그 결과가 TUI 든 채팅이든 **지금 보고
//  있는 쪽**으로 들어가야 한다. 프리뷰 요소 선택(Design Mode)도 같은 규칙으로 맞춘다 — 예전엔
//  무조건 PTY 라, 채팅 모드로 보고 있으면 화면에 없는 컴포저로 들어가 사라진 것처럼 보였다.
const pcAttach = read(path.join(PC, 'attach-insert.js'));
const appUiCtl = read(path.join(APP, 'workspace/uiControls.ts'));
const pcDesign = read(path.join(PC, 'design-pick.js'));
//  ① 판단은 **한 곳에만** 있다(캡처가 늘 때마다 같은 분기를 복제하지 않게).
ok(/export function insertAttachment/.test(pcAttach), 'PC 에 삽입 판단 한 곳(attach-insert)');
ok(/export function insertAttachment/.test(appUiCtl), '앱에도 같은 이름의 한 곳(uiControls)');
//  ② 채팅으로 보고 있으면 채팅으로 간다.
ok(/_chatActive\(\)/.test(pcAttach) && /attachWithText/.test(pcAttach), 'PC 가 채팅 모드면 채팅 컴포저로');
ok(/chatKey/.test(appUiCtl) && /getChatAttach/.test(appUiCtl), '앱이 채팅 모드면 채팅 컴포저로');
ok(/attachWithText\(text, paths\)/.test(read(path.join(PC, 'chat-view.js'))), 'PC 채팅 뷰에 첨부 창구가 있다');
//  ③ 두 캡처(모바일 화면·프리뷰 요소)가 **같은 길**을 쓴다 — 한쪽만 고쳐지는 일을 막는다.
ok(/insertAttachment\(/.test(pcView), 'PC 모바일 화면 캡처가 그 길을 쓴다');
ok(/insertAttachment\(/.test(pcDesign), 'PC 프리뷰 요소 캡처도 같은 길');
ok(/insertAttachment\(/.test(appEmu), '앱 모바일 화면 캡처가 그 길을 쓴다');
ok(/insertAttachment\(/.test(appPane), '앱 프리뷰 요소 캡처도 같은 길');
ok(!/const t = pickTermInsert\(\);\s*\n\s*if \(t\) t\.insert\(line\)/.test(appPane),
  '앱 요소 선택이 더 이상 PTY 로 직행하지 않는다');
//  ④ 캡처 버튼은 **조작 가능 여부와 무관**하다 — 보기 전용 기기도 "이 화면 좀 봐"는 뜻이 있다.
ok(/caps && dev\.caps\.frame/.test(pcView) || /caps\.frame/.test(pcView), 'PC 캡처 버튼 조건 = 화면을 받을 수 있는가');
ok(/dev\?\.caps\?\.frame \? \(/.test(appEmu), '앱 캡처 버튼 조건도 같다(canInput 아님)');
//  ⑤ 캡처는 **원본을 다시 받는다**(화면에 그려진 것을 긁지 않는다 — 줄인 해상도·돌린 그림이 나간다).
for (const [name, src] of [['PC', pcView], ['앱', appEmu]]) {
  ok(/emulatorFrame\(/.test(src), `${name} 캡처가 데몬에게 원본을 다시 받는다`);
}


console.log(`\n${fail === 0 ? 'ALL CONFORMANT' : 'NOT CONFORMANT'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
