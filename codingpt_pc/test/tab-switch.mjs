// 탭 전환 계약 — "탭을 누르면 그 탭의 터미널이 보인다"를 PC(pane.js) 와 데몬(pty.js) 양쪽에 건다.
//
// 회귀 배경(2026-10-08 이슈 #10): 오케스트레이션 워커 5개가 한 pane 의 탭으로 떠 있을 때, 탭이나 사이드바
//  세션 줄을 아무리 눌러도 본문이 코디네이터 화면 그대로였다(탭 표시만 바뀐다).
//  · PC 는 탭을 바꿀 때 스트림을 닫고 `win=<새 tid>` 로 **다시 연다**(`_reattach` → `_openChannel`).
//  · 데몬 attach 는 "이 pane 이 마지막으로 본 터미널"(paneCurrent)을 요청 win 보다 **항상 우선**했다
//    — 그 기억을 갱신하는 것은 `terminal.select` 뿐인데 PC 는 그걸 부르지 않는다.
//  → 한 pane 은 처음 붙은 터미널로만 되돌아갔다. 탭이 하나뿐인 pane 에서는 드러나지 않는다.
//  고친 계약: PC 가 `pin=1` 을 실으면 요청 win 이 이긴다. pin 없는 경로(앱·릴레이 토큰 재연결)는 그대로.
//
// 이 파일은 pane.js 의 **실제 메서드 본문**을 꺼내 가짜 데몬(위 규칙을 그대로 옮긴 것 + 데몬의 실제
//  parseParams)에 붙여 돌린다. 문자열 핀만으로는 "pin 을 안 실으면 옛 화면" 이 재현되지 않는다.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../src/js/pane.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(here, '../src/js/state.js'), 'utf8');
const DAEMON = path.join(here, '../../codingpt_daemon/packages/runner-core');
const daemonPty = fs.readFileSync(path.join(DAEMON, 'pty.js'), 'utf8');
const require = createRequire(import.meta.url);
const { parseParams } = require(path.join(DAEMON, 'terminal-local.js'));

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, `FAIL ${label}`); console.log(`PASS ${label}`); pass++; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ── pane.js 에서 메서드 본문을 그대로 꺼낸다(클래스 들여쓰기 2칸 기준) ──
function method(sig) {
  const start = src.indexOf(`\n  ${sig}`);
  assert.ok(start >= 0, `pane.js 에 ${sig} 가 없다`);
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, `${sig} 의 끝을 못 찾았다`);
  return src.slice(start + 1, end + 4);
}
const BODY = [
  'async switchTab(i) {', 'async _reattach(win) {', 'async _openChannel(win, replace) {', '_v3Connect(url) {',
  'async ensureAttached() {', 'closeTab(i) {',
].map(method).join('\n');

// ── 가짜 데몬 — attachPty 의 tid 결정 규칙만 옮긴다(pty.js: pinned / paneCurrent / resolveTid 폴백) ──
function makeDaemon(alive) {
  const paneCurrent = new Map();
  return {
    paneCurrent,
    attach(url) {
      const p = parseParams(url.replace(/^ws:\/\/[^/]+/, ''));
      const pkey = `ns|${p.paneId}|${p.client}`;
      const pinned = !!p.pin && Number.isFinite(Number(p.win)) && Number(p.win) > 0;
      const want = !pinned && paneCurrent.has(pkey) ? paneCurrent.get(pkey) : p.win;
      const tid = alive().includes(Number(want)) ? Number(want) : (alive()[0] ?? null);
      if (tid != null) paneCurrent.set(pkey, tid);
      return tid;
    },
  };
}

function build({ wins, stripPin = false, endpointDelay = () => 0 }) {
  const live = [...wins];
  const daemon = makeDaemon(() => live);
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = stripPin ? url.replace(/&?pin=1/, '') : url;
      this.readyState = 1;
      this.tid = daemon.attach(this.url);
      sockets.push(this);
    }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose(); }
  }
  let calls = 0;
  const api = {
    terminalLocalEndpoint: async () => { const d = endpointDelay(calls++); if (d) await tick(d); return { token: 't', port: 1, client: 'pc-1', device_name: 'Mac' }; },
    cloudTerminalStart: async () => ({ token: 'r', wsBase: 'ws://relay' }),
    ptyAlive: async () => true, killWindow: async () => {}, debugLog() {},
  };
  const deps = {
    api, WebSocket: FakeWS,
    isTermTab: (t) => !!t && !t.kind,
    localTmuxBackend: () => true,
    decodeTerminalFrameV3: () => null,
    TERMINAL_OPCODE_V3: {},
    i18n: { t: (s) => s },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  const Pane = new Function(...Object.keys(deps), `return class { ${BODY} };`)(...Object.values(deps));
  const pane = new Pane();
  const written = [];
  Object.assign(pane, {
    id: 'p1', mounted: true, termEl: {},
    node: { kind: 'terminal', active: 0, tabs: wins.map((w) => ({ win: w, title: `t${w}` })) },
    ctx: { isLocal: true, localPath: '/ws', persist() {}, onSurfacesChanged() {}, onClosePane() {} },
    term: { cols: 80, rows: 24, write: (s) => written.push(s) },
    _mixed: new Map(),
    heads: 0, shows: 0,
    buildHead() { this.heads++; }, showActiveTab() { this.shows++; }, focus() {},
    _fitLocalOnly() {}, _fitNow() {}, _termOut(d) { written.push(d); }, _scheduleRemoteReopen() {},
    disposeMixedTab() {},
    async _ensureWin(tab) { return tab.win; },
  });
  /** 지금 화면에 붙어 있는 터미널(살아 있는 소켓이 데몬에서 받은 tid). */
  const shown = () => (pane.ws && pane.ws.readyState === 1 ? pane.ws.tid : null);
  const open = () => sockets.filter((s) => s.readyState === 1);
  return { pane, daemon, sockets, shown, open, live, written };
}

// ── 1) 워커 탭 6개 그룹: 어느 탭을 눌러도 그 탭의 터미널이 붙는다 ──
{
  const wins = [11, 12, 13, 14, 15, 16];           // 11 = 코디네이터, 나머지 = 워커
  const h = build({ wins });
  await h.pane._openChannel(11);                   // mount 가 하는 첫 attach
  ok('첫 attach 는 활성 탭의 터미널', h.shown() === 11);
  for (const i of [3, 1, 5, 0, 4, 2, 3]) {
    await h.pane.switchTab(i); await tick();
    ok(`탭 ${i} 클릭 → 본문이 win ${wins[i]} (활성 표시와 일치)`, h.pane.node.active === i && h.shown() === wins[i]);
    ok(`탭 ${i} 클릭 → 살아 있는 소켓은 하나`, h.open().length === 1);
  }
  // 리컨실 틱(7초 pull)이 하는 일 = buildHead + ensureAttached. 방금 바꾼 탭을 되돌리지 않는다.
  const before = h.sockets.length;
  for (let k = 0; k < 3; k++) { h.pane.buildHead(); await h.pane.ensureAttached(); }
  ok('리컨실 틱이 활성 탭을 되돌리지 않는다(재attach 0건)', h.pane.node.active === 3 && h.shown() === 14 && h.sockets.length === before);
  // 채널이 죽은 뒤의 자가치유도 **활성 탭**으로 붙는다(예전엔 여기서도 처음 터미널로 돌아갔다).
  h.pane.ws.readyState = 3;
  await h.pane.ensureAttached(); await tick();
  ok('죽은 채널 자가치유 → 활성 탭의 터미널', h.shown() === 14);
}

// ── 2) pin 을 안 실으면 재현된다 — 이 테스트가 실제 결함을 잡는다는 증명 ──
{
  const h = build({ wins: [11, 12, 13], stripPin: true });
  await h.pane._openChannel(11);
  await h.pane.switchTab(2); await tick();
  ok('pin 없는 재접속은 옛 터미널로 돌아간다(=고치기 전 증상)', h.pane.node.active === 2 && h.shown() === 11);
}

// ── 3) 빠른 연타 — 마지막에 누른 탭만 붙고, 덮인 소켓이 남지 않는다 ──
{
  // 엔드포인트 조회가 거꾸로 끝나게 한다(먼저 누른 쪽이 가장 늦게 돌아온다).
  const h = build({ wins: [11, 12, 13, 14], endpointDelay: (n) => [0, 60, 30, 5][n] ?? 0 });
  await h.pane._openChannel(11);
  h.pane.switchTab(1); h.pane.switchTab(3); h.pane.switchTab(2);
  await tick(120);
  ok('연타 뒤 본문 = 마지막에 누른 탭', h.pane.node.active === 2 && h.shown() === 13);
  ok('연타 뒤 살아 있는 소켓은 하나(겹친 열기는 버려진다)', h.open().length === 1);
}

// ── 4) 교체된 소켓의 잔여 프레임은 새 탭 화면에 섞이지 않는다 ──
{
  const h = build({ wins: [11, 12] });
  await h.pane._openChannel(11);
  const old = h.pane.ws;
  await h.pane.switchTab(1); await tick();
  const n = h.written.length;
  old.onmessage && old.onmessage({ data: 'STALE-FROM-11' });
  ok('옛 소켓 프레임은 버린다', h.written.length === n);
  h.pane.ws.onmessage({ data: 'LIVE-FROM-12' });
  ok('현재 소켓 프레임은 그린다', h.written.includes('LIVE-FROM-12'));
}

// ── 5) 탭을 닫으면 남은 활성 탭의 터미널이 붙는다(닫힌 tid 의 기억 → "첫 터미널" 폴백 금지) ──
{
  const h = build({ wins: [11, 12, 13] });
  await h.pane._openChannel(11);
  await h.pane.switchTab(2); await tick();
  h.live.splice(h.live.indexOf(13), 1);            // 13 은 kill 된다
  h.pane.closeTab(2); await tick();
  ok('탭 닫기 → 새 활성 탭(12)의 터미널', h.pane.node.active === 1 && h.shown() === 12);
}

// ── 6) 소스 핀 — 양쪽 계약 문구 ──
ok('PC 는 로컬 재접속에 pin=1 을 싣는다', /q\.set\("win", String\(win\)\); q\.set\("pin", "1"\)/.test(src));
ok('PC 는 겹친 열기를 세대로 버린다', (src.match(/gen !== this\._chanGen/g) || []).length >= 3);
ok('데몬은 pin 일 때만 요청 win 을 기억보다 우선한다',
  /const want = !pinned && paneCurrent\.has\(pkey\) \? paneCurrent\.get\(pkey\) : \(params \? params\.win : undefined\);/.test(daemonPty));
// 풀 리컨실은 활성 탭을 **객체로** 기억했다가 되찾는다 — 앞쪽 탭이 빠지거나 워커 탭이 편입돼도 보던 탭이 유지된다.
ok('풀 리컨실은 활성 탭을 인덱스가 아니라 탭 객체로 보존한다',
  /const activeTab = l\.tabs\[l\.active\];/.test(stateSrc) && /const ai = l\.tabs\.indexOf\(activeTab\);\s*\n\s*l\.active = ai >= 0 \? ai :/.test(stateSrc));

console.log(`\n${pass} checks passed`);
