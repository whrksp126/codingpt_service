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

// ── 2. 등급 문구가 사실과 맞는다(원격 승인은 claude 뿐) ──────────────────────
ok(/원격 승인/.test(pcTier.full?.desc || ''), 'full 만 원격 승인을 약속한다');
ok(/원격 승인은 지원하지 않아요/.test(pcTier.partial?.desc || ''),
  'partial 은 원격 승인이 안 된다고 **명시**한다(폰에서 오지 않는 카드를 기다리게 하지 않는다)');
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
const agCssBlock = (/\/\* ── 에이전트 관리[\s\S]*$/.exec(pcCss) || [''])[0];
ok(!/var\(--accent\)/.test(agCssBlock), 'PC: 에이전트 영역 CSS 에 accent 가 없다');
ok(!/backgroundColor: C\.accent/.test(appSheet), '앱: 설치 패널 버튼에 accent 배경이 없다');

// 설치는 **모달 위 모달을 만들지 않는다** → 행 아래 인라인 확장.
ok(/ag-panel/.test(pcView) && !/openInstallSheet/.test(pcView),
  'PC: 설치는 인라인 패널이다(별 모달 openInstallSheet 폐기)');
ok(!/<Modal/.test(appSheet), '앱: 설치 패널은 Modal 이 아니다(설정 모달 위에 겹치지 않는다)');
// 설치 명령은 탭 전환이 아니라 전부 세로로 보여준다.
ok(!/ag-methods|scale-seg/.test(pcView), 'PC: 설치 명령을 탭(세그먼트)으로 감추지 않는다');
ok(/methods\.map/.test(appSheet), '앱: 설치 명령을 전부 나열한다');

// 온보딩 토글은 **우측**(목록 화면과 같은 배치).
const onbBlock = (/ag-onb-list[\s\S]*?\}\)\.join\(""\)/.exec(pcView) || [''])[0];
// ⚠ `ag-onb` 만 찾으면 블록 시작인 `ag-onb-list` 에 걸려 항상 0 이 나온다(첫 판본이 그랬다) →
//  체크박스의 실제 class 문자열로 찾는다.
const tglAt = onbBlock.indexOf('class="tgl ag-onb"');
ok(tglAt > 0 && onbBlock.indexOf('ag-main') < tglAt,
  'PC 온보딩: 토글이 이름 오른쪽에 온다(좌측 배치 되돌림 방지)',
  `ag-main=${onbBlock.indexOf('ag-main')} tgl=${tglAt}`);

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
// ★ 잘림 판정은 **대리 지표가 아니라 실제 rect** 로 한다(네 번째 시도에서 확정).
//  FitAddon 제안값·viewport.clientWidth·스크롤바 폭 추정은 부모 padding(border-box)·스크롤바
//  존재 여부·Retina 셀 폭 반올림 때문에 실제와 계속 어긋났다("여유 10px" 인데 잘렸다).
ok(/getBoundingClientRect\(\)/.test(pcPane) && /xterm-screen/.test(pcPane),
  'PC: .xterm-screen 실제 rect 와 잘리는 상자(.pane-term) rect 를 비교한다');
ok(/sc\.right - \(box\.right/.test(pcPane), 'PC: 우변 초과분을 셀 폭으로 나눠 줄인다');
ok(!/term-fit/.test(pcPane), 'PC: 폐기한 대리 지표 모듈을 다시 참조하지 않는다');
ok(/setTimeout\([\s\S]{0,120}_fitNow\(\)/.test(pcPane),
  'PC: 채널 개설 후 지연 재검산이 있다(ResizeObserver 는 크기 불변 시 안 울린다)');

ok(/this\._sentCols === cols && this\._sentRows === rows/.test(pcPane),
  'PC: 크기가 안 바뀌면 resize 를 보내지 않는다(7초마다 tmux 창 재클레임 = 폰 크기 뺏기)');

ok(/\.xterm-viewport::-webkit-scrollbar \{ width: 0/.test(pcCss),
  'PC: 터미널 스크롤바를 두지 않는다(뺄 폭을 맞추는 대신 문제군을 제거 — 되돌리면 잘림 재발)');

// 우측 "공간 예약" 시도는 되돌렸다(pane 자체가 창을 넘는 상황에서 잘림을 키운다 — 사용자 실측).
//  다만 **안쪽 padding 으로 예약하려는 시도는 무효**라는 실측 결론은 CSS 주석으로 남겨 둔다:
//  FitAddon 이 부모 폭을 border-box(padding 포함)로 읽고 자기 padding 만 빼므로 정확히 상쇄된다.
//  그 근거가 사라지면 다음 사람이 같은 무효 수정을 반복한다.
ok(/안쪽 padding 으로 주는 것은 \*\*무효\*\*/.test(pcCss),
  'PC: "안쪽 padding 예약은 무효" 실측 결론이 CSS 에 기록돼 있다');
// pane 이 창을 넘는지를 진단에 남긴다(pane 내부 초과만 보면 이 경우를 못 본다).
ok(/pane가창을넘음/.test(pcPane), 'PC: pane 우변이 창 안쪽 폭을 넘는지 로그에 남긴다');

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
console.log('ALL CONFORMANT');
