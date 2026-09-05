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
// i18n 벗기기 — 이 아래 검사들은 **소스에 어떤 문구가 어디 쓰였는지**를 본다. 다국어를 켜면서
//  화면 문구가 `i18n.t("…")` 로 감싸졌는데, 그건 이 검사들이 보려는 구조가 아니다(감싸는 방식이
//  바뀔 때마다 무관한 검사가 무더기로 깨진다) → 비교 전에 껍데기만 벗긴다.
const unwrapT = (s) => String(s)
  // ① HTML 안에 끼운 형태: `>${i18n.t('이 기기')}</div>` → `>이 기기</div>` (텍스트 그 자체로).
  .replace(/\$\{i18n\.t\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\)\}/g,
    (_m, dq, sq) => String(dq != null ? dq : sq))
  // ② 값으로 쓰인 형태: `L(i18n.t('열쇠 있음'), "on")` → `L("열쇠 있음", "on")`.
  //  따옴표 **모양까지 통일**한다. 치환기는 홑따옴표를 쓰는데 옛 소스는 겹따옴표라, 벗기기만 하면
  //  검사 문자열과 계속 어긋난다.
  .replace(/i18n\.t\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\)/g,
    (_m, dq, sq) => '"' + String(dq != null ? dq : sq).replace(/"/g, '\\"') + '"');
const read = (p) => unwrapT(fs.readFileSync(p, 'utf8'));
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
// ★ 2026-08-14: 판정은 그대로지만 **묻는 통로**가 tmux 직결에서 termBackend(win32 포팅)로 바뀌었다.
//  고정할 것은 "무엇을 근거로 판정하는가"(실행 중 명령 + 화면에 그려진 것)이지 tmux 명령 문자열이
//  아니다 — 옛 정규식(pane_current_command/capture-pane)은 리팩터링 이후 계속 빨간 채였다.
ok(/termBackend\.info\(target\)/.test(daemonSrv) && /termBackend\.capture\(target/.test(daemonSrv),
  '데몬: 셸 준비를 터미널에 직접 물어 판정한다(프롬프트 전 전송 = 입력 씹힘)');

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
   || /_fitLocalOnly\(\)/.test(pcPane) && /_openChannel\(win(?:, replace)?\) \{[\s\S]{0,200}_fitLocalOnly/.test(pcPane),
  'PC: _openChannel 이 크기를 읽기 전에 실측 재맞춤한다(라이브 실측 42x15 사고)');
ok(/termBackend\.info\(target\)\)\.cols/.test(daemonSrv) && /lastW !== null && w === lastW/.test(daemonSrv),  // 폭이 두 번 연속 같을 때만 전송
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
const pcBridge = strip(read(path.resolve(PC, '../../src-tauri/src/bridge.rs')));
const pcStyles = strip(read(path.join(PC, '..', 'styles.css')));
const pcUiCh = strip(read(path.join(PC, 'ui-channel.js')));
const pcSettings2 = strip(read(path.join(PC, 'settings.js')));
ok(/cpt\.setupDone\.\$\{state\.me\.id\}/.test(pcGate) && !/localStorage\.setItem\("cpt\.setupDone"/.test(pcGate),
  'PC: 셋업 완료 플래그는 계정별 키다(머신 1회 플래그로 되돌리면 재가입 계정이 온보딩을 못 본다)');
ok(/cpt\.agentsOnboarded\.\$\{state\.me\.id\}/.test(strip(pcView)),
  'PC: 에이전트 온보딩 노출도 계정별 1회다(배선 설정의 머신 영속과 스코프가 다르다)');
// 화면당 권한 하나 + 이전/확인/다음. OS 권한은 모두 선택 사항이라 미승인 상태에서도 진행한다.
ok(/permQueue\[permIdx\]/.test(pcGate) && /id="lgAllow"/.test(pcGate)
  && /id="lgPermBack"/.test(pcGate) && /id="lgPermNext" class="btn primary">/.test(pcGate)
  && !/id="lgFolders"/.test(pcGate),
  'PC: 권한 위저드는 화면당 하나이며 미승인 상태에서도 다음으로 진행할 수 있다');
ok(!/id="lgAuto"/.test(pcGate) && !/lgDone/.test(pcGate),
  'PC: 게이트에 자동 실행 토글·시작하기 버튼이 없다(권한에만 집중 — 마지막 허용이 곧 완료)');
ok(/requiredPerms\(\)/.test(pcGate) && !/if \(!grantedNow\) return/.test(pcGate),
  'PC: 모든 OS 권한은 선택 사항이며 미승인 상태도 완료할 수 있다');
ok(/\{ id: "notification", label: "알림 설정" \}/.test(pcGate)
  && /p\.id === "notification"/.test(pcGate)
  && !/\{ id: "notif"/.test(pcGate),
  'PC: 알림 큐 id와 상세 설정 분기가 같아 온보딩에서 소리·테스트가 반드시 보인다');
ok(/id="lgOpenNotifSettings"/.test(pcGate)
  && !/warning\.querySelector\("#lgOpenNotifSettings"\)/.test(pcGate),
  'PC: 시스템 설정 열기 버튼은 알림 권한 상태와 무관하게 항상 보인다');
ok(/id="lgNotifControls" class="notif-onb-controls is-disabled"/.test(pcGate)
  && /soundSelect\.disabled = !granted/.test(pcGate)
  && /test\.disabled = !granted/.test(pcGate)
  && !/nextBtn\.disabled = !grantedNow/.test(pcGate)
  && !/lgOpenNotifSettingsReady/.test(pcGate),
  'PC: 알림 OFF면 소리·테스트만 비활성이고 온보딩 진행은 막지 않는다');
ok(/mac_usernotifications::Notification::new/.test(pcBridge)
  && /\.send_blocking\(\)/.test(pcBridge)
  && /\.default_sound\(\)/.test(pcBridge),
  'PC: macOS 테스트 알림은 전면 배너를 지원하는 UNUserNotificationCenter로 보내고 실제 결과를 기다린다');
ok(/test\.textContent = ok \? "다시 테스트"/.test(pcGate)
  && /soundSelect\?\.addEventListener\("change"[\s\S]*"테스트 알림 보내기"/.test(pcGate)
  && !/보냈어요 ✓/.test(pcGate),
  'PC: 테스트 알림은 성공 후에도 재전송할 수 있고 소리 변경 시 버튼 문구를 초기화한다');
ok(/btn\.dataset\.denied = "1"/.test(pcGate)
  && /api\.openFilesPrivacy\(\)/.test(pcGate)
  && /setInterval\(async \(\)[\s\S]{0,400}api\.probeFolder\(p\.id\)/.test(pcGate)
  && /id="lgOpenFolderSettings"/.test(pcGate)
  && /btn\.textContent = "다시 확인"/.test(pcGate),
  'PC: 보호 폴더는 설정 화면을 직접 열고 승인 상태를 다시 확인할 수 있다');
ok(/checkingPermission/.test(pcGate)
  && /권한을 다시 확인하고 있어요/.test(pcGate)
  && /권한 없이 다음으로 넘어갈 수 있어요/.test(pcGate),
  'PC: 다시 확인은 즉시 진행 상태와 실패 결과를 표시한다');
// ★ 2026-08-14 사용자 확정: 권한 판정은 **슬라이드 진입 시 자동**이다. 예전엔 이미 허용된 권한
//  앞에서도 [권한 확인] 을 한 번 눌러야 [다음] 이 열렸다("굳이 사용자가 누르지 않아도 되게").
//  알림도 상태만 읽지 않고 미결정이면 그 자리에서 요청한다(팝업). 버튼은 거부 뒤 재확인 전용.
ok(/permAutoCheck\?\.\(\)/.test(pcGate)
  && /btn\.addEventListener\("click", \(\) => \{ permAutoCheck\?\.\(\); \}\)/.test(pcGate)
  && /value === "prompt"/.test(pcGate) && /api\.notifPermission\(\)/.test(pcGate)
  && !/알림 상태 확인 중…|"권한 확인"|'권한 확인'/.test(pcGate),
  'PC: 권한은 슬라이드 진입 시 자동 판정한다(사용자가 [권한 확인] 을 누를 필요가 없다)');
// ★ TCC 는 폴더 세 개가 아니다 — 홈 훑기가 iCloud Drive·음악 보관함에 닿으면 **작업 도중** 팝업이
//  뜬다(2026-08-14 실사고). 온보딩에서 함께 받고, 없는 경로는 통과시켜 승인 수단 없는 화면에
//  사용자를 가두지 않는다.
ok(/\{ id: "icloud"/.test(pcGate) && /\{ id: "media"/.test(pcGate)
  && /"icloud" => h\.join\("Library"\)\.join\("Mobile Documents"\)/.test(pcBridge)
  && /Music Library\.musiclibrary/.test(pcBridge)
  && /ErrorKind::NotFound/.test(pcBridge),
  'PC: iCloud Drive·음악 보관함 TCC 도 온보딩에서 미리 받는다(없는 경로는 통과)');
ok(/\.login-gate \.lg-wizard-body\s*\{[^}]*align-items:\s*flex-start[^}]*text-align:\s*left/.test(pcStyles)
  && /\.login-gate \.lg-dots\s*\{[^}]*justify-content:\s*flex-start/.test(pcStyles),
  'PC: 권한 온보딩 본문과 진행 표시는 Orca처럼 왼쪽 정렬한다');
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

// ── 13. 미읽음 강조 테두리는 "사용자가 봤다"로 꺼진다 (2026-08-14 실사고) ─────
// 실사고: 알림이 온 터미널을 클릭해도 강조 테두리가 안 꺼졌다. 원인 둘 —
//  ① 읽음 판정이 **터미널 본문(termEl)** 클릭에만 걸려 있어 같은 탭을 **채팅 모드**로 보고 있으면
//     아무리 읽어도 안 꺼졌다 → 판정 자리를 pane 전체(el mousedown, isTrusted)로 올렸다.
//  ② 알림 행을 눌러 점프해도 누른 그 한 건만 읽음이라(readOne) 같은 터미널의 나머지 미읽음이
//     테두리를 계속 켜 뒀다 → 점프 시 그 (cwd,win) 을 통째로 읽음 처리한다.
ok(/this\.el\.addEventListener\("mousedown"[\s\S]{0,600}onTabActivated\?\.\(at\.win\)/.test(pcPane),
  'PC: pane 어디를 클릭해도(채팅 모드 포함) 그 터미널의 알림이 읽음 처리된다');
const pcSidebar = strip(read(path.join(PC, 'sidebar.js')));
ok(/S\.readScope\(n\.cwd, Number\(n\.win\)\)/.test(pcSidebar),
  'PC: 알림에서 터미널로 점프하면 그 터미널의 미읽음을 통째로 읽음 처리한다(테두리 잔존 방지)');

// ── 14. 기기 우선 사이드바 + 채팅 모드(베타) — 2026-08-14 사용자 확정 ─────────
// 사용자 지적: "워크스페이스 안에 PC 가 보이는 구조는 이해도 안 가고 사용성도 안 좋다".
//  실제 소유 관계는 반대다 — 워크스페이스는 **그 PC 의 로컬 폴더**다. 그래서 PC 를 먼저 고르고
//  고른 PC 의 워크스페이스만 그린다. 이 절은 그 구조가 되돌아가지 않게 못박는다.
const pcState = strip(read(path.join(PC, 'state.js')));
const appSidebar = strip(read(path.join(APP, 'components/SidebarContent.tsx')));
const appShell = strip(read(path.join(APP, 'contexts/WorkspaceShellContext.tsx')));

// (1) 기기 선택 = 양 플랫폼 같은 규칙(PC 만 · 마지막 선택 기억 · 사라진 기기는 폴백).
for (const [name, src] of [['PC', pcState], ['앱', appShell]]) {
  ok(/role !== ["\']controller["\']/.test(src) && /runnerKind !== ["\']cloud["\']/.test(src),
    `${name}: 기기 목록은 PC 뿐이다(모바일 controller·클라우드 러너 제외)`);
  ok(/cpt\.activeDeviceId\.v1/.test(src), `${name}: 마지막으로 고른 PC 를 기억한다(같은 저장 키)`);
  ok(/workspacesForDevice/.test(src), `${name}: 워크스페이스 목록은 고른 PC 로 거른다`);
}
// 저장 키 문자열이 실제로 **같은가** — 다르면 "폰에선 됐는데 PC 는" 이 조용히 생긴다.
ok(/cpt\.activeDeviceId\.v1/.test(pcState) && /cpt\.activeDeviceId\.v1/.test(appShell),
  '★ 선택한 PC 저장 키가 두 플랫폼에서 같은 문자열이다');

// (2) 상단 + 제거 — 워크스페이스 추가는 사이드바 안 `워크스페이스` 섹션 머리로 내려갔다.
ok(!/i18n\.t\('새 워크스페이스'\)|"새 워크스페이스"/.test(pcSidebar) && /sb-sec/.test(pcSidebar),
  'PC: 사이드바 상단 + 를 없애고 섹션 머리에서 추가한다');
ok(/SectionHead/.test(appSidebar) && !/onPress=\{onNewWorkspace\} disabled=\{creating\}><Plus/.test(appSidebar),
  '앱: 상단 컨트롤의 + 를 없애고 섹션 머리에서 추가한다');

// (3) 프로젝트 그룹핑 폐기 — 화면·CSS·메뉴 어디에도 남기지 않는다(죽은 코드는 조용히 부활한다).
ok(!/projectId/.test(pcSidebar), 'PC: 사이드바가 projectId(프로젝트 묶음)를 더 이상 쓰지 않는다');
ok(!/projectId/.test(appSidebar), '앱: 사이드바가 projectId 를 더 이상 쓰지 않는다');
ok(!/ws-proj-head|ws-proj-members/.test(pcCss), 'PC: 프로젝트 그룹 CSS 가 남아 있지 않다');
ok(!/프로젝트에서 분리|다른 프로젝트와 합치기/.test(pcSidebar + appSidebar),
  '분리/합치기 메뉴가 두 플랫폼 모두에서 사라졌다');

// (4) 헤더 추가 버튼 = [+] 하나. 옛 4버튼(터미널/IDE/웹뷰/모바일화면)이 남아 있으면 걸린다.
const appWv = strip(read(path.join(APP, 'workspace/WorkspaceView.tsx')));
ok(/addBtn\.dataset\.cmd = "ws\.add"/.test(pcWv) && !/mkBtn\(icons\.code/.test(pcWv),
  'PC: 헤더 추가는 [+] 하나다(옛 4버튼 폐기)');
ok(/setAddSheet\(true\)/.test(appWv) && !/smartAdd\('emulator'\)\}><DeviceMobile/.test(appWv),
  '앱: 헤더 추가는 [+] 하나다(옛 4버튼 폐기)');

// (5) 채팅 모드(베타) — 판정은 **공용 함수 인자**로 들어가야 한다. 한쪽에서만 바깥 가드로 막으면
//  §agent-toggle 의 조합 동치 검증이 그 차이를 못 본다(그래서 여기서 인자 존재를 고정한다).
const pcSignal = strip(read(path.join(PC, 'agent-signal.js')));
const appPresence = strip(read(path.join(APP, 'workspace/agentPresence.ts')));
ok(/input\.betaOn === false/.test(pcSignal) && /input\.betaOn === false/.test(appPresence),
  '★ 채팅 모드 베타 게이트가 두 구현의 resolveToggleVisible 안에 같은 규칙으로 있다');
ok(/cpt\.chatBeta\.v1/.test(strip(read(path.join(PC, 'chat-model.js'))))
  && /cpt\.chatBeta\.v1/.test(strip(read(path.join(APP, 'services/chatBeta.ts')))),
  '★ 채팅 모드 베타 저장 키가 두 플랫폼에서 같은 문자열이다');
const pcSet = strip(read(path.join(PC, 'settings.js')));
const appSet = strip(read(path.join(APP, 'components/SettingsModal.tsx')));
ok(/베타/.test(pcSet) && /BetaTag/.test(appSet), '설정 화면이 베타임을 표시한다(양 플랫폼)');
// ★ 베타 기능은 `실험실` 한 곳에 모은다(2026-08-14 사용자 확정: "베타 기능들 많아질 것 같다").
//  각 기능 화면에 흩어지면 화면마다 "이건 정식인가 실험인가"를 다시 판단해야 한다.
ok(/key: "lab", label: "실험실"/.test(pcSet) && /key: 'lab', label: '실험실'/.test(appSet),
  '양 플랫폼 설정에 `실험실` 섹션이 있다');
ok(/LAB_FEATURES/.test(pcSet) && /sec === 'lab'/.test(appSet),
  '채팅 모드 토글이 실험실에서 그려진다');
ok(!/chatBetaChk/.test(pcSet) && !/chatBetaOn.*\n.*AgentsCard|AgentsCard[\s\S]{0,200}chatBetaOn/.test(appSet),
  '에이전트 화면에는 더 이상 베타 토글이 없다(실험실로 이사 완료)');

// (6) PC 전환 = 그 PC 에서 **마지막에 보던 워크스페이스**로 (2026-08-14 사용자 확정).
//  PC 만 바뀌고 본문이 옛 PC 의 워크스페이스로 남으면 지금 어느 PC 를 보는지 잃는다.
ok(/cpt\.lastWsByDevice\.v1/.test(pcState) && /cpt\.lastWsByDevice\.v1/.test(appShell),
  '★ PC 별 마지막 워크스페이스 저장 키가 두 플랫폼에서 같은 문자열이다');
for (const [name, src] of [['PC', pcState], ['앱', appShell]]) {
  ok(/rememberLastWs\(/.test(src), `${name}: 워크스페이스를 고를 때 그 PC 의 마지막 자리로 기록한다`);
  // 기억한 것이 사라졌으면 첫 워크스페이스로 — 아무 데도 못 가는 상태를 만들지 않는다.
  ok(/lastWs(Map\(\)|ByDeviceRef\.current)\[String\(id\)\]/.test(src) && /\|\| list\[0\]/.test(src),
    `${name}: PC 를 고르면 기억한 워크스페이스(없으면 첫 번째)로 들어간다`);
}

// (7) 꺼진 PC 의 빈 화면은 사실대로 말한다 — "열린 터미널이 없습니다 / [새 터미널]" 은 거짓말이다
//  (그 PC 는 꺼져 있어 새 터미널을 열 수 없다). 2026-08-14 사용자 지적.
const OFFMSG = '이 PC가 꺼져 있어요';
for (const [name, src] of [['PC', pcPane], ['앱', appPane]]) {
  ok(src.includes(OFFMSG), `${name}: 꺼진 PC 의 빈 화면은 꺼져 있다고 말한다`);
  ok(/hostOffline/.test(src), `${name}: 빈 화면 문구·버튼이 호스트 온오프를 본다`);
}
ok(/hostOnline === false/.test(pcWv) && /hostOnline === false/.test(appPane),
  '★ 두 구현 모두 hostOnline === false 를 같은 판정으로 쓴다(undefined 는 켜짐 취급)');

// ── 15. 텍스트 선택 정책 (2026-08-14 사용자 실사고) ──────────────────────────
// 증상: 설정 창의 제목·소제목·라벨이 드래그로 잡혀 매우 불편했다.
// 진범: 전역 `user-select: none` 은 처음부터 있었지만 **`-webkit-` 접두사가 없었다**. WKWebView 는
//  접두사 선언을 봐야 해서 전역 규칙이 통째로 무시됐고, 개별적으로 접두사를 적어 둔 곳만 살아남아
//  "어떤 건 잡히고 어떤 건 안 잡히는" 화면이 됐다. 이 검사는 그 누락이 되돌아오는 것을 막는다.
const rootBlock = (/html, body \{[\s\S]*?\n\}/.exec(pcCss) || [""])[0];
ok(/user-select: none;/.test(rootBlock) && /-webkit-user-select: none;/.test(rootBlock),
  '★ 앱 셸의 기본은 선택 불가 — 접두사 있는 선언까지 함께 있다(WKWebView 는 이것만 본다)');
// 되돌리는 곳도 마찬가지다: 접두사 없는 `user-select: text` 는 이 웹뷰에서 아무 일도 하지 않는다.
const textOnly = pcCss.split("\n").filter((l) => /user-select: text/.test(l) && !/-webkit-user-select: text/.test(l)
  && !/^\s*-webkit-/.test(l));
ok(textOnly.length === 0, '★ 선택 허용 선언은 항상 접두사와 짝으로 쓴다', textOnly.slice(0, 3).join(" | "));
// 복사·편집이 목적인 표면은 실제로 열려 있어야 한다(전역 none 이 이것들까지 덮으면 기능이 죽는다).
for (const sel of ['input, textarea', '\\.cm-editor', '\\.pane-chat', '\\.rv-lines', '\\.link-code']) {
  ok(new RegExp(sel + '[^{]*\\{[^}]*user-select: text').test(pcCss),
    `선택 가능한 표면 유지: ${sel.replace(/\\\\/g, "")}`);
}

// ── 16. 렌더는 프레임당 1회로 합친다 (2026-08-14 사용자 실사고: "반응이 왜 이리 느리지?") ──
// 진단: WebContent 를 sample 하니 타이머 콜백 안에서 innerHTML 재작성이 쉬지 않고 돌았다. 렌더가
//  무거운 게 아니라 **횟수**가 문제였다 — emit() 이 listeners 를 동기로 돌았고 emit 호출 지점이
//  106곳이며 그중 agent_state push 는 초당 여러 번 온다(claude 가 도는 내내). 그 사이에 낀 클릭이
//  밀린다. 이 검사는 emit 이 다시 동기 렌더로 돌아가는 것을 막는다.
const pcStateSrc = strip(read(path.join(PC, 'state.js')));
const emitBody = (/export function emit\(\) \{[\s\S]*?\n\}/.exec(pcStateSrc) || [""])[0];
ok(/renderScheduled/.test(emitBody) && !/for \(const fn of listeners\)/.test(emitBody),
  '★ emit() 은 렌더를 예약만 한다(동기로 listeners 를 돌지 않는다)');
// ★ 예약 수단은 **마이크로태스크뿐**이다(2026-08-14 두 번째 실사고).
//  rAF 는 창이 안 보이면 아예 안 돌고, setTimeout 은 배경에서 1초 이상으로 throttle 된다.
//  처음엔 그 둘로 예약했다가 PC 전환이 **1370~2000ms** 걸리는 것을 하네스에서 실측했다.
ok(/queueMicrotask\(runListeners\)/.test(pcStateSrc),
  '★ 렌더 예약은 마이크로태스크로 한다(가시성·throttle 에 걸리지 않는 유일한 수단)');
ok(!/requestAnimationFrame\(runListeners\)/.test(pcStateSrc) && !/setTimeout\(runListeners/.test(pcStateSrc),
  '★ 렌더 예약에 rAF·setTimeout 을 쓰지 않는다(둘 다 "화면이 보이는 동안"을 전제한다)');
ok(/export function flushRender/.test(pcStateSrc),
  '동기 렌더가 필요한 경로를 위한 탈출구가 있다');

// ── 17. 터미널 팔레트는 두 플랫폼이 **같은 값 한 벌**이다 (2026-08-15) ────────
// PC theme.js 와 앱 terminalSchemes.ts 는 "값은 반드시 동일하게 유지" 라고 주석으로만 약속하고
//  있었다. 색은 한쪽만 고치기 가장 쉬운 것이라(오늘 커서색 교정이 그랬다) 실제로 대조한다.
const palTokens = (src) => (strip(src).match(/\b[a-zA-Z]+:\s*['"]#[0-9A-Fa-f]{3,8}['"]/g) || [])
  .map((t) => t.replace(/['"\s]/g, '').toLowerCase());
const pcPal = palTokens(fs.readFileSync(path.join(PC, 'theme.js'), 'utf8'));
const appPal = palTokens(fs.readFileSync(path.join(APP, 'theme/terminalSchemes.ts'), 'utf8'));
ok(pcPal.length > 100, `팔레트를 실제로 읽었다(PC ${pcPal.length}개)`);
const palDiff = pcPal.filter((t, i) => appPal[i] !== t).slice(0, 4);
ok(pcPal.length === appPal.length && !palDiff.length,
  '★ 터미널 팔레트가 PC·앱에서 같은 값 같은 순서다',
  palDiff.length ? `PC=${palDiff.join(',')} vs 앱=${palDiff.map((_, i) => appPal[pcPal.indexOf(palDiff[i])]).join(',')}` : `개수 PC=${pcPal.length} 앱=${appPal.length}`);
// ★ 커서는 액센트가 아니다(사용자 확정) — 늘 깜빡이는 것은 상태 신호가 될 수 없다.
//  `auto` 다크의 커서가 초록(액센트 #34D399)으로 되돌아가면 여기서 걸린다.
ok(!/cursor:\s*['"]#34D399['"]/i.test(fs.readFileSync(path.join(PC, 'theme.js'), 'utf8'))
  && !/cursor:\s*['"]#34D399['"]/i.test(fs.readFileSync(path.join(APP, 'theme/terminalSchemes.ts'), 'utf8')),
  '★ CodingPT 팔레트의 커서에 액센트색을 쓰지 않는다');
// ★ 드래그 색은 앱이 정한다 — `::selection` 을 정의하지 않으면 웹뷰/시스템 강조색이 고른다.
//  터미널도 이 규칙을 탄다(TUI 가 마우스 리포팅을 켜면 xterm 자체 선택이 안 만들어진다).
ok(/::selection \{[^}]*background: #264F78/.test(pcCss)
  && /\[data-theme="light"\] ::selection/.test(pcCss),
  '★ 드래그 선택색을 다크·라이트 둘 다 앱이 명시한다(플랫폼 기본값에 맡기지 않는다)');
// 선택색은 **비활성까지** 지정한다 — 안 주면 포커스가 빠지는 순간 xterm 이 30% 로 깔아 묻힌다.
ok((fs.readFileSync(path.join(PC, 'theme.js'), 'utf8').match(/selectionInactiveBackground/g) || []).length >= 2,
  '선택색은 활성·비활성 둘 다 지정한다');
// ★ 스타일은 4종(CodingPT 디자인, 2026-08-15 사용자 확정) — 값 키는 동기화 계약이라 유지하되
//  'solarized' 키의 **팔레트 블록**이 되살아나면 5종 회귀다. (이관 매핑의 문자열은 허용)
{
  const pcThemeSrc = strip(fs.readFileSync(path.join(PC, 'theme.js'), 'utf8'));
  const appSchemeSrc = strip(fs.readFileSync(path.join(APP, 'theme/terminalSchemes.ts'), 'utf8'));
  ok(!/solarized:\s*\{/.test(pcThemeSrc) && !/solarized:\s*\{/.test(appSchemeSrc),
    '★ 터미널 스타일은 4종이다(solarized 팔레트 블록 부활 금지)');
  // ★ 256색 66번 리맵 — claude 가 트루컬러 강등으로 칠하는 #5F8787(48;5;66)을 선택색으로 되돌린다.
  //  기존 세션(COLORTERM 미주입) 대비책이라 한쪽만 지우면 그 플랫폼만 세이지가 재발한다.
  ok(/TERM_REMAP_ANSI_IDX = 66/.test(pcThemeSrc) && /extendedAnsi/.test(pcThemeSrc),
    '★ PC: 66번 리맵(extendedAnsi)이 있다');
  ok(/TERM_REMAP_ANSI_IDX = 66/.test(appSchemeSrc)
    && /a\[50\] = p\.selectionBackground/.test(strip(fs.readFileSync(path.join(APP, 'components/module/ide/TerminalWebView.tsx'), 'utf8'))),
    '★ 앱: 66번 리맵이 웹뷰 안에서 조립된다(JSON 희소배열 함정 회피)');
  // ★ 근본책: 데몬이 새 세션에 트루컬러를 광고한다(COLORTERM + tmux RGB). 둘 중 하나만 있으면
  //  앱이 색을 못 그리거나(RGB 미관통) TUI 가 강등을 계속한다(COLORTERM 부재).
  const daemonPty = strip(fs.readFileSync(path.join(DAEMON, 'pty.js'), 'utf8'));
  const tmuxConf = fs.readFileSync(path.resolve('../codingpt_daemon/tmux.conf'), 'utf8');
  ok(/COLORTERM = 'truecolor'/.test(daemonPty) && /xterm-256color:RGB/.test(tmuxConf),
    '★ 데몬: COLORTERM 주입 + tmux RGB 광고가 한 쌍으로 있다');
  ok(/ensureTruecolor/.test(daemonPty),
    '★ 데몬: 이미 떠 있는 tmux 서버에도 RGB 를 소급 적용한다(conf 는 첫 기동에만 읽힌다)');

  // attach 클라이언트마다 xterm 로컬 스크롤백이 달라지면 PC 는 과거가 없고 오래 켜 둔 폰만
  // 낡은 과거를 보게 된다. 두 경로 모두 로컬 버퍼를 지운 뒤 tmux 정본 history 를 넣어야 한다.
  const pcPtyRust = fs.readFileSync(path.resolve('src-tauri/src/pty.rs'), 'utf8');
  ok(/capture-pane[\s\S]*?-S[\s\S]*?-10000[\s\S]*?-E[\s\S]*?-1/.test(pcPtyRust)
    && /\\x1b\[3J\\x1b\[H\\x1b\[2J/.test(pcPtyRust),
    '★ PC attach 는 tmux history 로 xterm 스크롤백을 초기화한다');
  ok(/buildTerminalSnapshotPayload/.test(daemonPty)
    && /capture-pane[\s\S]*?'-E', '-1'/.test(daemonPty)
    && /finishHistoryBootstrap/.test(daemonPty)
    && /SNAPSHOT_START/.test(daemonPty),
    '★ 모바일/원격 attach 도 같은 tmux history 로 스크롤백을 초기화한다');

  // 단축키 검색바는 콘텐츠와 함께 스크롤해야 한다. sticky 면 설정 헤더 아래를 떠다니며 목록을 가린다.
  const scBar = (/\.sc-bar\s*\{([^}]*)\}/.exec(pcCss) || ['', ''])[1];
  ok(!/position:\s*sticky/.test(scBar),
    '★ 단축키 검색바는 목록을 따라다니지 않는다');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
console.log('ALL CONFORMANT');
