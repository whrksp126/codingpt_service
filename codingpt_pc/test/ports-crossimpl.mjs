// ports-crossimpl.mjs — 열린 포트 목록의 **3플랫폼 일치**와 계약 고정.
//
// 이 기능의 핵심 위험은 두 가지다:
//  ① 판정 로직이 두 벌이 되는 것. 실제로 PC 에 Rust 사본(tmux.rs listen_ports_in)이 있었고,
//    데몬 쪽에만 프로세스 이름을 붙이면서 갈릴 뻔했다 → 사본 제거를 못박는다.
//  ② '다른 곳'(others)을 접거나 빼는 것. 사용자의 dev 서버는 전부 Docker 가 띄워서 워크스페이스
//    스코프에 한 개도 안 잡힌다 — others 를 감추면 이 사용자에게는 목록이 늘 비어 보인다.
import fs from 'node:fs';
import path from 'node:path';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const DAEMON = path.resolve('../codingpt_daemon/packages/runner-core');
const RUST = path.resolve('src-tauri/src');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. 문구 사전이 글자까지 같다 ─────────────────────────────────────────────
const pcText = await import(path.join(PC, 'text/ports.js'));
const appSrc = read(path.join(APP, 'text/ports.ts'));
const appBody = appSrc.slice(appSrc.indexOf('export const PORTS_TEXT'));
const appDict = (await import('data:text/javascript,' + encodeURIComponent(
  appBody.replace('export const PORTS_TEXT: Dict<PortsText> =', 'export const PORTS_TEXT =')))).PORTS_TEXT;

for (const lang of ['ko', 'en']) {
  const a = appDict[lang], p = pcText.PORTS_TEXT[lang];
  const aK = Object.keys(a).sort(), pK = Object.keys(p).sort();
  ok(JSON.stringify(aK) === JSON.stringify(pK), `키 집합 일치(${lang}) — ${aK.length}개`,
    `app-only=${aK.filter(k=>!pK.includes(k))} pc-only=${pK.filter(k=>!aK.includes(k))}`);
  const diff = pK.filter((k) => a[k] !== p[k]);
  ok(diff.length === 0, `문구 ${pK.length}개 글자까지 일치(${lang})`, diff.join(', '));
}

// ── 2. 판정 로직은 데몬 한 벌뿐이다 ──────────────────────────────────────────
const tmuxRs = read(path.join(RUST, 'tmux.rs'));
ok(!/listen_ports_in|tmux_listen_ports|fn listen_sockets/.test(tmuxRs),
  'PC 에 포트 판정 Rust 사본이 남아 있지 않다(데몬 한 벌로 모음)');
const libRs = read(path.join(RUST, 'lib.rs'));
ok(!/tmux_listen_ports/.test(libRs), '제거한 커맨드가 등록에도 남아 있지 않다');
ok(/ports_local/.test(read(path.join(RUST, 'cptsock.rs'))), 'PC 는 데몬 소켓으로 묻는다');
const cptServer = strip(read(path.join(DAEMON, 'cpt-server.js')));
ok(/cmd === 'net\.ports'/.test(cptServer), '데몬이 로컬 소켓에도 net.ports 를 연다');

// ── 3. others 계약 ───────────────────────────────────────────────────────────
const proxy = read(path.join(DAEMON, 'proxy.js'));
ok(/others/.test(proxy), '데몬이 스코프 밖 포트를 others 로 함께 준다');
ok(/insidePorts\.has/.test(proxy), '같은 포트가 양쪽에 중복으로 나오지 않는다');
ok(/ports: items\.map/.test(proxy), '`ports` 의 기존 의미를 유지한다(구 클라이언트 하위호환)');

for (const [label, src] of [
  ['PC', strip(read(path.join(PC, 'ports.js')))],
  ['앱', strip(read(path.join(APP, 'workspace/PortsSheet.tsx')))],
]) {
  ok(/others/.test(src), `${label}: 다른 곳 목록을 그린다`);
  // 안쪽이 비면 힌트를 낸다 = "items.length ? (없음) : 힌트" 형태
  ok(/items\.length \?[^\n]*elsewhereHint|elsewhereHint[^\n]*items\.length/.test(src)
    || /items\.length \? null : TX\.elsewhereHint/.test(src)
    || /items\.length \? undefined : TX\.elsewhereHint/.test(src),
    `${label}: 힌트는 안쪽이 비었을 때만 낸다`);
}

// ── 4. 무엇이 열릴지 모른 채 누르던 버튼을 없앴다 ────────────────────────────
const pane = strip(read(path.join(PC, 'pane.js')));
ok(/openPortsMenu/.test(pane), 'PC 빈 프리뷰의 "dev 열기" 가 목록을 연다');
ok(!/openDevPortPC\(\)/.test(pane), 'PC 가 첫 포트를 말없이 열지 않는다');
const appPane = strip(read(path.join(APP, 'workspace/PaneView.tsx')));
ok(/setPortsSheet\(true\)/.test(appPane), '앱도 목록을 연다');
ok(!/previewPorts\(cwd, host\)[\s\S]{0,120}ports\[0\]/.test(appPane), '앱도 첫 포트를 말없이 열지 않는다');

// ── 5. 주소창에서도 포트를 고를 수 있다(양쪽 다) ─────────────────────────────
ok(/kind: "p"|kind === "p"/.test(pane), 'PC 주소창 드롭다운에 포트 항목이 있다');
ok(/kind: 'p'|kind === 'p'/.test(appPane), '앱 주소창 드롭다운에 포트 항목이 있다');

console.log(`\n${fail ? 'FAILED' : 'ALL CONFORMANT'} — pass ${pass}, fail ${fail}`);
process.exit(fail ? 1 : 0);
