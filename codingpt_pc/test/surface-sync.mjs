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

// ── ④' 더블링 — 같은 sid 둘·에이전트 PC 둘은 둘째를 즉시 닫는다(2026-09-20 폰 실사고: 흡수 뒤 탭 2개) ──
{
  _reset(); pane.closed.length = 0;
  const term = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }, { kind: 'emulator', deviceId: 'desktop:main', sid: 'D' }, { kind: 'emulator', deviceId: 'desktop:main', sid: 'D' }, { kind: 'preview', url: 'u', sid: 'P' }, { kind: 'preview', url: 'u', sid: 'P' }], active: 0 };
  const w = { layout: term, focusId: 't1' };
  reconcile(meta, w, [{ id: 'D', kind: 'emulator', deviceId: 'desktop:main' }, { id: 'P', kind: 'preview', url: 'u' }]);
  ok(pane.closed.length === 2 && pane.closed.some(([, i]) => i === 2) && pane.closed.some(([, i]) => i === 4), '둘째 에이전트 PC·둘째 같은 sid 프리뷰를 닫는다');
}

// ── ⑤ pane↔탭 왕복에 sid 가 보존된다 ──
{
  const l = T.leaf('emulator', { deviceId: 'desktop:main', sid: 'S' });
  const tab = T.leafToTab(l);
  ok(tab.sid === 'S' && T.tabToLeaf(tab).sid === 'S', 'leafToTab/tabToLeaf 왕복 sid 보존');
  ok(T.leafToTab(T.leaf('ide', { openPath: 'a', sid: 'I' })).sid === 'I' && T.leafToTab(T.leaf('preview', { url: 'u', sid: 'P' })).sid === 'P', 'ide/preview 도');
}

// ── ⑥ 채팅(채팅 v2 대화 탭, chat-v2-design §10.7) ──
{
  const { chatSid, SURFACE_KINDS } = await import('../src/js/surface-sync.js');
  ok(SURFACE_KINDS.has('chat'), 'chat 은 공유 표면 종류다');
  // 탭 종류 왕복 — threadId·title·draft·sid 를 잃지 않는다
  const leaf = T.leaf('chat', { threadId: 'th-1', title: '리팩터링', draft: '쓰다 만 글', sid: 'c-th-1' });
  ok(leaf.kind === 'chat' && leaf.threadId === 'th-1' && !('tabs' in leaf), "T.leaf('chat') 이 터미널 leaf 를 만들지 않는다");
  const tab = T.leafToTab(leaf);
  ok(tab.kind === 'chat' && tab.threadId === 'th-1' && tab.title === '리팩터링' && tab.draft === '쓰다 만 글' && tab.sid === 'c-th-1' && !!tab.tid, 'leaf → 탭(threadId·title·draft·sid)');
  const back = T.tabToLeaf(tab, 'pX');
  ok(back.id === 'pX' && back.kind === 'chat' && back.threadId === 'th-1' && back.title === '리팩터링' && back.draft === '쓰다 만 글' && back.sid === 'c-th-1' && back.tid === tab.tid, '탭 → leaf 왕복(잃는 것 없음)');
  ok(T.leafToTab(back).tid === tab.tid, '다시 탭으로 — tid 유지(본문 DOM 의 열쇠)');
  const blank = T.leaf('chat');
  ok(blank.kind === 'chat' && !('threadId' in blank) && !('title' in blank) && !('draft' in blank), '새 대화는 빈 필드를 만들지 않는다');
  ok(T.leaf('chat', { draft: 'x'.repeat(9000) }).draft.length === 4096, '초안은 4KB 까지');
  ok(T.TAB_KINDS.includes('chat'), '혼합 탭으로 편입할 수 있는 종류다');

  // 등록: threadId 가 없는 새 채팅 탭은 표면이 아니다
  const term = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }, { kind: 'chat', tid: 'a' }, { kind: 'chat', tid: 'b', threadId: 'th-9', title: '제목', sid: 'random-old' }], active: 0 };
  const list = surfacesOf(term);
  ok(list.length === 1 && list[0].kind === 'chat' && list[0].threadId === 'th-9' && list[0].title === '제목', '★ threadId 없는 새 채팅 탭은 등록하지 않는다(기기 로컬)');
  ok(list[0].sid === chatSid('th-9') && term.tabs[2].sid === 'c-th-9' && !term.tabs[1].sid, '★ 채팅의 공유 id 는 대화에서 나온다(c-<threadId>)');
  ok(/^[A-Za-z0-9_-]{1,64}$/.test(chatSid('21b28dc2-aaaa-4bbb-8ccc-1234567890ab')), '데몬 surfaces.js 가 받는 id 모양이다');
  ok(surfacesOf(T.leaf('chat')).length === 0 && surfacesOf(T.leaf('chat', { threadId: 'x' }))[0].sid === 'c-x', '독립 pane 도 같은 규칙');

  // 밖→안: 목록의 채팅을 탭으로 들인다
  _reset(); pane.closed.length = 0;
  const t2 = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }], active: 0 };
  const w = { layout: t2, focusId: 't1' };
  reconcile(meta, w, [{ id: 'c-th-2', kind: 'chat', threadId: 'th-2', title: '다른 기기가 연 대화' }]);
  ok(t2.tabs.length === 2 && t2.tabs[1].kind === 'chat' && t2.tabs[1].threadId === 'th-2' && t2.tabs[1].title === '다른 기기가 연 대화' && t2.tabs[1].sid === 'c-th-2', '채팅 탭 편입(threadId·title·sid)');
  // 같은 대화를 다른 id 로 올린 기록 — 탭을 또 만들지 않는다
  reconcile(meta, w, [{ id: 'c-th-2', kind: 'chat', threadId: 'th-2' }, { id: 'chat-xyz', kind: 'chat', threadId: 'th-2' }]);
  ok(t2.tabs.length === 2, '★ 같은 대화를 다른 id 로 올린 기록이 있어도 탭은 하나다');
  // 다른 클라가 다른 id 로만 올렸고 내 것(c-…)은 아직 목록에 없다 — 내 탭을 닫지 않는다
  reconcile(meta, w, [{ id: 'chat-xyz', kind: 'chat', threadId: 'th-2' }]);
  reconcile(meta, w, [{ id: 'chat-xyz', kind: 'chat', threadId: 'th-2' }]);
  ok(pane.closed.length === 0 && t2.tabs.length === 2, '대화가 목록에 있는 한(어떤 id 로든) 내 탭을 닫지 않는다');
  // 목록에서 사라지면 2틱 뒤 닫는다(다른 기기가 닫음)
  reconcile(meta, w, []);
  reconcile(meta, w, []);
  ok(pane.closed.length === 1 && pane.closed[0][1] === 1, '다른 기기가 닫으면 여기서도 닫는다(2틱 유예)');
  // 새 채팅 탭(threadId 없음)은 목록이 비어도 닫히지 않는다
  _reset(); pane.closed.length = 0;
  const t3 = { id: 't1', kind: 'terminal', tabs: [{ win: 1 }, { kind: 'chat', tid: 'n' }], active: 0 };
  const w3 = { layout: t3, focusId: 't1' };
  reconcile(meta, w3, []); reconcile(meta, w3, []); reconcile(meta, w3, []);
  ok(pane.closed.length === 0 && t3.tabs.length === 2, '첫 메시지 전의 새 채팅 탭은 리컨실이 건드리지 않는다');
  // 터미널 pane 이 없으면 분할로
  _reset();
  const w4 = { layout: T.leaf('ide', { openPath: 'x' }), focusId: null };
  reconcile(meta, w4, [{ id: 'c-th-5', kind: 'chat', threadId: 'th-5', title: 'T' }]);
  ok(w4.layout.dir && w4.layout.second.kind === 'chat' && w4.layout.second.threadId === 'th-5' && w4.layout.second.title === 'T', '분할 편입(chat leaf)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
