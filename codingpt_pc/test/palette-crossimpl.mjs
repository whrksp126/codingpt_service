// palette-crossimpl.mjs — 팔레트/단축키의 **PC ↔ 앱 일치** 고정.
//
// 이 기능의 핵심 위험은 세 가지다:
//  ① 검색 순위가 갈리는 것. 같은 글자를 쳤을 때 PC 와 폰에서 다른 파일이 1등이면 "내 파일이
//    어디 갔지"가 된다 → 두 구현을 **실제로 돌려** 같은 코퍼스에서 같은 순서가 나오는지 본다.
//  ② 명령 표가 갈리는 것. 팔레트 목록과 단축키 설정이 같은 표를 쓰기로 했으므로, 표가 두 벌이면
//    "폰에는 있는데 PC 엔 없는 명령"이 생긴다.
//  ③ 문구 사전에 구멍이 나는 것. commands 에 줄을 더하고 문구를 안 넣으면 팔레트에 빈 줄이 뜬다.
//
// 실행 대조는 정규식 흉내가 아니라 `--experimental-strip-types` 로 **앱 TS 원본을 그대로 실행**한다
//  (전례: 정규식 TS 스트리핑이 타입 주석에서 깨져 대조가 무의미해진 적이 있다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const read = (p) => fs.readFileSync(p, 'utf8');

// ── 공통 프로브 ──────────────────────────────────────────────────────────────
let probeSeq = 0;
function probe(modPath, body) {
  const script = `
    const m = await import(${JSON.stringify('file://' + modPath)});
    ${body}
  `;
  const tmp = path.join(os.tmpdir(), `palprobe-${process.pid}-${probeSeq++}.mjs`);
  fs.writeFileSync(tmp, script);
  try {
    return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', tmp], { encoding: 'utf8' }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}

// ── 1. 검색 판정 — 두 구현을 실제로 돌려 대조 ────────────────────────────────
// 실제 이 리포에서 뽑은 경로들. 인위적인 문자열이 아니라 사용자가 진짜 칠 법한 것으로 본다.
const CORPUS = [
  'src/js/workspace-view.js', 'src/js/pane.js', 'src/js/ide.js', 'src/js/emulator-view.js',
  'src/js/text/ports.js', 'src/js/preview-kind.js',
  'src/workspace/WorkspaceView.tsx', 'src/workspace/PaneView.tsx', 'src/workspace/IdeBody.tsx',
  'src/workspace/ide/FilePreview.tsx', 'src/workspace/EmulatorBody.tsx',
  'src/services/daemonService.ts', 'src/components/keyboard/KeyAssist.tsx',
  'package.json', 'README.md', 'src-tauri/src/tmux.rs', 'src-tauri/src/fsapi.rs',
  'packages/runner-core/cpt-server.js', 'packages/runner-core/emulator.js',
  'docs/byo-pc-design.md', 'a.js', 'ab/c.js',
];
const TERMS = [
  '', 'wsv', 'workspaceview', 'pane', 'ide', 'emu', 'mobile', 'tsx', 'src/js', 'text ports',
  'PANE', 'daemon', 'ppp', 'a', 'json', 'kb', 'runner core', '  ', 'cpt server',
];
const QUERIES = ['', 'pane', '>', '> ', '>ide', '>  add terminal ', '  file.ts', '>>x'];

const MATCH_BODY = `
  const out = {
    parse: ${JSON.stringify(QUERIES)}.map((q) => m.parseQuery(q)),
    fuzzy: ${JSON.stringify(TERMS)}.map((t) => ${JSON.stringify(CORPUS)}.map((p) => m.fuzzyScore(p, t))),
    scorePath: ${JSON.stringify(TERMS)}.map((t) => ${JSON.stringify(CORPUS)}.map((p) => m.scorePath(p, t))),
    rank: ${JSON.stringify(TERMS)}.map((t) => m.rankPaths(${JSON.stringify(CORPUS)}, t, 8)),
    labeled: [['터미널 추가','terminal add new','추가'],['IDE 추가','ide editor','ide'],['설정 열기','settings preference','pref'],['x','y','zzz']]
      .map(([l, k, t]) => m.scoreLabeled(l, k, t)),
    camel: [m.fuzzyScore('WorkspaceView', 'wv'), m.fuzzyScore('Workspaceview', 'wv'), m.fuzzyScore('workspace-view', 'wv')],
  };
  console.log(JSON.stringify(out));
`;
const pcMatch = probe(path.join(PC, 'palette-match.js'), MATCH_BODY);
const appMatch = probe(path.join(APP, 'palette/match.ts'), MATCH_BODY);

ok(JSON.stringify(pcMatch.parse) === JSON.stringify(appMatch.parse),
  `입력 해석 ${QUERIES.length}종 일치(> 접두어 포함)`,
  JSON.stringify(pcMatch.parse) + ' vs ' + JSON.stringify(appMatch.parse));
ok(JSON.stringify(pcMatch.fuzzy) === JSON.stringify(appMatch.fuzzy),
  `부분수열 점수 ${TERMS.length}×${CORPUS.length} 칸 전부 일치`);
ok(JSON.stringify(pcMatch.scorePath) === JSON.stringify(appMatch.scorePath),
  '경로 점수(파일명 가산점 포함) 일치');
const rankDiff = TERMS.map((t, i) => [t, pcMatch.rank[i], appMatch.rank[i]])
  .filter(([, p, a]) => JSON.stringify(p) !== JSON.stringify(a));
ok(rankDiff.length === 0, `검색어 ${TERMS.length}종의 **순위까지** 일치`,
  rankDiff.map(([t, p, a]) => `"${t}": pc=${JSON.stringify(p)} app=${JSON.stringify(a)}`).join(' | '));
ok(JSON.stringify(pcMatch.labeled) === JSON.stringify(appMatch.labeled), '이름/보조어 점수 일치');

// 판정 자체가 말이 되는지도 본다(둘이 똑같이 틀린 경우를 잡는다).
ok(pcMatch.parse[2].mode === 'command' && pcMatch.parse[0].mode === 'file',
  '`>` 하나로 명령 모드가 갈린다');
ok(JSON.stringify(pcMatch.camel) === JSON.stringify(appMatch.camel), 'camelCase 경계 판정 일치');
// ★ camelCase 를 낱말 경계로 세지 않으면 `wsv` 가 대시 있는 파일만 잡고 `WorkspaceView.tsx` 를
//   놓친다(실제로 이 테스트가 잡아낸 결함). 대시본과 **같은 점수**까지 올라오는 게 옳다.
ok(pcMatch.camel[0] > pcMatch.camel[1], 'camelCase 의 대문자를 낱말 시작으로 센다',
  JSON.stringify(pcMatch.camel));
ok(pcMatch.camel[0] === pcMatch.camel[2], 'WorkspaceView 와 workspace-view 가 같은 대우를 받는다',
  JSON.stringify(pcMatch.camel));
ok(pcMatch.rank[TERMS.indexOf('wsv')].slice(0, 2).includes('src/workspace/WorkspaceView.tsx'),
  '`wsv` 상위 2개 안에 WorkspaceView.tsx 가 든다', JSON.stringify(pcMatch.rank[TERMS.indexOf('wsv')]));
ok(pcMatch.rank[TERMS.indexOf('ppp')].length === 0, '안 맞는 검색어는 빈 목록(우연한 일치를 안 만든다)');
ok(JSON.stringify(pcMatch.rank[0]) === JSON.stringify(CORPUS.slice(0, 8)),
  '검색어가 비면 순서를 흔들지 않고 자르기만 한다');

// ── 2. 명령 표 — 한 벌이어야 한다 ────────────────────────────────────────────
const CMD_BODY = `
  const out = {
    all: m.COMMANDS.map((c) => [c.id, c.key, c.scope, c.group, c.pc, c.app, c.palette]),
    pc: m.commandsFor('pc').map((c) => c.id),
    app: m.commandsFor('app').map((c) => c.id),
    defaults: m.defaultBindings('pc'),
    norm: ['Mod+P','mod+p','P+Mod','CMD+Shift+D','Shift+Cmd+D','ctrl+alt+shift+k','Mod+,','Mod+Comma','Mod+ArrowLeft','p','F5','Mod','Mod+P+Q','','Mod+Space','option+cmd+arrowleft']
      .map((s) => m.normalizeCombo(s)),
    fmtMac: ['Mod+P','Mod+Shift+D','Mod+Alt+ArrowLeft','Mod+Comma','F5'].map((s) => m.formatCombo(s, true)),
    fmtWin: ['Mod+P','Mod+Shift+D','Mod+Alt+ArrowLeft','Mod+Comma','F5'].map((s) => m.formatCombo(s, false)),
    ev: [
      [{code:'KeyP', key:'p', metaKey:true}, true],
      [{code:'KeyP', key:'p', ctrlKey:true}, false],
      [{code:'KeyA', key:'å', metaKey:true, altKey:true}, true],
      [{code:'Digit1', key:'1', metaKey:true}, true],
      [{code:'Comma', key:',', metaKey:true}, true],
      [{code:'MetaLeft', key:'Meta', metaKey:true}, true],
      [{code:'KeyP', key:'p'}, true],
      [{code:'F5', key:'F5'}, true],
      [{code:'ArrowLeft', key:'ArrowLeft', metaKey:true, altKey:true}, true],
    ].map(([e, apple]) => m.comboFromEvent(e, apple)),
    conflicts: m.findConflicts({ a:'Mod+P', b:'mod+p', c:'Mod+D', d:null, e:'nonsense' }),
    resolved: m.resolveBindings('app', { 'ws.addIde': null, 'pane.close': 'Mod+Shift+K' }),
    forCombo: m.commandForCombo(m.resolveBindings('pc', null), 'Mod+P'),
  };
  console.log(JSON.stringify(out));
`;
const pcCmd = probe(path.join(PC, 'commands.js'), CMD_BODY);
const appCmd = probe(path.join(APP, 'palette/commands.ts'), CMD_BODY);

ok(JSON.stringify(pcCmd.all) === JSON.stringify(appCmd.all),
  `명령 표 ${pcCmd.all.length}줄이 id·기본조합·범위·노출까지 동일`,
  JSON.stringify(pcCmd.all.filter((r, i) => JSON.stringify(r) !== JSON.stringify(appCmd.all[i]))));
ok(JSON.stringify(pcCmd.norm) === JSON.stringify(appCmd.norm), '조합 정규화 일치');
ok(JSON.stringify(pcCmd.fmtMac) === JSON.stringify(appCmd.fmtMac), 'mac 표기 일치');
ok(JSON.stringify(pcCmd.fmtWin) === JSON.stringify(appCmd.fmtWin), '비-mac 표기 일치');
ok(JSON.stringify(pcCmd.ev) === JSON.stringify(appCmd.ev), '키 이벤트 → 조합 변환 일치');
ok(JSON.stringify(pcCmd.conflicts) === JSON.stringify(appCmd.conflicts), '충돌 검사 일치');
ok(JSON.stringify(pcCmd.resolved) === JSON.stringify(appCmd.resolved), '저장값+기본값 병합 일치');

// 판정이 말이 되는지 — 두 구현이 똑같이 틀린 경우를 잡는다.
ok(pcCmd.norm[0] === 'Mod+P' && pcCmd.norm[1] === 'Mod+P' && pcCmd.norm[2] === 'Mod+P',
  '대소문자·순서가 달라도 같은 조합으로 모인다', JSON.stringify(pcCmd.norm.slice(0, 3)));
ok(pcCmd.norm[3] === 'Mod+Shift+D' && pcCmd.norm[4] === 'Mod+Shift+D', '별칭(Cmd)과 순서를 정규화한다');
ok(pcCmd.norm[6] === 'Mod+Comma' && pcCmd.norm[7] === 'Mod+Comma', '문장부호는 이름으로 모인다(`,` = Comma)');
ok(pcCmd.norm[9] === null, '수식어 없는 단일 문자는 조합이 아니다(터미널에 글자를 못 치게 된다)');
ok(pcCmd.norm[10] === 'F5', 'F-키는 수식어 없이도 조합이 된다');
ok(pcCmd.norm[11] === null && pcCmd.norm[12] === null && pcCmd.norm[13] === null, '못 읽는 조합은 null');
ok(pcCmd.ev[2] === 'Mod+Alt+A',
  '⌥+A 가 "å" 로 와도 물리 키(code)로 A 를 잡는다', JSON.stringify(pcCmd.ev[2]));
ok(pcCmd.ev[5] === null, '수식어 키 자체는 조합이 아니다');
ok(pcCmd.ev[6] === null, '수식어 없는 글자는 조합이 아니다(터미널 입력 보호)');
ok(pcCmd.ev[1] === 'Mod+P', '비-mac 에선 Ctrl 이 Mod 로 들어온다');
ok(JSON.stringify(pcCmd.conflicts) === JSON.stringify({ 'Mod+P': ['a', 'b'] }),
  '표기가 달라도 같은 조합이면 충돌로 잡는다', JSON.stringify(pcCmd.conflicts));
ok(pcCmd.resolved['ws.addIde'] === null, '사용자가 비운 단축키는 기본값으로 되살아나지 않는다');
ok(pcCmd.resolved['pane.close'] === 'Mod+Shift+K', '사용자 지정이 기본값을 이긴다');
ok(pcCmd.resolved['ws.addTerminal'] === 'Mod+T', '건드리지 않은 것은 기본값');
ok(pcCmd.forCombo === 'palette.open', '조합 → 명령 역방향 조회');
ok(!pcCmd.app.includes('pane.splitRight') && pcCmd.pc.includes('pane.splitRight'),
  '플랫폼에 없는 명령은 그 플랫폼 목록에서 빠진다');

// ── 3. 문구 사전 — 키 집합·글자까지 ──────────────────────────────────────────
const pcText = await import(path.join(PC, 'text/palette.js'));
const appSrc = read(path.join(APP, 'text/palette.ts'));
const appBody = appSrc.slice(appSrc.indexOf('export const PALETTE_TEXT'));
const appDict = (await import('data:text/javascript,' + encodeURIComponent(
  appBody.replace('export const PALETTE_TEXT: Dict<PaletteText> =', 'export const PALETTE_TEXT =')))).PALETTE_TEXT;

// 2026-08-05 다국어를 켜면서 사전은 **한국어 한 벌**이 됐다(번역은 i18n 카탈로그가 갖는다).
//  옛 `en` 반쪽은 지우기 전에 전부 카탈로그로 회수했다 — 여기서 en 을 찾으면 undefined 다.
for (const lang of ['ko']) {
  const a = appDict[lang], p = pcText.PALETTE_TEXT[lang];
  ok(JSON.stringify(a) === JSON.stringify(p), `문구 사전이 통째로 일치(${lang})`);
}
ok(appDict.en === undefined && pcText.PALETTE_TEXT.en === undefined,
  'en 반쪽이 남아 있지 않다(두 메커니즘 공존 금지)');
for (const lang of ['ko']) {
  const d = pcText.PALETTE_TEXT[lang];
  const ids = pcCmd.all.map((r) => r[0]).sort();
  const keys = Object.keys(d.cmd).sort();
  ok(JSON.stringify(ids) === JSON.stringify(keys),
    `모든 명령에 이름이 있다(${lang}) — ${ids.length}개`,
    `표에만=${ids.filter((k) => !keys.includes(k))} 사전에만=${keys.filter((k) => !ids.includes(k))}`);
  const groups = [...new Set(pcCmd.all.map((r) => r[3]))].sort();
  ok(groups.every((g) => d.group[g]), `모든 묶음에 이름이 있다(${lang})`,
    groups.filter((g) => !d.group[g]).join(','));
  ok(Object.values(d.cmd).every((v) => v && v.trim()), `빈 이름이 없다(${lang})`);
}

// ── 4. 팔레트 자신은 목록에 없다 ─────────────────────────────────────────────
const paletteRows = pcCmd.all.filter((r) => r[6]).map((r) => r[0]);
ok(!paletteRows.includes('palette.open'), '팔레트 목록에 "팔레트 열기"가 없다');
ok(!paletteRows.some((id) => /^ws\.select[1-8]$/.test(id)),
  '워크스페이스 1~8 이동 8줄이 목록을 덮지 않는다(단축키 전용)');
ok(paletteRows.length >= 12, `팔레트에 실제로 보이는 명령이 ${paletteRows.length}개`);

console.log(`\n${fail === 0 ? 'ALL CONFORMANT' : 'NOT CONFORMANT'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
