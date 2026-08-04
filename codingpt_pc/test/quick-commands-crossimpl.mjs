// quick-commands-crossimpl.mjs — 저장한 명령(Quick Commands)의 **3플랫폼 일치**와 계약 고정.
//
// 이 라운드의 핵심 위험 셋:
//  ① 문구가 PC 와 폰에서 갈리는 것. 같은 기능인데 한쪽은 "지금 터미널", 다른 쪽은 "현재 터미널"이면
//    사용자는 두 개를 다른 기능이라고 읽는다. 그래서 두 사전을 **키·값까지** 대조한다.
//  ② `ws:''`(홈 루트 워크스페이스)가 조용히 "전역"으로 격하되는 것. 쿼리스트링 헬퍼가 빈 값을
//    버리기 때문에 실제로 벌어질 수 있었고, 그래서 목록 조회를 POST 로 뒀다 — 그 결정을 못박는다.
//  ③ 저장한 명령을 **터미널 안의 AI 가** 읽거나 실행할 수 있게 되는 것(사용자 의도의 자기해제).
import fs from 'node:fs';
import path from 'node:path';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const DAEMON = path.resolve('../codingpt_daemon/packages/runner-core');
const BACK = path.resolve('../codingpt_back');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. 문구 사전이 글자까지 같다 ─────────────────────────────────────────────
const pcText = await import(path.join(PC, 'text/quick-commands.js'));
const appSrc = read(path.join(APP, 'text/quickCommands.ts'));

// 앱 사전은 TS 라 import 할 수 없다 → 본문을 오려내 실행한다(집 규율: 소스에서 실제로 실행).
const appBody = appSrc.slice(appSrc.indexOf('export const QC_TEXT'));
// 사전을 **소스에서 잘라** 실행하므로 import 가 없다 → `i18n.t` 스텁을 앞에 붙인다.
//  스텁은 원문을 그대로 돌려준다(= 번역 미적용 상태). 여기서 보는 건 "두 사전이 같은가"이지
//  "번역이 됐는가"가 아니다 — 번역 정합성은 i18n-crossimpl.mjs 가 따로 본다.
const I18N_STUB = "const i18n={t:(s,v)=>String(s).replace(/\\{(\\w+)\\}/g,(w,k)=>(v&&v[k]!=null?String(v[k]):w))};\n";
const appDict = (await import(
  'data:text/javascript,' + encodeURIComponent(I18N_STUB + appBody.replace('export const QC_TEXT: Dict<QcText> =', 'export const QC_TEXT ='))
)).QC_TEXT;

// 2026-08-05 다국어를 켜면서 사전은 **한국어 한 벌**이 됐다(번역은 i18n 카탈로그가 갖는다).
for (const lang of ['ko']) {
  const a = appDict[lang];
  const p = pcText.QC_TEXT[lang];
  ok(!!a && !!p, `사전을 양쪽에서 읽어냈다(${lang})`);
  const aKeys = Object.keys(a).sort();
  const pKeys = Object.keys(p).sort();
  ok(JSON.stringify(aKeys) === JSON.stringify(pKeys), `키 집합 일치(${lang}) — ${aKeys.length}개`,
    `app-only=${aKeys.filter((k) => !pKeys.includes(k))} pc-only=${pKeys.filter((k) => !aKeys.includes(k))}`);
  let same = 0, diff = [];
  for (const k of pKeys) {
    const av = typeof a[k] === 'function' ? a[k]('X') : a[k];
    const pv = typeof p[k] === 'function' ? p[k]('X') : p[k];
    if (av === pv) same++; else diff.push(`${k}: app=${JSON.stringify(av)} pc=${JSON.stringify(pv)}`);
  }
  ok(diff.length === 0, `문구 ${same}/${pKeys.length} 글자까지 일치(${lang})`, diff.join(' | '));
}
// ko 와 en 이 서로 다른 언어인지(복사만 해두고 번역을 잊는 사고 방지) — title 은 실제로 다르다.
// 옛 검사("ko/en 이 실제로 다른 언어다")는 사전이 두 벌이던 시절의 것이다. 이제 번역은
//  i18n 카탈로그에 있으므로, 여기서는 **en 반쪽이 남아 있지 않은지**를 대신 못박는다
//  (두 메커니즘이 공존하면 어느 쪽을 고쳐야 하는지가 사람마다 달라진다).
ok(pcText.QC_TEXT.en === undefined && appDict.en === undefined,
  'en 반쪽이 남아 있지 않다(번역은 i18n 카탈로그가 갖는다)');

// ── 2. ws:'' 격하 방지 — 목록 조회는 POST 다 ────────────────────────────────
const routes = strip(read(path.join(BACK, 'routes/daemonRoutes.js')));
ok(/router\.post\('\/quick-commands\/list'/.test(routes),
  '목록 조회가 POST 다 — 쿼리스트링이 ws:\'\'(홈 루트)를 삼키지 않게');
ok(!/router\.get\('\/quick-commands'\s*,/.test(routes),
  '목록 조회 GET 이 남아 있지 않다(두 경로가 공존하면 한쪽만 고쳐진다)');

const appSvc = strip(read(path.join(APP, 'services/daemonService.ts')));
ok(/quick-commands\/list'[\s\S]{0,220}method: 'POST'/.test(appSvc), '앱도 POST 로 조회한다');
const pcApi = strip(read(path.join(PC, 'api.js')));
ok(/quick-commands\/list"[\s\S]{0,160}|qcList:[\s\S]{0,200}method: "POST"/.test(pcApi), 'PC 도 POST 로 조회한다');

// 데몬은 ws 가 문자열일 때만 워크스페이스 명령을 섞는다(undefined 와 '' 를 구분).
const qcMod = read(path.join(DAEMON, 'quick-commands.js'));
ok(/typeof ws !== 'string'/.test(qcMod),
  "데몬이 '워크스페이스를 모름'(undefined)과 '홈 루트'('')를 구분한다");
ok(/it\.ws == null/.test(qcMod), '전역은 오직 null 로만 표현한다(빈 문자열로 뭉개지 않는다)');

// ── 3. 터미널 안의 AI 는 저장한 명령에 닿지 못한다 ───────────────────────────
const cptServer = strip(read(path.join(DAEMON, 'cpt-server.js')));
const caps = cptServer.match(/CAPABILITIES\s*=\s*\[([\s\S]*?)\]/);
ok(!!caps, 'CAPABILITIES 목록을 읽어냈다');
ok(caps && !/['"]qc\./.test(caps[1]),
  'qc.* 가 CAPABILITIES 에 없다 — 터미널 안 AI 가 사용자의 저장 명령을 읽거나 실행할 수 없다');

// ── 4. 실행 경로는 kind 로만 갈린다(감지로 갈리지 않는다) ────────────────────
ok(/item\.kind === 'agent'/.test(cptServer), '실행 분기는 kind 로 한다');
ok(!/agentDetected|hit\.agent === true[\s\S]{0,80}chatInput/.test(cptServer),
  '터미널에 에이전트가 떠 있는지로 실행 방식을 바꾸지 않는다(같은 버튼이 상태 따라 달라지면 예측 불가)');

// ── 5. 제어문자 소독 — 저장값은 결국 터미널로 나간다 ────────────────────────
ok(/CTRL_RE/.test(qcMod) && /u0000-\\u0008/.test(qcMod.replace(/\\\\/g, '\\')),
  '제어문자(ESC·CR)를 저장 시점에 털어낸다');
ok(/\\u000B-\\u001F/.test(qcMod) || /u000B-\\u001F/.test(qcMod.replace(/\\\\/g, '\\')),
  '탭(\\t)과 개행(\\n)은 살린다 — 범위가 09/0A 를 비켜간다');

// ── 6. 관리 UI 는 한 벌이다(설정 화면과 헤더 메뉴가 같은 함수) ──────────────
const pcQc = strip(read(path.join(PC, 'quick-commands.js')));
ok(/export function renderManageInto/.test(pcQc), 'PC 관리 UI 그리기가 공용 함수로 있다');
ok(/renderManageInto\(sheet, ws/.test(pcQc), '헤더 메뉴의 시트가 그 함수를 쓴다');
const pcSettings = strip(read(path.join(PC, 'settings.js')));
ok(/renderManageInto\(host/.test(pcSettings), '설정 화면도 같은 함수를 쓴다(두 벌로 갈리지 않는다)');

// ── 7. 결과를 감추지 않는다 ─────────────────────────────────────────────────
for (const [label, src] of [['PC', pcQc], ['앱', strip(read(path.join(APP, 'workspace/QuickCommandsSheet.tsx')))]]) {
  ok(/ready === false/.test(src), `${label}: 준비 전에 보냈으면 알린다(ready:false 를 감추지 않는다)`);
  ok(/\.busy/.test(src), `${label}: 다른 게 돌고 있어 실행 안 했음을 알린다`);
  ok(/needTerminal/.test(src), `${label}: 보낼 터미널이 없으면 조용히 넘어가지 않는다`);
}

console.log(`\n${fail ? 'FAILED' : 'ALL CONFORMANT'} — pass ${pass}, fail ${fail}`);
process.exit(fail ? 1 : 0);
