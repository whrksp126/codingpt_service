// agents-crossimpl.mjs — 에이전트 관리의 **3플랫폼 일치**와 정직성 계약.
//
// 이 라운드의 핵심 위험은 "표시가 사실과 다른 것"이다:
//  · 등급 문구가 앱/PC 에서 다르면, 사용자는 한쪽에서 "완전 연동"이라 읽고 다른 쪽에서 다른 말을
//    보게 되며 무엇이 되는지 알 수 없다.
//  · `launchAgent` 가 영속 레이아웃에 남으면 앱을 켤 때마다 에이전트가 저절로 실행된다.
//  · 설치 성공을 "명령 종료 코드"로 판정하면 "npm 성공 + PATH 없음" 을 성공이라 거짓 보고한다.
import fs from 'node:fs';
import path from 'node:path';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const DAEMON = path.resolve('../codingpt_daemon/packages/runner-core');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const read = (p) => fs.readFileSync(p, 'utf8');
// 소스 핀은 **주석을 걷어낸 뒤** 검사한다 — 함정을 설명하는 주석 자체에 걸려 거짓 실패/거짓 성공을
//  내는 사고를 이 라운드 이전에 세 번 겪었다.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const pcView = read(path.join(PC, 'agents-view.js'));
const appCard = read(path.join(APP, 'components/agents/AgentsCard.tsx'));
const appSheet = read(path.join(APP, 'components/agents/AgentInstallPanel.tsx'));
const daemonAgents = read(path.join(DAEMON, 'agents.js'));

// ── 1. 등급 라벨·설명이 글자까지 같다 ────────────────────────────────────────
const pcTier = {};
for (const m of pcView.matchAll(/(full|partial|launch):\s*\{\s*label:\s*"([^"]+)",\s*desc:\s*"([^"]+)"/g)) {
  pcTier[m[1]] = { label: m[2], desc: m[3] };
}
ok(Object.keys(pcTier).length === 3, 'PC 등급표에서 3종을 읽어냈다', JSON.stringify(pcTier));

// 상세 설명문은 목록에서 제거됐다(사용자 확정) → **라벨**이 등급을 전하는 유일한 채널이므로
//  라벨만 대조한다. 설명 문구(TIER.desc)는 PC 쪽 정본으로 남겨 두고 아래 §2 가 사실성만 본다.
const appLabel = {};
for (const m of appCard.matchAll(/^\s*(full|partial|launch):\s*'([^']+)',/gm)) {
  if (appLabel[m[1]] === undefined) appLabel[m[1]] = m[2];
}
for (const k of ['full', 'partial', 'launch']) {
  ok(appLabel[k] === pcTier[k]?.label, `등급 라벨 일치(${k}): ${pcTier[k]?.label}`,
    `app=${appLabel[k]} pc=${pcTier[k]?.label}`);
}

// ── 2. 등급 문구가 사실과 맞는다(2026-07-29: codex 도 원격 승인 지원 — hooks.json 병합) ──────
ok(/원격 승인/.test(pcTier.full?.desc || ''), 'full 은 원격 승인을 약속한다');
// partial(codex)은 이제 원격 승인을 약속하되, **훅 신뢰(최초 1회)** 조건을 함께 명시해야 한다 —
//  조건 없이 약속하면 신뢰 전 상태에서 "폰에 카드가 안 온다"가 우리 버그로 읽힌다.
ok(/원격 승인/.test(pcTier.partial?.desc || '') && /신뢰/.test(pcTier.partial?.desc || ''),
  'partial 은 원격 승인 + 훅 신뢰 조건을 명시한다(신뢰 전 무카드가 버그로 읽히지 않게)');
ok(/안 돼요/.test(pcTier.launch?.desc || ''), 'launch 는 알림·승인 불가를 명시한다');
// 데몬 카탈로그의 tier 가 그 약속과 같아야 한다.
const tierOf = (id) => {
  const m = new RegExp(`id: '${id}',[\\s\\S]{0,200}?tier: '(\\w+)'`).exec(daemonAgents);
  return m && m[1];
};
ok(tierOf('claude') === 'full', 'claude=full');
ok(tierOf('codex') === 'partial', 'codex=partial');
ok(tierOf('gemini') === 'launch', 'gemini=launch');

// ── 3. 설치 성공 판정은 재감지 결과다(종료 코드 아님) ────────────────────────
for (const [name, src] of [['PC', pcView], ['앱', appSheet]]) {
  const s = strip(src);
  ok(/rescan/.test(s), `${name}: 검증은 재감지(rescan)로 한다`);
  ok(/\.installed/.test(s), `${name}: installed 를 보고 성공/실패를 가른다`);
  ok(/exitCode|exit_code|\$\?/.test(s) === false, `${name}: 명령 종료 코드로 성공을 판정하지 않는다`);
}

// ── 4. 설치 명령은 로컬 카탈로그에서만 온다 ──────────────────────────────────
ok(/https:\/\/claude\.ai\/install\.sh/.test(daemonAgents), '데몬 카탈로그에 검증된 설치 명령이 있다');
for (const [name, src] of [['PC', pcView], ['앱', appSheet]]) {
  const s = strip(src);
  ok(!/install\.sh|npm install -g/.test(s),
    `${name}: 설치 명령 문자열을 클라이언트에 하드코딩하지 않는다(카탈로그가 단일 출처)`);
  ok(/docs/.test(s), `${name}: 공식 문서 링크를 함께 보여준다(명령은 낡을 수 있다)`);
}

// ── 5. launchAgent 는 소비 즉시 지운다(영속 금지) ────────────────────────────
const pcPane = strip(read(path.join(PC, 'pane.js')));
const appPane = strip(read(path.join(APP, 'workspace/PaneView.tsx')));
ok(/delete tab\.launchAgent/.test(pcPane),
  'PC: tid 확정 지점에서 launchAgent 를 지운다(앱 재시작마다 자동 실행 방지)');
ok(/launchAgent: undefined/.test(appPane),
  '앱: 탭 갱신 시 launchAgent 를 지운다(같은 이유)');
// 실행은 데몬에 맡긴다 — 셸 준비 판정을 클라마다 구현하면 한쪽만 고쳐지는 결함이 된다.
ok(/agents\.launch/.test(pcPane), 'PC: 실행은 데몬 agents.launch 에 맡긴다');
ok(/launchAgent\(/.test(appPane), '앱: 실행은 데몬 launchAgent RPC 에 맡긴다');
const daemonSrv = strip(read(path.join(DAEMON, 'cpt-server.js')));
ok(/pane_current_command/.test(daemonSrv) && /capture-pane/.test(daemonSrv),
  '데몬: 셸 준비를 tmux 에 직접 물어 판정한다(프롬프트 전 전송 = 입력 씹힘)');

// ── 6. 배선 대상은 claude/codex 뿐 — 남의 개인 설정 파일을 쓰지 않는다 ────────
ok(!/\.gemini\/settings\.json|\.cursor\/|writeFileSync\([^)]*gemini/.test(strip(daemonAgents)),
  '데몬: 다른 에이전트의 개인 설정 파일에 쓰지 않는다(사용자 확정 2026-07-27)');
const shimSrc = strip(read(path.join(DAEMON, 'shim.js')));
ok(!/claude\/settings\.json'|codex\/config\.toml'/.test(shimSrc),
  'shim: ~/.claude/settings.json · ~/.codex/config.toml 을 수정하지 않는다(실행 인자 주입만)');

// ── 7. 드롭다운은 설치된 것만 띄운다 ────────────────────────────────────────
const pcWv = strip(read(path.join(PC, 'workspace-view.js')));
ok(/if \(!a\.installed\) continue/.test(pcWv), 'PC 드롭다운: 미설치는 건너뛴다');
const appMenu = strip(read(path.join(APP, 'workspace/AddTerminalMenu.tsx')));
ok(/filter\(\(a\) => a\.installed\)/.test(appMenu), '앱 드롭다운: 미설치는 걸러낸다');


// ── 8. 2차 확정 UI 규율 — 되돌아가기 쉬운 것들만 못박는다 ────────────────────
// 좌측 상태 점 · 에이전트별 설명문 · 하단 요약 문단은 **제거**가 결정이다(중복 신호였다).
const pcCss = read(path.resolve('src/styles.css'));
ok(!/\.ag-dot/.test(pcCss), 'PC: 좌측 상태 점 스타일이 남아 있지 않다(죽은 CSS = 재사용 시 조용히 부활)');
ok(!/\.ag-desc/.test(pcCss), 'PC: 에이전트별 설명문 스타일이 없다');
ok(!/ag-dot|ag-desc/.test(strip(pcView)), 'PC: 목록이 점/설명문을 그리지 않는다');
ok(!/TIER_DESC/.test(strip(appCard)), '앱: 목록이 에이전트별 설명문을 그리지 않는다');
const pcSettings = strip(read(path.join(PC, 'settings.js')));
ok(!/연동을 켜면 그 에이전트를/.test(pcSettings), 'PC: 하단 요약 문단이 없다');
ok(!/개인 설정 파일\(~\/\.claude · ~\/\.codex\)은\s*$/.test(strip(appCard)), '앱: 하단 요약 문단이 없다');

// 이 영역에 포인트 컬러(accent)를 쓰지 않는다 — 사용자 지적("너무 과해").
//  PC: .ag-* 규칙 어디에도 var(--accent) 가 없어야 한다. 앱: 설치 패널에 C.accent 배경이 없어야 한다.
//  ⚠ 온보딩 슬라이드 섹션(3차 개정)은 검사 범위 밖이다 — 온보딩 CTA·진행점은 권한 위저드와 같은
//   accent 시각 언어를 쓴다(no-accent 규칙은 설정의 설치/관리 영역에 대한 확정이었다).
const agCssBlock = ((/\/\* ── 에이전트 관리[\s\S]*$/.exec(pcCss) || [''])[0]).split('/* ── 에이전트 온보딩 슬라이드')[0];
ok(agCssBlock.length > 100 && !/var\(--accent\)/.test(agCssBlock), 'PC: 에이전트 설치/관리 영역 CSS 에 accent 가 없다');
ok(!/backgroundColor: C\.accent/.test(appSheet), '앱: 설치 패널 버튼에 accent 배경이 없다');

// 설치는 **모달 위 모달을 만들지 않는다** → 행 아래 인라인 확장.
ok(/ag-panel/.test(pcView) && !/openInstallSheet/.test(pcView),
  'PC: 설치는 인라인 패널이다(별 모달 openInstallSheet 폐기)');
ok(!/<Modal/.test(appSheet), '앱: 설치 패널은 Modal 이 아니다(설정 모달 위에 겹치지 않는다)');
// 설치 명령은 탭 전환이 아니라 전부 세로로 보여준다.
ok(!/ag-methods|scale-seg/.test(pcView), 'PC: 설치 명령을 탭(세그먼트)으로 감추지 않는다');
ok(/methods\.map/.test(appSheet), '앱: 설치 명령을 전부 나열한다');

// 설치된 에이전트는 복수 선택하고 하나의 명확한 CTA에서 선택 상태를 일괄 적용한다.
ok(/const selected = new Set/.test(pcView) && /ag-onb-option/.test(pcView),
  'PC 온보딩: 발견된 에이전트를 복수 선택할 수 있다');
ok(/for \(const a of queue\)/.test(pcView) && /selected\.has\(a\.id\)/.test(pcView),
  'PC 온보딩: 선택한 에이전트는 켜고 선택 해제한 에이전트는 끈다');
ok(/wirables\.filter\(\(a\) => a\.installed\)/.test(pcView),
  'PC 온보딩: 미설치 에이전트는 슬라이드에 없다(설치는 설정의 몫 — 첫 사용자에게 노이즈)');

// ── 9. 새 터미널은 스테일 치수로 열지 않는다(TUI 첫 화면이 영구히 어긋난다) ──
ok(/_fitLocalOnly\(\);\s*\n?\s*const \{ cols, rows \} = this\.term;/.test(pcPane)
   || /_fitLocalOnly\(\)/.test(pcPane) && /_openChannel\(win\) \{[\s\S]{0,200}_fitLocalOnly/.test(pcPane),
  'PC: _openChannel 이 크기를 읽기 전에 실측 재맞춤한다(라이브 실측 42x15 사고)');
ok(/window_width/.test(daemonSrv),
  '데몬 launch: 창 폭이 안정된 뒤 명령을 보낸다(TUI 는 첫 화면을 그 순간 폭으로 그린다)');


// ── 10. 단계 버튼은 제목 줄 우측 끝 · 보조 설명문 없음(사용자 확정 3차) ─────────
ok(/ag-panel-h--act/.test(pcView), 'PC: 단계 제목 줄에 실행 버튼을 얹는다');
ok(!/직접 입력해도 돼요/.test(pcView) && !/설치가 끝나면 눌러 주세요/.test(pcView),
  'PC: 단계 보조 설명문 2종을 제거했다');
ok(/StepHead[\s\S]{0,200}right/.test(appSheet), '앱: StepHead 가 우측 슬롯을 받는다');
ok(!/직접 입력해도 돼요/.test(appSheet) && !/설치가 끝나면 눌러 주세요/.test(appSheet),
  '앱: 단계 보조 설명문 2종을 제거했다');

// ── 11. 터미널 폭은 거터를 무조건 확보한다(잘림 > 빈 띠) ──────────────────────
// ★ 잘림 판정 = **필요한 내용 폭(cols×cellW) vs `.xterm-screen` 의 폭**.
//  실기기 픽셀 분석으로 확정(2026-07-27): screen 폭 445 · 필요 448 → 초과 3px → 58번째 셀이 절반만
//  보이고, `│` 는 세로 획이 셀 가운데라 통째로 사라진다("우측 테두리만 없다"의 정체).
//  ⚠ `.xterm-screen` 의 **rect 를 pane rect 와 비교**하면 안 된다 — screen 이 바로 클립 경계라
//   항상 "여유 있음"이 나온다(이 실수로 한 라운드를 날렸다).
ok(/t\.cols \* cell\.width - \(sw/.test(pcPane),
  'PC: 필요 폭(cols×cellW)을 .xterm-screen 폭과 비교한다');
ok(/querySelector\("\.xterm-screen"\)/.test(pcPane) && /getBoundingClientRect\(\)\.width/.test(pcPane),
  'PC: .xterm-screen 의 폭을 직접 잰다');
ok(!/sc\.right - \(box\.right/.test(pcPane),
  'PC: screen rect 를 pane rect 와 비교하는 옛 방식으로 되돌아가지 않는다(항상 통과해 무력)');
ok(!/term-fit/.test(pcPane), 'PC: 폐기한 대리 지표 모듈을 다시 참조하지 않는다');
ok(/setTimeout\([\s\S]{0,120}_fitNow\(\)/.test(pcPane),
  'PC: 채널 개설 후 지연 재검산이 있다(ResizeObserver 는 크기 불변 시 안 울린다)');

ok(/this\._sentCols === cols && this\._sentRows === rows/.test(pcPane),
  'PC: 크기가 안 바뀌면 resize 를 보내지 않는다(7초마다 tmux 창 재클레임 = 폰 크기 뺏기)');

ok(/\.xterm-viewport::-webkit-scrollbar \{ width: 0/.test(pcCss),
  'PC: 터미널 스크롤바를 두지 않는다(뺄 폭을 맞추는 대신 문제군을 제거 — 되돌리면 잘림 재발)');

// ── 11b. 렌더러는 GPU(webgl→canvas), DOM 은 최후 폴백 ─────────────────────────
// ★ 진짜 근본 원인(2026-07-27 픽셀 실측, 0.1.123 에서도 재현): DOM 렌더러는 WebKit 텍스트
//  레이아웃(letter-spacing 서브픽셀 라운딩)에 의존해 행 끝으로 갈수록 글리프가 오른쪽으로 밀리고,
//  마지막 열 글리프가 클립 밖으로 나가 **cols 계산이 완벽해도** 잘린다. 증거: 버퍼에 `│`(11줄)와
//  `╯` 가 전부 있는데 세로선 픽셀 0 · 인테리어 행은 논리 1170 이후 순수 배경색 · 가로 `─` 는 셀을
//  가득 채워 1188 까지 이어져 "선은 있는데 모서리만 없다"는 오진을 유발했다. cols×cellW 대
//  screen 폭 비교(need==screenW 가 로그에서 매번 정확히 일치)는 같은 소스에서 나온 두 값의
//  동어반복이라 이 드리프트를 원리적으로 못 잡는다 — 다섯 번째 무효 대리 지표.
//  webgl/canvas 는 셀을 디바이스 픽셀 격자에 직접 그려 드리프트가 없다(모바일 TerminalWebView 가
//  같은 xterm 5.3.0 + webgl 0.16.0 조합으로 무증상임을 확인하고 이식).
const pcIndex = read(path.resolve('src/index.html'));
ok(/xterm-addon-webgl\.js/.test(pcIndex) && /xterm-addon-canvas\.js/.test(pcIndex),
  'PC: webgl/canvas 렌더러 애드온을 벤더 로드한다');
ok(/WebglAddon\.WebglAddon\(\)/.test(pcPane) && /onContextLoss/.test(pcPane) && /CanvasAddon\.CanvasAddon\(\)/.test(pcPane),
  'PC pane: webgl 렌더러 + 컨텍스트 유실 시 canvas 폴백');
ok(/this\.term\.open\(this\.termEl\);\s*this\._loadRenderer\(\);/.test(pcPane),
  'PC pane: 렌더러는 open() 직후 로드한다(DOM 렌더러로 첫 페인트하지 않게)');
ok(/WebglAddon\.WebglAddon\(\)/.test(strip(pcView)),
  'PC 설치 패널 터미널도 GPU 렌더러를 쓴다');
ok(/document\.fonts\?\.ready/.test(pcPane) && /fontFamily = "monospace"/.test(pcPane),
  'PC pane: 웹폰트 로드 완료 시 fontFamily 재할당으로 강제 재측정+재fit(셀폭 7.559→7.724 실측)');

// 우측 "공간 예약" 시도는 되돌렸다(pane 자체가 창을 넘는 상황에서 잘림을 키운다 — 사용자 실측).
//  다만 **안쪽 padding 으로 예약하려는 시도는 무효**라는 실측 결론은 CSS 주석으로 남겨 둔다:
//  FitAddon 이 부모 폭을 border-box(padding 포함)로 읽고 자기 padding 만 빼므로 정확히 상쇄된다.
//  그 근거가 사라지면 다음 사람이 같은 무효 수정을 반복한다.
ok(/안쪽 padding 으로 주는 것은 \*\*무효\*\*/.test(pcCss),
  'PC: "안쪽 padding 예약은 무효" 실측 결론이 CSS 에 기록돼 있다');
// pane 이 창을 넘는지를 진단에 남긴다(pane 내부 초과만 보면 이 경우를 못 본다).
ok(/paneR=\$\{paneR/.test(pcPane) && /winW=\$\{winW/.test(pcPane),
  'PC: pane 우변과 창 안쪽 폭을 로그에 남긴다(레이아웃이 창을 넘는 경우를 다시 놓치지 않게)');

// ★ 분할 자식은 줄어들 수 있어야 한다 — basis 합 100% + 1px 분할선이라 shrink 0 이면 마지막
//  pane 이 컨테이너를 넘고, 그 1px 이 창에 잘려 터미널 마지막 열 오른쪽이 깎인다(실측 확정).
ok(/\.split-child \{[^}]*flex: 0 1 auto/.test(pcCss),
  'PC: .split-child 는 flex-shrink 1(0 0 auto 로 되돌리면 우측 pane 이 1px 넘쳐 잘림 재발)');
ok(!/\.split-child \{[^}]*flex: 1 1 auto/.test(pcCss),
  'PC: grow 는 0 유지(1 이면 사용자가 잡은 분할 비율이 무너진다)');

// ── 12. 온보딩/셋업은 **계정별 1회** + 권한은 없는 것만 하나씩 (2026-07-28 실사고) ─────────
// 실사고: 회원탈퇴 → 같은 이메일 재가입(서버는 하드 삭제 = 새 user id)했는데 ① 이전 계정에서 열어 둔
//  설정 모달이 그대로 다시 떴고 ② 온보딩이 안 떴다. 원인 = `cpt.setupDone` 머신 1회 플래그 +
//  maybeShowOnboarding 이 부팅 시에만 실행 + view 상태 미초기화. 서버는 무죄였다(prod 실측: user id
//  52 신규 생성 · 하드 삭제 확인) — 이 절은 클라이언트 3결함의 부재를 고정한다.
const pcGate = strip(read(path.join(PC, 'login-gate.js')));
const pcUiCh = strip(read(path.join(PC, 'ui-channel.js')));
const pcSettings2 = strip(read(path.join(PC, 'settings.js')));
ok(/cpt\.setupDone\.\$\{state\.me\.id\}/.test(pcGate) && !/localStorage\.setItem\("cpt\.setupDone"/.test(pcGate),
  'PC: 셋업 완료 플래그는 계정별 키다(머신 1회 플래그로 되돌리면 재가입 계정이 온보딩을 못 본다)');
ok(/cpt\.agentsOnboarded\.\$\{state\.me\.id\}/.test(strip(pcView)),
  'PC: 에이전트 온보딩 노출도 계정별 1회다(배선 설정의 머신 영속과 스코프가 다르다)');
// 화면당 권한 하나 + 하단 [허용] 단일 CTA. 모든 권한은 실제 승인 전까지 다음으로 못 넘어간다.
ok(/permQueue\[permIdx\]/.test(pcGate) && /id="lgAllow"/.test(pcGate) && !/id="lgFolders"/.test(pcGate),
  'PC: 권한 위저드는 화면당 하나 + 단일 [허용] CTA 다(행 목록/일괄 버튼 금지 — 사용자 확정 2차)');
ok(!/id="lgAuto"/.test(pcGate) && !/lgDone/.test(pcGate),
  'PC: 게이트에 자동 실행 토글·시작하기 버튼이 없다(권한에만 집중 — 마지막 허용이 곧 완료)');
ok(!/lgSkipPerm/.test(pcGate) && /requiredPerms\(\)/.test(pcGate),
  'PC: 모든 필수 권한을 실제 승인하기 전에는 건너뛰거나 완료할 수 없다');
ok(/\{ id: "notification", label: "알림 설정" \}/.test(pcGate)
  && /p\.id === "notification"/.test(pcGate)
  && !/\{ id: "notif"/.test(pcGate),
  'PC: 알림 큐 id와 상세 설정 분기가 같아 온보딩에서 소리·테스트가 반드시 보인다');
ok(!/lg-glyph|lg-perm-ic|lg-brand|ag-onb-head/.test(pcGate + strip(pcView)),
  'PC 온보딩: CodingPT 로고·워드마크·텍스트 위 장식 아이콘·헤더를 사용하지 않는다');
ok(/maybeShowOnboarding/.test(pcGate),
  'PC: 게이트 종료 시에도 에이전트 온보딩을 판정한다(재가입/계정 전환은 부팅 없이 온다)');
ok(/setView\("workspace"\)/.test(pcUiCh),
  'PC: 원격 탈퇴 수신 시 열려 있던 화면(설정 모달)을 기본 화면으로 되돌린다');
ok(/S\.setView\("workspace"\)/.test(pcSettings2.slice(pcSettings2.indexOf('doDeleteAccount'))),
  'PC: 이 기기에서 탈퇴해도 설정 모달을 닫는다(재가입 첫 화면에 잔상 금지)');
ok(/markPermGranted\(b\.dataset\.f\)/.test(pcSettings2),
  'PC: 설정의 폴더 허용 성공도 로컬 기록에 남긴다(온보딩의 "없는 권한만" 판정 근거)');

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
console.log('ALL CONFORMANT');
