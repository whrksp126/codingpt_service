// vm-view.js — 에이전트 PC(VM) 장소(state.view === 'vm'). 메인 영역에 그 VM 의 화면을 기본으로 둔다(2026-10-04).
//  사이드바에서 VM 을 고르면 사이드바가 그 VM 기준(화면·VM 워크스페이스)으로 바뀌고, 여기는 화면과 준비 상태를 보여 준다.
//  에이전트는 VM **안에서** 돈다(데몬 vm-agent.js) — 호스트의 키보드·마우스·화면을 뺏지 않는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import { escapeHtml } from "./chat-md.js";
import * as i18n from './i18n/index.js';

let el = null;
let emu = null, emuOs = null;
let info = null, infoOs = null, askedAt = 0, busy = "", err = "", headSig = "";

/** 워크스페이스 경로가 VM 자리(~/.codingpt/vm/<os>/ws/…)면 그 OS, 아니면 null. */
export function vmOsOfPath(p) { const m = /(?:^|\/)\.codingpt\/vm\/(macos|linux)\/ws\//.exec(String(p || "") + "/"); return m ? m[1] : null; }
export function vmLabel(os) { return (os === "linux" ? "Linux" : "macOS") + " (VM)"; }
const rpc = (cmd, args) => api.desktopAgent(cmd, args);

export function mountVmView(e) { el = e; }
export function openVm(os) { state.vmScope = os === "linux" ? "linux" : "macos"; S.setView("vm"); }
export function leaveVmScope() { if (!state.vmScope && state.view !== "vm") return; state.vmScope = null; if (state.view === "vm") S.setView("workspace"); else S.emit(); }

function refresh(os, force) {
  if (!force && infoOs === os && Date.now() - askedAt < 5000) return;
  askedAt = Date.now();
  rpc("status", { os }).then((st) => { info = st; infoOs = os; err = ""; adopt(st); if (state.view === "vm") paintHead(os); }).catch(() => {});
}

// VM 에 이미 있는 워크스페이스 자리(다른 경로로 가져온 것 포함)가 목록에 없으면 등록한다 — 한 자리당 한 번만 시도.
const adopted = new Set();
function adopt(st) {
  for (const w of (st && st.workspaces) || []) {
    const tail = String(w.dir).split("/.codingpt/")[1] || "";
    if (!tail || adopted.has(w.dir)) continue;
    if (state.workspaces.some((x) => String(x.localPath || "").endsWith(".codingpt/" + tail))) continue;
    adopted.add(w.dir);
    api.createWorkspace(w.dir).then(() => S.loadWorkspaces()).then(() => S.emit()).catch(() => {});
  }
}

function stepText(job) {
  const t = { boot: i18n.t('VM 을 켜는 중…'), key: i18n.t('연결을 준비하는 중…'), cli: i18n.t('에이전트를 설치하는 중… (1~2분)'), git: i18n.t('도구를 확인하는 중…'), tools: i18n.t('화면 도구를 넣는 중…') };
  return t[job.step] || i18n.t('준비하는 중…');
}

function paintHead(os) {
  const head = el && el.querySelector(".vmv-head");
  if (!head) return;
  const st = infoOs === os ? info : null;
  const job = st && st.job;
  let msg = "", act = "";
  if (busy) msg = busy;
  else if (err) msg = err;
  else if (job && job.running) msg = stepText(job);
  else if (job && job.error) { msg = job.error; act = "setup"; }
  else if (!st) msg = "";
  else if (st.phase !== "running") msg = i18n.t('꺼져 있어요');
  else if (!st.cli) { msg = i18n.t('이 VM 에 에이전트가 아직 없어요'); act = "setup"; }
  else if (st.loggedIn === false) msg = i18n.t('VM 안에서 한 번 로그인해 주세요 — VM 워크스페이스의 터미널에서 `claude auth login`');
  else msg = i18n.t('에이전트 준비됨');
  const sig = JSON.stringify([os, msg, act, !!busy]);
  if (sig === headSig) return;
  headSig = sig;
  head.innerHTML =
    `<span class="vmv-title">${(os === "linux" ? icons.linux : icons.apple)({ size: 15 })}<b>${escapeHtml(vmLabel(os))}</b></span>` +
    //  상태 문구는 머리줄에 쓰지 않는다(2026-10-04 사용자 확정 — 긴 안내가 제목 옆을 차지했다). 필요한 행동은 버튼으로만.
    `<span class="vmv-msg"></span>` +
    //  워크스페이스 가져오기는 사이드바 `워크스페이스 ⋯` 한 곳에만 둔다(2026-10-04 사용자 확정 — 여기 버튼은 뺐다).
    (act === "setup" ? `<button class="vmv-btn" data-act="setup">${i18n.t('에이전트 설치')}</button>` : "");
  head.querySelector('[data-act="setup"]')?.addEventListener("click", () => { rpc("setup", { os }).then((s) => { info = s; infoOs = os; headSig = ""; paintHead(os); }).catch((e) => { err = String(e); headSig = ""; paintHead(os); }); });
}

/** 이 PC 의 워크스페이스 중 하나를 골라 VM 안에 git 사본을 만들고, 그 자리를 워크스페이스로 등록한다. */
export function openImportMenu(x, y, os) {
  const hosts = S.workspacesForDevice(S.activeDeviceId()).filter((w) => !vmOsOfPath(w.localPath));
  import("./sidebar.js").then((sb) => {
    if (!hosts.length) { sb.showPopupMenu(x, y, [{ label: i18n.t('가져올 워크스페이스가 없어요'), onClick: () => {} }]); return; }
    sb.showPopupMenu(x, y, hosts.map((w) => ({
      icon: icons.folder ? icons.folder({ size: 15 }) : "", label: w.name || String(w.localPath).split("/").pop(),
      onClick: () => void importWs(os, w),
    })));
  }).catch(() => {});
}
async function importWs(os, w) {
  busy = i18n.t('「{name}」 을 VM 으로 가져오는 중… (커밋된 내용 기준)', { name: w.name || "" }); err = ""; headSig = ""; paintHead(os); S.emit();
  try {
    const r = await rpc("ws.add", { os, path: w.localPath });
    const made = await api.createWorkspace(r.dir);
    await S.loadWorkspaces();
    busy = "";
    // 응답 모양에 기대지 않는다 — 방금 등록한 자리(경로 끝)가 일치하는 워크스페이스를 목록에서 찾는다.
    const tail = String(r.dir).split("/.codingpt/")[1] || "";
    const hit = (made && made.id && made) || state.workspaces.find((x) => tail && String(x.localPath || "").endsWith(".codingpt/" + tail));
    if (hit && hit.id) { state.activeWsId = hit.id; S.ensureRuntime?.(hit.id); state.view = "workspace"; }
    S.emit();
  } catch (e) {
    busy = ""; err = String((e && e.message) || e).replace(/^[A-Z_]+:\s*/, ""); headSig = ""; paintHead(os); S.emit();
  }
}

export function updateVmView() {
  if (!el) return;
  const on = state.view === "vm" && !!state.vmScope;
  el.hidden = !on;
  if (!on) { emu?.setVisible(false); return; }
  const os = state.vmScope;
  if (!el.querySelector(".vmv-head")) { el.innerHTML = `<div class="vmv-head"></div><div class="vmv-body"></div>`; headSig = ""; }
  if (emuOs !== os) {
    try { emu?.dispose(); } catch (_) { /* noop */ }
    emu = null; emuOs = os; headSig = "";
    const body = el.querySelector(".vmv-body");
    body.innerHTML = "";
    import("./emulator-view.js").then((m) => {
      if (emuOs !== os || emu) return;
      emu = new m.EmulatorView(body, { deviceId: `desktop:${os}`, onDeviceChange: () => {} });
    }).catch(() => {});
  }
  emu?.setVisible(true);
  paintHead(os);
  refresh(os, false);
}

// 준비 중·켜는 중에는 상태가 스스로 바뀐다 — 보고 있을 때만 5초마다 다시 묻는다.
setInterval(() => { if (state.view === "vm" && state.vmScope && !document.hidden) refresh(state.vmScope, true); }, 5000);
