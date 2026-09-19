// 공유 표면 동기화(surface-sync.js) — 밖→안 리컨실 규율을 실제 모듈로 검증한다.
//  state/api/pane/i18n 은 tauri 에 묶여 있어 로더 훅으로 스텁을 꽂는다(순수 로직만 돈다).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const stubs = {
  './api.js': `export const api = { debugLog() {}, surfaceAdd: async (cwd, it) => ({ ok: true, item: it }), surfaceUpdate: async () => ({ ok: true }), surfaceRemove: async () => ({ ok: true }) };`,
  './pane.js': `export const closed = []; export function getPane(id) { return { closeTab(i) { closed.push([id, i]); } }; }`,
  './state.js': `export const state = { workspaces: [], activeWsId: null }; export function wsRuntime() { return null; } export function isThisHost() { return true; } export function emit() {}`,
  './i18n/index.js': `export function t(s) { return s; }`,
};
const hook = `
  const stubs = ${JSON.stringify(stubs)};
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith('stub:')) return { url: spec, shortCircuit: true };
    if (stubs[spec] && ctx.parentURL && ctx.parentURL.endsWith('/src/js/surface-sync.js')) return { url: 'stub:' + spec, shortCircuit: true };
    return next(spec, ctx);
  }
  export async function load(url, ctx, next) {
    if (url.startsWith('stub:')) return { format: 'module', source: stubs[url.slice(5)], shortCircuit: true };
    return next(url, ctx);
  }
`;
register('data:text/javascript,' + encodeURIComponent(hook), pathToFileURL('./'));
// 훅 스레드가 뜰 시간을 준다(register 는 비동기로 붙는다)
await new Promise((r) => setTimeout(r, 50));

const T = await import('../src/js/tiling.js');
const { reconcile, surfacesOf, _reset } = await import('../src/js/surface-sync.js');
const pane = await import('stub:./pane.js');   // surface-sync 가 받은 것과 같은 스텁 인스턴스

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const meta = { id: 'ws1', localPath: 'proj' };

// ── surfacesOf: leaf·혼합 탭 둘 다, sid 없는 것엔 붙인다(프리뷰는 tid, 나머지는 id/새 id) ──
{
  const pv = T.leaf('preview', { url: 'http://x' }); pv.tid = 'pvtid';
  const term = { id: 't1', kind: 'terminal', tabs: [{ win: 3 }, { kind: 'ide', openPath: 'a.js', tid: 'idetid' }, { kind: 'emulator', deviceId: 'desktop:main' }], active: 0 };
  const layout = { id: 'r', dir: 'row', first: pv, second: term };
  const list = surfacesOf(layout);
  ok(list.length === 3, 'surfacesOf — 프리뷰 leaf + ide/emulator 탭 = 3');
  ok(list[0].sid === 'pvtid' && pv.sid === 'pvtid', '프리뷰 leaf 의 sid = tid(webview 키)');
  ok(list[1].sid === 'idetid', 'ide 탭의 sid = tid');
  ok(typeof list[2].sid === 'string' && list[2].sid.length > 0 && term.tabs[2].sid === list[2].sid, 'tid 없는 탭엔 새 sid');
  ok(surfacesOf(layout)[2].sid === list[2].sid, '두 번 불러도 같은 sid(안정)');
}

// ── reconcile ① 목록에만 있는 것 → 포커스 터미널 pane 의 탭으로(sid 유지·에이전트 PC 제목) ──
{
  _reset();
  const term = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }], active: 0 };
  const w = { layout: term, focusId: 't1' };
  const touched = reconcile(meta, w, [
    { id: 'sA', kind: 'preview', url: 'http://localhost:3000' },
    { id: 'sB', kind: 'emulator', deviceId: 'desktop:main' },
    { id: 'sX', kind: 'terminal' },   // 모르는 종류는 무시
  ]);
  ok(touched.has('t1'), '편입된 pane 이 touched 에');
  ok(term.tabs.length === 3 && term.tabs[1].sid === 'sA' && term.tabs[1].url === 'http://localhost:3000', '프리뷰 탭 편입(sid·url)');
  ok(term.tabs[2].kind === 'emulator' && term.tabs[2].deviceId === 'desktop:main' && term.tabs[2].metaName === '에이전트 PC', '에이전트 PC 탭 편입(제목)');
  //  같은 목록으로 다시 — 변화 없음
  const t2 = reconcile(meta, w, [{ id: 'sA', kind: 'preview', url: 'http://localhost:3000' }, { id: 'sB', kind: 'emulator', deviceId: 'desktop:main' }]);
  ok(t2.size === 0 && term.tabs.length === 3, '멱등 — 두 번째 리컨실은 아무것도 안 한다');
  // ── ② 목록에서 사라짐 → 1틱 유예(miss) → 2틱째 closeTab ──
  const t3 = reconcile(meta, w, [{ id: 'sB', kind: 'emulator', deviceId: 'desktop:main' }]);
  ok(t3.size === 0 && term.tabs[1].miss === 1 && term.tabs.length === 3, '1틱째는 유예(miss=1)');
  reconcile(meta, w, [{ id: 'sB', kind: 'emulator', deviceId: 'desktop:main' }]);
  ok(pane.closed.length === 1 && pane.closed[0][0] === 't1' && pane.closed[0][1] === 1, '2틱째 pane.closeTab(1) 로 닫는다');
  //  다시 나타나면 miss 해제
  term.tabs[1].miss = 1;
  reconcile(meta, w, [{ id: 'sA', kind: 'preview', url: 'http://localhost:3000' }, { id: 'sB', kind: 'emulator', deviceId: 'desktop:main' }]);
  ok(term.tabs[1].miss === undefined, '목록에 다시 있으면 유예 표식 해제');
}

// ── ③ 이 기기가 아직 등록 안 한(모르는) 표면은 목록에 없어도 닫지 않는다 ──
{
  _reset();
  const term = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }, { kind: 'preview', url: 'http://mine', tid: 'mine' }], active: 0 };
  const w = { layout: term, focusId: 't1' };
  reconcile(meta, w, []); reconcile(meta, w, []); reconcile(meta, w, []);
  ok(term.tabs.length === 2 && !term.tabs[1].miss, '등록 전(known 아님) 표면은 목록이 비어도 보존');
}

// ── ④ 터미널 pane 이 없으면 첫 leaf 우측 분할로 들인다(leaf 에 sid) ──
{
  _reset();
  const w = { layout: T.leaf('ide', { openPath: 'x' }), focusId: null };
  const touched = reconcile(meta, w, [{ id: 'sP', kind: 'preview', url: 'http://p' }]);
  ok(touched.has('*') && w.layout.dir && w.layout.second.kind === 'preview' && w.layout.second.sid === 'sP', '분할 편입 + sid');
}

// ── ⑤ pane↔탭 왕복에 sid 가 보존된다 ──
{
  const l = T.leaf('emulator', { deviceId: 'desktop:main', sid: 'S' });
  const tab = T.leafToTab(l);
  ok(tab.sid === 'S' && T.tabToLeaf(tab).sid === 'S', 'leafToTab/tabToLeaf 왕복 sid 보존');
  ok(T.leafToTab(T.leaf('ide', { openPath: 'a', sid: 'I' })).sid === 'I' && T.leafToTab(T.leaf('preview', { url: 'u', sid: 'P' })).sid === 'P', 'ide/preview 도');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
