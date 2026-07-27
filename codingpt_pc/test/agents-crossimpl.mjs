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
const appSheet = read(path.join(APP, 'components/agents/AgentInstallSheet.tsx'));
const daemonAgents = read(path.join(DAEMON, 'agents.js'));

// ── 1. 등급 라벨·설명이 글자까지 같다 ────────────────────────────────────────
const pcTier = {};
for (const m of pcView.matchAll(/(full|partial|launch):\s*\{\s*label:\s*"([^"]+)",\s*desc:\s*"([^"]+)"/g)) {
  pcTier[m[1]] = { label: m[2], desc: m[3] };
}
ok(Object.keys(pcTier).length === 3, 'PC 등급표에서 3종을 읽어냈다', JSON.stringify(pcTier));

const appLabel = {}, appDesc = {};
for (const m of appCard.matchAll(/^\s*(full|partial|launch):\s*'([^']+)',/gm)) {
  // TIER_LABEL 과 TIER_DESC 두 표에서 순서대로 채운다(같은 키가 두 번 나온다).
  if (appLabel[m[1]] === undefined) appLabel[m[1]] = m[2];
  else if (appDesc[m[1]] === undefined) appDesc[m[1]] = m[2];
}
for (const k of ['full', 'partial', 'launch']) {
  ok(appLabel[k] === pcTier[k]?.label, `등급 라벨 일치(${k}): ${pcTier[k]?.label}`,
    `app=${appLabel[k]} pc=${pcTier[k]?.label}`);
  ok(appDesc[k] === pcTier[k]?.desc, `등급 설명 일치(${k})`,
    `\n  app=${appDesc[k]}\n  pc =${pcTier[k]?.desc}`);
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

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
console.log('ALL CONFORMANT');
