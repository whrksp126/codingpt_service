// issues-autosave.js — 이슈 편집의 자동 저장(순수 — DOM·RPC 를 모른다). 폰 앱이 같은 규칙을 옮겨 쓴다
//  (codingpt_app/src/workspace/issues/issuesAutosave.ts — 한쪽만 고치지 말 것. 검증: test/issues-autosave.test.mjs).
//
//  지키는 것(2026-10-08 사용자 요청 — "작성 중이던 게 다른 거 하고 오니까 사라져 있다"):
//   · 새 이슈는 **뜻 있는 첫 입력**(제목 또는 본문)에서 진짜 이슈로 만든다. 아무것도 안 적고 나가면 빈 이슈가 생기지 않는다.
//   · 그 뒤로는 바뀐 칸만 조용히 저장한다(잠깐 멈추면 저장, 나갈 때는 곧바로).
//   · 요청은 **한 번에 하나**다 — 늦게 온 옛 응답이 새 입력을 덮을 길이 없다. 응답은 입력칸에 되쓰지 않는다
//     (보낸 값을 "저장된 값" 으로 삼을 뿐 — 한글 조합 중인 칸을 건드리지 않는다).
//   · 실패해도 입력은 그대로 쥐고 간격을 두고 다시 보낸다.
//   · 다른 기기가 같은 이슈를 고쳤으면, 내가 고치는 중이 아닌 칸만 따라간다(mergeRemote).
export const FIELD_KEYS = ["title", "body", "status", "priority", "cwd", "labels"];
export const SAVE_DELAY_MS = 700;
/** 외부 서비스(GitHub) 이슈는 저장 한 번이 그 서비스 호출이다 — 더 길게 모은다. */
export const SAVE_DELAY_EXT_MS = 2500;
export const RETRY_MS = [2000, 5000, 15000];

const normLabels = (v) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(",")).map((x) => String(x).trim()).filter(Boolean).join(", ");
/** 견줄 수 있는 모양으로 — 제목은 앞뒤 공백을 떼고, 라벨은 "a, b" 한 줄로. */
export function normFields(f) {
  const o = f || {};
  return { title: String(o.title || "").trim(), body: String(o.body || ""), status: o.status || "todo", priority: o.priority || "none", cwd: String(o.cwd || ""), labels: normLabels(o.labels) };
}
/** 적은 것이 없는가(제목도 본문도 비었다) — 이런 새 이슈는 만들지 않는다. */
export function isBlank(f) { const n = normFields(f); return !n.title && !n.body.trim(); }
/** saved → next 로 바뀐 칸만. keys = 볼 칸. */
export function diffFields(saved, next, keys = FIELD_KEYS) {
  const a = normFields(saved); const b = normFields(next); const out = {};
  for (const k of keys) if (a[k] !== b[k]) out[k] = b[k];
  return out;
}
/** 목록·머리줄에 보일 제목 — 제목이 비었으면 본문 첫 줄, 그것도 없으면 untitled("제목 없음"). */
export function displayTitle(x, untitled = "") {
  const title = String((x && x.title) || "").trim();
  if (title) return title;
  for (const raw of String((x && x.body) || "").split("\n")) {
    const line = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/, "").replace(/[*_~`]/g, "").trim();
    if (line && !/^(-{3,}|`{3,}.*)$/.test(raw.trim())) return line.slice(0, 80);
  }
  return untitled;
}

/**
 * o = { id(없으면 새 이슈), fields, rev(그 이슈의 updatedAt), keys, delay,
 *       create(fields) → Promise<{id, rev}>, update(id, patch) → Promise<{rev}>,
 *       onStatus(status), onCreated(id), setTimer, clearTimer, retryMs }
 * status = idle(새 이슈·아직 안 적음) | dirty | saving | saved | error
 */
export function createAutosaver(o) {
  const keys = o.keys || FIELD_KEYS;
  const delay = o.delay == null ? SAVE_DELAY_MS : o.delay;
  const retryMs = o.retryMs || RETRY_MS;
  const setT = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimer || ((h) => clearTimeout(h));
  let id = o.id || null;
  let saved = normFields(o.fields);
  let desired = normFields(o.fields);
  let rev = Number(o.rev) || 0;
  let force = false;          // 첨부처럼 "적은 것이 없어도 만들어야 하는" 경우
  let timer = null;
  let inflight = null;
  let retryN = 0;
  let status = id ? "saved" : "idle";
  let disposed = false;
  let deferred = null;        // 고치는 중이라 미뤄 둔 다른 기기의 변경

  const setStatus = (s) => { if (s === status) return; status = s; try { if (o.onStatus) o.onStatus(s); } catch (_) { /* 표시 실패가 저장을 막지 않는다 */ } };
  const patchNow = () => diffFields(saved, desired, keys);
  const dirty = () => (id ? Object.keys(patchNow()).length > 0 : (force || !isBlank(desired)));
  const cancel = () => { if (timer != null) { clearT(timer); timer = null; } };
  const schedule = (ms) => { cancel(); if (disposed) return; timer = setT(() => { timer = null; void runOnce(); }, ms); };

  /** 한 번 보낸다 → 성공했는가. 이미 보내는 중이면 그것을 기다린다(겹쳐 보내지 않는다). */
  function runOnce() {
    if (inflight) return inflight;
    if (!dirty()) { setStatus(id ? "saved" : "idle"); return Promise.resolve(true); }
    const sent = id ? patchNow() : { ...desired };
    const creating = !id;
    setStatus("saving");
    let p;
    try { p = Promise.resolve(creating ? o.create(sent) : o.update(id, sent)); } catch (e) { p = Promise.reject(e); }
    inflight = p.then((r) => {
      inflight = null;
      if (creating) {
        if (!r || !r.id) throw new Error("NO_ID");
        id = r.id; force = false;
        try { if (o.onCreated) o.onCreated(id); } catch (_) { /* noop */ }
      }
      //  "저장된 값" 은 **보낸 값**이다(응답이 아니라) — 보내는 사이 더 적은 글은 그대로 dirty 로 남아 다음에 간다.
      saved = { ...saved, ...sent };
      rev = Math.max(rev, Number(r && r.rev) || 0);
      retryN = 0;
      if (dirty()) { setStatus("dirty"); schedule(delay); } else setStatus("saved");
      return true;
    }).catch(() => {
      inflight = null;
      setStatus("error");
      schedule(retryMs[Math.min(retryN, retryMs.length - 1)]);
      retryN += 1;
      return false;
    });
    return inflight;
  }

  return {
    /** 칸이 바뀌었다(전부가 아니라 바뀐 칸만 줘도 된다). */
    set(patch) {
      if (disposed) return;
      desired = normFields({ ...desired, ...(patch || {}) });
      // 제목의 앞뒤 공백은 저장에서만 뗀다 — 견주는 값이 같으면 일이 없다.
      if (!dirty()) { if (!inflight) { cancel(); setStatus(id ? "saved" : "idle"); } return; }
      if (status !== "saving") setStatus("dirty");
      if (!inflight) { retryN = 0; schedule(delay); }
    },
    /** 지금 곧바로 끝까지 저장한다(칸에서 나갈 때·창을 닫을 때·앱이 뒤로 갈 때) → { id, ok }. */
    async flush() {
      cancel();
      let guard = 0;
      while (dirty() && guard++ < 8) { if (!(await runOnce())) return { id, ok: false }; }
      if (inflight) await inflight;
      return { id, ok: !dirty() };
    },
    /** 적은 것이 없어도 이슈를 만든다(첨부를 붙이려면 이슈가 있어야 한다) → id | null. */
    async ensureCreated() { if (id) return id; force = true; const r = await this.flush(); if (!r.id) force = false; return r.id; },
    /**
     * 다시 읽은 이슈(다른 기기가 고쳤을 수 있다)를 받아, **내가 고치는 중이 아닌 칸만** 따라간다 → 바뀐 칸 이름들.
     *  editing = 지금 커서가 있는 칸들 — 그 칸은 손대지 않고 미뤄 둔다(같은 remote 로 다시 부르면 그때 따라간다).
     *  내가 고쳐 아직 안 보낸 칸은 내 것이 이긴다. 내 저장보다 오래된 사본(늦게 온 목록)은 통째로 버린다.
     */
    mergeRemote(remote, editing = []) {
      const r0 = remote || deferred;
      if (disposed || !id || !r0) return [];
      const at = Number(r0.updatedAt) || 0;
      if (at <= rev) { if (r0 === deferred) deferred = null; return []; }
      const r = normFields(r0);
      const changed = []; let held = false;
      for (const k of keys) {
        if (r[k] === saved[k]) continue;
        if (desired[k] !== saved[k]) { saved[k] = r[k]; continue; }      // 내가 고치는 중 — 내 글을 둔다(다음 저장이 덮는다)
        if (editing.includes(k)) { held = true; continue; }               // 커서가 있는 칸 — 나중에
        saved[k] = r[k]; desired[k] = r[k]; changed.push(k);
      }
      if (held) deferred = r0; else { deferred = null; rev = at; }
      return changed;
    },
    id: () => id,
    rev: () => rev,
    status: () => status,
    fields: () => ({ ...desired }),
    dirty,
    dispose() { disposed = true; cancel(); },
  };
}

// ── 워크스페이스 선택지 ──────────────────────────────────────────────────────
//  2026-10-08 "codingpt 가 세 번 나온다" 의 원인: 목록이 이 PC 의 워크스페이스 **레코드**를 그대로 늘어놓았다.
//   VM 안 에이전트용 자리 폴더(~/.codingpt/vm/<os>/ws/<이름>)가 원본과 같은 이름의 레코드라 "codingpt" 가 OS 수만큼 더 나왔다.
//   사이드바는 그 자리를 VM 을 골랐을 때만 보인다 — 이슈는 호스트의 것이므로 여기서는 늘 뺀다. 작업 폴더(worktree)도 뺀다.
const VM_SEAT_RE = /(?:^|\/)\.codingpt\/vm\/(macos|linux)\/ws\//;
const TASK_WT_RE = /^\.codingpt\/worktrees\//;
export const vmOsOfCwd = (cwd) => { const m = VM_SEAT_RE.exec(String(cwd || "") + "/"); return m ? m[1] : null; };
export const isSeatOrWorktree = (cwd) => !!vmOsOfCwd(cwd) || TASK_WT_RE.test(String(cwd || ""));
/**
 * list = [{ cwd, name }](사이드바 순서) → [{ cwd, label }] — 프로젝트(폴더)마다 한 줄.
 *  · VM 자리·작업 폴더 제외 · 같은 폴더는 한 번 · 그래도 이름이 같으면(다른 폴더) 윗폴더를 덧붙여 가른다.
 *  · keep = 지금 그 이슈에 적힌 폴더 — 목록에 없어도(지워진 워크스페이스·VM 자리) 선택지로 남긴다(고르지 않았는데 바뀌면 안 된다).
 */
export function workspaceOptions(list, keep = "") {
  const seen = new Set(); const out = [];
  for (const w of list || []) {
    const cwd = String((w && w.cwd) || "");
    if (!cwd || seen.has(cwd) || isSeatOrWorktree(cwd)) continue;
    seen.add(cwd);
    out.push({ cwd, label: String(w.name || "") || cwd.split("/").pop() || cwd });
  }
  if (keep && !seen.has(keep)) {
    const os = vmOsOfCwd(keep);
    const hit = (list || []).find((w) => w && w.cwd === keep);
    const base = (hit && hit.name) || keep.split("/").pop() || keep;
    out.push({ cwd: keep, label: os ? `${base} · ${os === "linux" ? "Linux" : "macOS"} (VM)` : base });
  }
  const count = new Map();
  for (const x of out) count.set(x.label, (count.get(x.label) || 0) + 1);
  return out.map((x) => {
    if (count.get(x.label) < 2) return x;
    const parent = x.cwd.split("/").slice(0, -1).join("/");
    return { cwd: x.cwd, label: parent ? `${x.label} — ${parent}` : x.label };
  });
}
