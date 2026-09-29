// power-settings.js — `PC 깨어 있기` 카드(automation-design §6.6). 설정 > 시스템(이 PC) 과 PC 행 메뉴 `PC 설정`(아무 PC)이
//  같은 카드를 쓴다. get/set 은 전부 power.* RPC(automations-api.autoRpc — 이 PC 는 로컬 소켓, 다른 PC 는 봉인/릴레이).
//
//  [○] 작업 중에는 잠자기 방지      (keepAwake → power.set)
//  [○] 덮개를 닫아도 계속 작업        (lidClosed — 1회 설정(power.setup) 전이면 토글이 설정 흐름을 먼저 연다)
//      지금: 깨어 있음 · 작업 2개      (power.status 30초 폴링 + ui_command power.changed)
//      주의: 발열·배터리 문구
//
// 암호는 우리가 다루지 않는다 — power.setup 이 그 PC 화면에 macOS 인증 창을 띄우고 사용자가 직접 입력한다(§6.2).
//  원격 PC 에 요청하면 창은 **그 PC 화면**에 뜬다 → 먼저 setupRemoteHint 로 확인받는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { autoRpc, hostHasPower } from "./automations-api.js";
import { isLocalHostId } from "./tasks-api.js";
import { tt, errText } from "./text/tasks.js";
import { at } from "./text/automations.js";
import { powerStatusKeys } from "./automations-model.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const POLL_MS = 30000;
const SETUP_POLL_MS = 2000;
const SETUP_DEADLINE_MS = 185000;
const cards = new Set(); // 붙어 있는 카드들 — power.changed 가 오면 그 host 카드만 다시 받는다

/** ui_command `power.changed {host}` — 그 host 를 보여 주는 카드를 즉시 갱신. */
export function onPowerChanged(p) {
  const h = p && p.host != null ? Number(p.host) : null;
  for (const c of cards) if (h == null || Number(c.host) === h) void c.refresh();
}

/** 상태 → 줄(§6.6 "지금: …") — 판정은 automations-model.powerStatusKeys(순수, 테스트 대상), 여기는 문구만. */
export function powerStatusLines(st) {
  return powerStatusKeys(st).map((l) => ({ text: l.code ? errText(l.code) : at(l.key, l.vars), kind: l.kind }));
}

/**
 * 카드 그리기. container 안을 통째로 쓴다. @returns dispose()
 * opts.remote — 다른 PC(원격 설정 안내를 먼저 띄운다). 기본은 isLocalHostId 로 판정.
 */
export function renderPowerCard(container, host, opts = {}) {
  const h = host == null ? state.daemon?.deviceId ?? null : Number(host);
  const remote = opts.remote != null ? !!opts.remote : !(h == null || isLocalHostId(state, h));
  const c = { host: h, st: null, err: null, busy: false, refresh: null };
  let timer = null;
  let setupGen = 0;
  let disposed = false;

  async function refresh() {
    if (disposed) return;
    if (hostHasPower(h) === false) { c.err = "PC_NEEDS_UPDATE"; draw(); return; }
    try {
      const r = await autoRpc("power.status", {}, h);
      c.st = r || {}; c.err = null;
    } catch (e) {
      c.err = (e && e.code) || "x";
    }
    draw();
  }
  c.refresh = refresh;

  async function set(patch) {
    c.busy = true; draw();
    try {
      const r = await autoRpc("power.set", patch, h);
      if (r && r.status) c.st = r.status;
    } catch (e) {
      S.emit();
      import("./tasks-view.js").then((m) => m.toast(errText(e && e.code))).catch(() => {});
    }
    c.busy = false;
    await refresh();
  }

  /** 1회 설정(또는 해제) → 끝나면(then) 이어서 할 일. 결과는 power.status.setup 으로 본다(§6.2). */
  async function setup({ remove = false, then } = {}) {
    if (remote && !remove && !window.confirm(at("setupRemoteHint"))) { draw(); return; }
    const my = ++setupGen;
    c.busy = true;
    c.st = { ...(c.st || {}), setup: "pending", setupError: null };
    draw();
    try {
      await autoRpc("power.setup", remove ? { remove: true } : {}, h);
    } catch (e) {
      c.busy = false;
      c.st = { ...(c.st || {}), setup: "failed", setupError: { code: (e && e.code) || "POWER_SETUP_FAILED" } };
      draw();
      return;
    }
    const until = Date.now() + SETUP_DEADLINE_MS;
    while (!disposed && my === setupGen && Date.now() < until) {
      await new Promise((r) => setTimeout(r, SETUP_POLL_MS));
      try { c.st = (await autoRpc("power.status", {}, h)) || c.st; } catch (_) { continue; }
      draw();
      const s = c.st && c.st.setup;
      if (remove ? s === "none" : s === "done") { c.busy = false; if (then) await then(); else await refresh(); return; }
      if (s === "failed") break;
    }
    c.busy = false;
    draw();
  }

  function draw() {
    if (disposed) return;
    const s = c.st || {};
    container.innerHTML = "";
    const card = document.createElement("div");
    card.className = "sm-card2 pw-card";
    container.append(card);
    if (c.err === "PC_NEEDS_UPDATE") { card.append(hintRow(tt("pcNeedsUpdate"))); return; }
    if (c.err === "POWER_UNSUPPORTED" || s.supported === false) { card.append(hintRow(at("powerUnsupported"))); return; }
    if (c.err && !c.st) { card.append(hintRow(errText(c.err))); return; }
    if (!c.st) { card.append(hintRow(tt("checking"))); return; }

    // ① 작업 중 잠자기 방지
    card.append(toggleRow(at("keepAwakeWork"), at("keepAwakeWorkDesc"), !!s.keepAwake, c.busy, (v) => set({ keepAwake: v })));

    // ② 덮개 닫힘 — 1회 설정 상태에 따라 오른쪽 조각이 바뀐다
    const done = s.setup === "done";
    const pending = s.setup === "pending";
    const row = document.createElement("div");
    row.className = "sett-row";
    const copy = document.createElement("span");
    copy.className = "sett-copy";
    copy.innerHTML = `<span class="sett-label">${esc(at("lidClosed"))}</span><span class="sett-desc">${esc(done ? at("setUpDone") : at("lidClosedDesc"))}</span>`;
    const right = document.createElement("span");
    right.className = "pw-right";
    if (done) {
      const rm = document.createElement("button");
      rm.className = "sett-btn pw-remove";
      rm.textContent = at("removeSetup");
      rm.disabled = c.busy;
      rm.addEventListener("click", () => void setup({ remove: true, then: () => set({ lidClosed: false }) }));
      right.append(rm);
    } else {
      const su = document.createElement("button");
      su.className = "sett-btn";
      su.textContent = at("setUp");
      su.disabled = c.busy || pending;
      su.addEventListener("click", () => void setup());
      right.append(su);
    }
    const tg = document.createElement("input");
    tg.type = "checkbox";
    tg.className = "tgl";
    tg.checked = !!s.lidClosed;
    tg.disabled = c.busy || pending;
    tg.setAttribute("aria-label", at("lidClosed"));
    tg.addEventListener("change", () => {
      // 미설정이면 토글을 되돌리고 설정 흐름을 먼저(끝나면 켠다).
      if (tg.checked && !done) { tg.checked = false; void setup({ then: () => set({ lidClosed: true }) }); return; }
      void set({ lidClosed: tg.checked });
    });
    right.append(tg);
    row.append(copy, right);
    card.append(row);

    // 지금 상태 + 주의
    const stat = document.createElement("div");
    stat.className = "sett-hint pw-status";
    stat.innerHTML = powerStatusLines(s).map((l) => `<div class="${l.kind === "err" ? "pw-err" : ""}">${esc(l.text)}</div>`).join("");
    card.append(stat);
    const cav = document.createElement("div");
    cav.className = "sett-hint pw-caveat";
    cav.textContent = at("powerCaveat");
    card.append(cav);
  }

  function hintRow(text) {
    const d = document.createElement("div");
    d.className = "sett-row";
    d.innerHTML = `<span class="sett-copy"><span class="sett-desc">${esc(text)}</span></span>`;
    return d;
  }
  function toggleRow(label, desc, on, disabled, onChange) {
    const row = document.createElement("label");
    row.className = "sett-row sett-row-action";
    const copy = document.createElement("span");
    copy.className = "sett-copy";
    copy.innerHTML = `<span class="sett-label">${esc(label)}</span><span class="sett-desc">${esc(desc)}</span>`;
    const tg = document.createElement("input");
    tg.type = "checkbox";
    tg.className = "tgl";
    tg.checked = on;
    tg.disabled = disabled;
    tg.setAttribute("aria-label", label);
    tg.addEventListener("change", () => onChange(tg.checked));
    row.append(copy, tg);
    return row;
  }

  cards.add(c);
  draw();
  void refresh();
  timer = setInterval(() => {
    if (!container.isConnected) { dispose(); return; }
    if (!document.hidden) void refresh();
  }, POLL_MS);
  function dispose() {
    disposed = true;
    clearInterval(timer);
    cards.delete(c);
  }
  return dispose;
}

/** PC 행 메뉴 `PC 설정` — 아무 PC 의 깨어 있기 설정 시트. */
export function openPcSettingsSheet(host) {
  const h = Number(host);
  const d = S.pcDevices().find((x) => Number(x.id) === h);
  const overlay = document.createElement("div");
  overlay.className = "wv-sheet-overlay";
  const box = document.createElement("div");
  box.className = "wv-sheet tk-sheet pw-sheet";
  overlay.append(box);
  document.body.append(overlay);
  const title = document.createElement("div");
  title.className = "wv-sheet-title";
  title.textContent = `${at("pcSettings")} · ${(d && d.name) || tt("pc")}`;
  const sec = document.createElement("div");
  sec.className = "sm-section-title pw-sec";
  sec.textContent = at("keepAwake");
  const host_ = document.createElement("div");
  box.append(title, sec, host_);
  let dispose = () => {};
  const close = () => { dispose(); overlay.remove(); document.removeEventListener("keydown", onEsc, true); };
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onEsc, true);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  if (d && d.online === false) {
    host_.innerHTML = `<div class="sm-card2"><div class="sett-row"><span class="sett-copy"><span class="sett-desc">${esc(tt("hostOffline"))}</span></span></div></div>`;
    return close;
  }
  dispose = renderPowerCard(host_, h);
  return close;
}
