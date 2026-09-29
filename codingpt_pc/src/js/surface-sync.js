// 공유 표면 동기화 — 프리뷰·IDE·모바일 화면(에이전트 PC 포함) 의 **존재**를 기기 사이에 나눈다.
//
// 사용자 결정(2026-09-20): "PC 에서 열어둔 pane 이 다른 기기에도 즉시 보여야 한다" — 2026-07-23 의 "표면은 기기별"
//  결정을 뒤집었다. 터미널 풀과 같은 모양으로 간다: 어느 기기에서 열면 전부에 나타나고, 어디서 닫으면 전부에서
//  사라진다. 배치(어느 pane·탭 순서)는 여전히 기기 로컬. 정본은 데몬의 surfaces.json(`surface.*` RPC).
//
// 두 방향:
//  · 안→밖(`sync`): 레이아웃이 바뀔 때마다(emit) 이 PC 의 표면 목록을 데몬 기록과 맞춘다 — 새로 생긴 건 add,
//    사라진 건 remove, 주소·파일이 바뀐 건 update. 표면마다 `sid`(공유 id) 를 붙여 기기 사이를 잇는다.
//  · 밖→안(`reconcile`): 리컨실러(7초 + pool.changed 즉시) 가 데몬 목록을 읽어 없는 건 탭으로 들이고, 기록에서
//    사라진 건 2틱 유예 뒤 닫는다(터미널 리컨실러와 같은 규율 — 목록 스냅샷은 요청 시작 시점 기준이라 방금
//    등록한 표면이 빠져 있을 수 있다; 등록 중인 것은 pendingAdd 로 보호).
//
// 에이전트 PC 는 워크스페이스에 하나 — 데몬이 다른 id 를 기존 것으로 흡수(merged)하면 로컬 sid 를 갈아 끼운다.
import { api } from "./api.js";
import * as T from "./tiling.js";
import * as S from "./state.js";
import { getPane } from "./pane.js";
import * as i18n from './i18n/index.js';

export const SURFACE_KINDS = new Set(["preview", "ide", "emulator"]);

/** wsId → Map<sid, 등록된 속성 키>. 없으면 아직 한 번도 안 맞춘 것(첫 sync 가 전부 등록한다). */
const known = new Map();
/** 등록 RPC 가 아직 안 돌아온 sid — 리컨실러가 "목록에 없다" 고 닫지 않게. */
const pendingAdd = new Set();
let timer = null;
let syncing = false;
let dirty = false;

const knownFor = (wsId) => { let m = known.get(wsId); if (!m) { m = new Map(); known.set(wsId, m); } return m; };
const propsOf = (e) => ({ url: e.url ?? undefined, openPath: e.openPath ?? null, deviceId: e.deviceId ?? null, title: e.title || undefined });
const keyOf = (e) => JSON.stringify(propsOf(e));

/**
 * 레이아웃 안의 표면 전부 — 독립 pane(leaf) 과 혼합 탭 둘 다. sid 가 없는 것(이 기능 이전 저장본·방금 만든 것)
 *  에는 여기서 붙인다(tid 가 있으면 그대로 — 프리뷰는 tid 가 webview 키라 안정적이다).
 */
let assignedSid = false;   // surfacesOf 가 sid 를 새로 붙였다 — 저장본에 남게 한 번 더 emit 한다
export function surfacesOf(layout) {
  const out = [];
  T.eachLeaf(layout, (l) => {
    if (SURFACE_KINDS.has(l.kind)) {
      if (!l.sid) { l.sid = l.tid || l.id; assignedSid = true; }
      out.push({ sid: l.sid, kind: l.kind, url: l.url, openPath: l.openPath, deviceId: l.deviceId, title: l.metaName || l.metaTitle || "", leafId: l.id, tab: null, index: -1 });
    } else if (l.kind === "terminal") {
      (l.tabs || []).forEach((t, i) => {
        if (!SURFACE_KINDS.has(t.kind)) return;
        if (!t.sid) { t.sid = t.tid || T.newPaneId(); assignedSid = true; }
        out.push({ sid: t.sid, kind: t.kind, url: t.url, openPath: t.openPath, deviceId: t.deviceId, title: t.metaName || t.metaTitle || "", leafId: l.id, tab: t, index: i });
      });
    }
  });
  return out;
}

function activeLocal() {
  const meta = S.state.workspaces.find((x) => x.id === S.state.activeWsId);
  const rt = meta ? S.wsRuntime(meta.id) : null;
  if (!meta || !rt || !rt.layout || !S.isThisHost(meta) || !meta.localPath) return null;
  return { meta, rt };
}

/** 레이아웃이 바뀌었다 — 조금 모아서(400ms) 데몬 기록과 맞춘다. */
export function scheduleSync() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; void sync(); }, 400);
}

async function sync() {
  if (syncing) { dirty = true; return; }
  syncing = true; dirty = false;
  try {
    const a = activeLocal();
    if (!a) return;
    const { meta, rt } = a;
    const cwd = meta.localPath;
    const prev = knownFor(meta.id);
    assignedSid = false;
    const cur = surfacesOf(rt.layout);
    if (assignedSid) { assignedSid = false; S.emit(); }   // 새 sid 를 저장본에도(재시작 뒤 다른 id 로 다시 등록되지 않게)
    const curIds = new Set(cur.map((e) => e.sid));
    for (const e of cur) {
      const k = keyOf(e);
      const had = prev.get(e.sid);
      if (had === k) continue;
      const item = { id: e.sid, kind: e.kind, ...propsOf(e) };
      if (had === undefined) {
        pendingAdd.add(e.sid);
        try {
          const r = await api.surfaceAdd(cwd, item);
          const got = r && r.item ? r.item : null;
          if (got && got.id !== e.sid) {
            //  에이전트 PC 흡수 — 데몬이 이미 있는 표면을 돌려줬다. 로컬 sid 를 갈아 끼운다(다음 목록에 그 id 로 온다).
            if (e.tab) e.tab.sid = got.id; else { const l = T.findLeaf(rt.layout, e.leafId); if (l) l.sid = got.id; }
            prev.set(got.id, JSON.stringify({ url: got.url ?? undefined, openPath: got.openPath ?? null, deviceId: got.deviceId ?? null, title: got.title || undefined }));
            curIds.add(got.id); curIds.delete(e.sid);
            S.emit();
          } else prev.set(e.sid, k);
        } catch (err) {
          api.debugLog?.(`surface: add 실패 sid=${e.sid} ${err?.message || err}`);
        } finally { pendingAdd.delete(e.sid); }
      } else {
        try { await api.surfaceUpdate(cwd, item); prev.set(e.sid, k); } catch (err) { api.debugLog?.(`surface: update 실패 sid=${e.sid} ${err?.message || err}`); }
      }
    }
    for (const sid of [...prev.keys()]) {
      if (curIds.has(sid)) continue;
      prev.delete(sid);
      try { await api.surfaceRemove(cwd, sid); } catch (err) { api.debugLog?.(`surface: remove 실패 sid=${sid} ${err?.message || err}`); }
    }
  } finally {
    syncing = false;
    if (dirty) scheduleSync();
  }
}

/** 리컨실러가 방금 들인/닫은 표면 — 다음 sync 가 되돌려 보내지 않게 기록만 맞춘다. */
function noteKnown(wsId, sid, item) { knownFor(wsId).set(sid, JSON.stringify({ url: item.url ?? undefined, openPath: item.openPath ?? null, deviceId: item.deviceId ?? null, title: item.title || undefined })); }
function forgetKnown(wsId, sid) { knownFor(wsId).delete(sid); }

function tabFor(item) {
  const base = { kind: item.kind, tid: T.newPaneId(), sid: item.id };
  if (item.kind === "preview") return { ...base, url: item.url || null };
  if (item.kind === "ide") return { ...base, openPath: item.openPath || null };
  const desk = typeof item.deviceId === "string" && item.deviceId.startsWith("desktop:");
  return { ...base, deviceId: item.deviceId || null, metaName: item.title || (desk ? i18n.t('에이전트 PC') : "") };
}

/**
 * 밖→안. 데몬 목록(items) 과 이 PC 레이아웃을 맞춘다 — 리컨실러(state.reconcilePool) 가 터미널 다음에 부른다.
 *  반환: 바뀐 pane id 집합(부르는 쪽이 buildHead/emit 한다).
 */
export function reconcile(meta, w, items) {
  const touched = new Set();
  if (!w || !w.layout || !Array.isArray(items)) return touched;
  const remote = new Map(items.map((s) => [s.id, s]));
  const local = surfacesOf(w.layout);
  const seen = new Set();
  // ① 기록에서 사라진 것 — 2틱 유예 뒤 닫는다(등록 중인 것은 보호).
  const closeLeaves = [];
  const deskSeen = new Set();   // OS별로 하나씩만(macOS·Linux 는 각각 독립 pane) — 같은 OS 둘째만 더블링으로 닫는다.
  const localSeen = new Set();
  for (const e of local) {
    //  더블링 방지 — 같은 sid(흡수로 겹침)·같은 OS 의 에이전트 PC 둘째는 유예 없이 닫는다(먼저 만난 것만 남긴다).
    const desk = e.kind === "emulator" && typeof e.deviceId === "string" && e.deviceId.startsWith("desktop:");
    const dup = localSeen.has(e.sid) || (desk && deskSeen.has(e.deviceId));
    if (!dup) { localSeen.add(e.sid); if (desk) deskSeen.add(e.deviceId); }
    if (!dup && remote.has(e.sid)) { seen.add(e.sid); if (e.tab) delete e.tab.miss; else { const l = T.findLeaf(w.layout, e.leafId); if (l) delete l.miss; } continue; }
    const holder = e.tab || T.findLeaf(w.layout, e.leafId);
    if (!holder) continue;
    if (!dup) {
      if (pendingAdd.has(e.sid) || !knownFor(meta.id).has(e.sid)) continue;   // 아직 등록 전(첫 sync 전) 인 것도 보호
      if (!holder.miss) { holder.miss = 1; api.debugLog?.(`surface: sid=${e.sid} 목록 부재 — 1틱 유예`); continue; }
      forgetKnown(meta.id, e.sid);
    }
    if (e.tab) {
      const pane = getPane(e.leafId);
      const leaf = T.findLeaf(w.layout, e.leafId);
      const i = leaf ? leaf.tabs.indexOf(e.tab) : -1;
      if (i < 0) continue;
      if (pane) pane.closeTab(i);              // 마지막 탭이면 pane 통째(onClosePane) — closeTab 이 emit/persist 까지 한다
      else { leaf.tabs.splice(i, 1); leaf.active = Math.max(0, Math.min(leaf.active, leaf.tabs.length - 1)); touched.add(leaf.id); }
      api.debugLog?.(`surface: 탭 닫음 sid=${e.sid} (다른 기기가 닫음)`);
    } else closeLeaves.push(e.leafId);
  }
  for (const id of closeLeaves) {
    const r = T.closeLeaf(w.layout, id);
    w.layout = r.tree || T.leaf("terminal", { empty: true });
    w.focusId = r.focusId || T.firstLeafId(w.layout);
    touched.add("*");
    api.debugLog?.(`surface: pane 닫음 ${id} (다른 기기가 닫음)`);
  }
  // ② 목록엔 있는데 여기 없는 것 — 포커스(없으면 첫) 터미널 pane 의 탭으로 들인다(터미널 편입과 같은 자리).
  const missing = items.filter((s) => !seen.has(s.id) && SURFACE_KINDS.has(s.kind));
  if (missing.length) {
    let targetId = null;
    const f = w.focusId ? T.findLeaf(w.layout, w.focusId) : null;
    if (f && f.kind === "terminal") targetId = f.id;
    if (!targetId) T.eachLeaf(w.layout, (l) => { if (!targetId && l.kind === "terminal") targetId = l.id; });
    if (targetId) {
      const leafT = T.findLeaf(w.layout, targetId);
      for (const s of missing) { leafT.tabs.push(tabFor(s)); noteKnown(meta.id, s.id, s); }
      touched.add(targetId);
    } else {
      const anchor = T.firstLeafId(w.layout);
      for (const s of missing) {
        const node = T.leaf(s.kind, { url: s.url, openPath: s.openPath, deviceId: s.deviceId, sid: s.id, metaName: s.title });
        if (!anchor) { w.layout = node; } else { w.layout = T.split(w.layout, anchor, "h", node).tree; }
        noteKnown(meta.id, s.id, s);
      }
      touched.add("*");
    }
    api.debugLog?.(`surface: 편입 ${missing.map((s) => `${s.kind}:${s.id}`).join(",")}`);
  }
  return touched;
}

/** 테스트·하네스용 — 내부 기록을 비운다. */
export function _reset() { known.clear(); pendingAdd.clear(); }
