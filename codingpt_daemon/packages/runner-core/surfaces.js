'use strict';

// 공유 표면 목록 — 프리뷰·IDE·모바일 화면(에이전트 PC 포함) 의 **존재**를 기기 사이에 나눈다.
//
// 사용자 결정(2026-09-20): "PC 에서 열어둔 pane 이 다른 기기에도 즉시 보여야 한다" — 2026-07-23 의 "표면
//  생명주기는 기기별" 결정을 뒤집었다. 터미널이 이미 그렇게 돈다(tmux 세션 = 전 기기 내역, 배치만 기기 로컬).
//  표면도 같은 모양으로 간다: **어느 기기에서 열면 전부에 나타나고, 어디서 닫으면 전부에서 사라진다.**
//  배치(어느 pane·탭 순서)는 여전히 기기 로컬이고, 프리뷰 주소·IDE 파일 같은 속성은 **열 때 한 번** 넘겨준다
//  (그 뒤 각 기기가 독립적으로 오간다 — 폰에서 넘기는 페이지가 PC 화면을 끌고 가지 않게).
//
// 정본은 이 파일(<stateDir>/surfaces.json) 이다. 터미널과 달리 살아 있는 실체(tmux)가 없으므로 기록이 곧 존재다.
//  · id = 클라이언트가 만든 표면 id(sid). 같은 id 로 다시 add 하면 갱신(멱등) — 기기 두 대가 같은 걸 등록해도 하나.
//  · 에이전트 PC(deviceId `desktop:<os>`)는 OS별로 하나 — 같은 OS 를 다른 id 로 add 하면 있는 것을 돌려준다(macOS·Linux 는 공존)
//    (클라이언트는 돌려받은 id 를 자기 탭에 붙인다). 맥 1대 = 에이전트 PC 1대.
//  · 변경은 pool.changed 로 전 기기에 즉시 알린다(터미널과 같은 신호 — 리컨실러가 바로 다시 읽는다).
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const FILE = () => path.join(runtime.stateDir(), 'surfaces.json');
const KINDS = new Set(['preview', 'ide', 'emulator']);
const MAX_PER_WS = 64;

let notify = () => {};
/** 변경 알림 훅(cpt-server 가 pool.changed 브로드캐스트를 건다). */
function setNotify(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const items = Array.isArray(j && j.items) ? j.items : [];
    //  ★ 레거시 `desktop:main` 표면은 버린다(OS별 분리 전 잔재) — 지금은 desktop:macos/linux 만 쓴다.
    //   그대로 두면 macOS pane 이 둘로 보인다(desktop:main 이 macOS 로 렌더). 읽을 때 걸러 자가 치유한다.
    return items.filter((s) => s && typeof s.id === 'string' && typeof s.ws === 'string' && KINDS.has(s.kind) && s.deviceId !== 'desktop:main');
  } catch (_) { return []; }
}

function save(items) {
  fs.mkdirSync(runtime.stateDir(), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), items }, null, 2));
  fs.renameSync(tmp, FILE());
}

/** 워크스페이스 키 — 홈 기준 상대·절대·`~/` 가 섞여 들어와도 같은 폴더면 같은 키. */
function wsKey(cwd) {
  let s = String(cwd || '').trim();
  if (!s) return '';
  const home = runtime.root();
  if (s.startsWith('~/')) s = path.join(home, s.slice(2));
  if (!path.isAbsolute(s)) s = path.join(home, s);
  s = path.normalize(s).replace(/[\\/]+$/, '');
  try { s = fs.realpathSync(s); } catch (_) { /* 없는 폴더 — 문자열 그대로 */ }
  return s;
}

function cleanId(id) {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

/** 와이어에 싣는 속성만(기기 로컬 상태·내부 필드는 걸러 낸다). */
function pick(o = {}) {
  const out = {};
  if (typeof o.url === 'string') out.url = o.url.slice(0, 2048);
  if (typeof o.openPath === 'string' || o.openPath === null) out.openPath = o.openPath ? String(o.openPath).slice(0, 1024) : null;
  if (typeof o.deviceId === 'string' || o.deviceId === null) out.deviceId = o.deviceId ? String(o.deviceId).slice(0, 128) : null;
  if (typeof o.title === 'string') out.title = o.title.slice(0, 256);
  return out;
}

const isDesk = (s) => s && s.kind === 'emulator' && typeof s.deviceId === 'string' && s.deviceId.startsWith('desktop:');
const strip = (s) => { const { ws, ...rest } = s; return rest; };
/** 내용 비교용 — 시각 필드는 뺀다(같은 내용을 다시 넣어도 변경이 아니다). */
const body = (s) => { const { ws, createdAt, updatedAt, ...rest } = s; return JSON.stringify(rest); };

function list({ cwd } = {}) {
  const ws = wsKey(cwd);
  return { items: load().filter((s) => s.ws === ws).map(strip) };
}

function add({ cwd, id, kind, ...props } = {}) {
  const ws = wsKey(cwd); const sid = cleanId(id);
  if (!ws) throw new Error('cwd 가 필요합니다.');
  if (!sid) throw new Error('id 가 필요합니다.');
  if (!KINDS.has(kind)) throw new Error('kind 는 preview|ide|emulator 중 하나입니다.');
  const items = load();
  const p = pick(props);
  //  레거시 desktop:main 은 등록하지 않는다(위 load 필터와 짝) — 클라가 옛 레이아웃으로 다시 올려도 무시 → 리컨실이 그 탭을 정리한다.
  if (p.deviceId === 'desktop:main') return { ok: true, legacy: true };
  // 에이전트 PC 는 **OS별로** 하나(macOS·Linux 독립). 같은 OS(deviceId)가 이미 있으면 그걸 돌려준다(다른 id 로 온 중복만 흡수).
  //  ★ 예전엔 desktop 전체를 하나로 흡수해서 둘째 OS 표면이 첫째로 합쳐졌다(2026-09-21 실사고: Linux 뒤 macOS 열면 탭이 하나로).
  if (kind === 'emulator' && p.deviceId && p.deviceId.startsWith('desktop:')) {
    const had = items.find((s) => s.ws === ws && isDesk(s) && s.deviceId === p.deviceId);
    if (had && had.id !== sid) return { ok: true, item: strip(had), merged: true };
  }
  const now = Date.now();
  const i = items.findIndex((s) => s.ws === ws && s.id === sid);
  let item;
  if (i >= 0) {
    item = { ...items[i], ...p, kind, updatedAt: now };
    if (body(item) === body(items[i])) return { ok: true, item: strip(items[i]) };
    items[i] = item;
  } else {
    if (items.filter((s) => s.ws === ws).length >= MAX_PER_WS) throw new Error('표면이 너무 많습니다.');
    item = { id: sid, ws, kind, ...p, createdAt: now, updatedAt: now };
    items.push(item);
  }
  save(items);
  notify();
  return { ok: true, item: strip(item) };
}

function update({ cwd, id, ...props } = {}) {
  const ws = wsKey(cwd); const sid = cleanId(id);
  const items = load();
  const i = items.findIndex((s) => s.ws === ws && s.id === sid);
  if (i < 0) return { ok: true, missing: true };
  const p = pick(props);
  const next = { ...items[i], ...p };
  if (body(next) === body(items[i])) return { ok: true, item: strip(items[i]) };
  next.updatedAt = Date.now();
  items[i] = next;
  save(items);
  //  속성 변경은 다른 기기의 열린 탭을 끌고 가지 않는다(리컨실러가 존재만 본다) — 그래도 알린다: 늦게
  //   합류하는 기기가 최신 속성으로 열게 목록이 갱신됐다는 뜻이다.
  notify();
  return { ok: true, item: strip(next) };
}

function remove({ cwd, id } = {}) {
  const ws = wsKey(cwd); const sid = cleanId(id);
  const items = load();
  const next = items.filter((s) => !(s.ws === ws && s.id === sid));
  if (next.length === items.length) return { ok: true, missing: true };
  save(next);
  notify();
  return { ok: true };
}

/** 워크스페이스 삭제 때 — 그 폴더의 표면 기록을 전부 지운다. */
function forgetWs(cwd) {
  const ws = wsKey(cwd);
  const items = load();
  const next = items.filter((s) => s.ws !== ws);
  if (next.length !== items.length) save(next);
  return items.length - next.length;
}

async function handle(method, params = {}) {
  switch (method) {
    case 'surface.list': return list(params);
    case 'surface.add': return add(params);
    case 'surface.update': return update(params);
    case 'surface.remove': return remove(params);
    default: throw new Error(`알 수 없는 메서드: ${method}`);
  }
}

module.exports = { handle, list, add, update, remove, forgetWs, wsKey, setNotify, KINDS, _file: FILE };
