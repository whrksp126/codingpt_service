// desktop-sheet — 에이전트 PC 설정 시트(PC 카드 ··· → 에이전트 PC / 데스크톱 탭 ··· → 설정).
//  준비(이미지 내려받기, 진행률)·상태·연결된 워크스페이스·자원·삭제·알아둘 것 — 한 장에.
//  데이터는 전부 이 PC 데몬(유닉스 소켓 직결, api.desktop*)에서 온다. 원격 PC 의 데스크톱은 아직 안 본다.
import { api } from "./api.js";
import { state } from "./state.js";
import * as S from "./state.js";
import { icons } from "./icons.js";
import * as i18n from "./i18n/index.js";

function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

let el = null;
let timer = null;

function ensureOverlay() {
  if (el) return el;
  el = document.createElement("div");
  el.className = "fp-overlay hidden";
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });
  document.body.appendChild(el);
  return el;
}
export function close() {
  if (timer) { clearInterval(timer); timer = null; }
  if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
}

function fmtGB(bytes) { return bytes ? `${Math.round(bytes / 1024 / 1024 / 1024)} GB` : "-"; }

/** 이 PC 의 워크스페이스(로컬 경로가 있는 것) — 연결 체크 목록의 후보. */
function localWorkspaces() {
  const me = S.pcDevices().find((d) => d.isCurrent) || S.pcDevices().find((d) => String(d.id) === String(state.currentDeviceId));
  const list = me ? S.workspacesForDevice(me.id) : S.workspacesForDevice(null);
  return list.filter((w) => w && w.localPath);
}

let curOs = "macos";   // 이 시트가 다루는 에이전트 PC 의 OS(둘은 독립)

export async function openDesktopSheet(osKind) {
  curOs = osKind === "linux" ? "linux" : "macos";
  const ov = ensureOverlay();
  ov.classList.remove("hidden");
  const title = `${(curOs === "linux" ? icons.linux : icons.apple)({ size: 15 })} <span class="fp-title">${curOs === "linux" ? "Linux · VM" : "macOS · VM"}</span>`;
  ov.innerHTML = `<div class="fp-card ds-card"><div class="fp-head"><span class="ds-head-os">${title}</span><button class="fp-newfolder ds-close" id="dsClose" title="${i18n.t('닫기')}" aria-label="${i18n.t('닫기')}">${icons.x({ size: 16 })}</button></div><div class="ds-body"><div class="fp-empty">${i18n.t('불러오는 중…')}</div></div></div>`;
  ov.querySelector("#dsClose").addEventListener("click", close);
  await paint();
  //  준비(내려받기) 중이면 진행률을, 켜는 중이면 상태를 따라간다.
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (el && !el.classList.contains("hidden")) void paint(true); }, 2000);
}

async function paint(quiet) {
  if (!el) return;
  let st = null, cfg = null, snaps = { snapshots: [] };
  try { [st, cfg] = await Promise.all([api.desktopStatus(curOs), api.desktopSettings(curOs)]); }
  catch (e) {
    if (quiet) return;
    el.querySelector(".ds-body").innerHTML = `<div class="fp-empty">${escapeHtml(e && e.message ? e.message : String(e))}</div>`;
    return;
  }
  const body = el.querySelector(".ds-body");
  if (!body) return;
  //  진행률만 바뀌는 동안 포커스·스크롤이 튀지 않게, 서명이 같으면 다시 그리지 않는다.
  const hasVm = st.phase === "running" || st.phase === "stopped";
  if (hasVm) { try { snaps = await api.desktopSnapshots(curOs); } catch (_) { /* 목록 없이 그린다 */ } }
  const sig = JSON.stringify([st.phase, st.paused, st.pull && st.pull.bytes, st.ip, cfg.sharedDirs, cfg.memGB, cfg.cpu, cfg.idleOffMin, cfg.osKind, st.screen, (snaps.snapshots || []).map((x) => x.name)]);
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;

  const phaseText = {
    unsupported: i18n.t('사용할 수 없음'), 'no-tool': i18n.t('도구 없음'), 'no-image': i18n.t('준비 안 됨'),
    pulling: i18n.t('내려받는 중'), stopped: i18n.t('정지'), starting: i18n.t('켜는 중…'), running: i18n.t('실행 중'),
  }[st.phase] || st.phase;
  const res = { memGB: cfg.memGB || st.memGB, cpu: cfg.cpu || st.cpu };
  const idle = Number(cfg.idleOffMin ?? 60) || 0;
  const wss = localWorkspaces();
  //  데몬은 절대 경로(sharedDirs)와 워크스페이스 id(sharedIds, 홈-상대)를 함께 준다 — 체크는 id 로 맞춘다.
  const shared = new Set([...(cfg.sharedIds || []), ...(cfg.sharedDirs || [])].map(String));

  let statusRows = `<div class="ds-kv"><span>${i18n.t('상태')}</span><b><span class="emu-deskdot${st.phase === "running" ? " on" : ""}"></span> ${phaseText}${st.phase === "running" ? ` · ${fmtGB(st.memorySize)} · ${st.cpuCount || res.cpu}${i18n.t('코어')}${st.screen ? ` · ${st.screen.width}×${st.screen.height}` : ""}` : ""}</b></div>`;
  if (st.phase === "unsupported" || st.phase === "no-tool") {
    statusRows += `<div class="ds-warn">${escapeHtml(st.reason || "")}</div>`;
  } else if (st.phase === "no-image") {
    //  macOS 는 이미지를 따로 내려받고(21GB), Linux 는 첫 켜기 때 스스로 준비한다(다운로드 0.6GB→변환). 그래서 버튼이 다르다.
    statusRows += `<div class="ds-kv"><span>${i18n.t('이미지')}</span><b>${escapeHtml(st.image || "")} · ${curOs === "linux" ? i18n.t('약 5GB') : i18n.t('약 21 GB')}</b></div>
      ${st.reason && !/이미지가 없어요/.test(st.reason) ? `<div class="ds-warn">${escapeHtml(st.reason)}</div>` : ""}
      ${curOs === "linux"
        ? `<div class="ds-warn">${i18n.t('첫 켜기 때 이미지를 준비해요(몇 분).')}</div><div class="ds-actions"><button class="fp-btn fp-designate" id="dsStart">${i18n.t('지금 켜기')}</button></div>`
        : `<div class="ds-actions"><button class="fp-btn fp-designate" id="dsPull">${i18n.t('준비 (내려받기)')}</button></div>`}`;
  } else if (st.phase === "pulling") {
    const p = st.pull || {};
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    statusRows += `<div class="ds-kv"><span>${i18n.t('내려받는 중')}</span><b>${escapeHtml(p.bytes || "")} / ${escapeHtml(p.totalBytes || "")} · ${escapeHtml(p.elapsed || "")}</b></div>
      <div class="ds-prog"><i style="width:${pct}%"></i></div><div class="ds-note">${i18n.t('백그라운드에서 계속됩니다. 이 창을 닫아도 됩니다.')}</div>`;
  } else {
    statusRows += `<div class="ds-actions">${st.phase === "running"
      ? `<button class="fp-btn fp-cancel" id="dsStop">${i18n.t('끄기')}</button><button class="fp-btn fp-cancel" id="dsRestart">${i18n.t('다시 시작')}</button>`
      : `<button class="fp-btn fp-designate" id="dsStart">${i18n.t('지금 켜기')}</button>`}</div>`;
  }

  const wsRows = wss.length ? wss.map((w) => `
    <label class="ds-chk"><input type="checkbox" data-path="${escapeHtml(w.localPath)}" ${shared.has(String(w.localPath)) ? "checked" : ""} ${st.phase === "unsupported" || st.phase === "no-tool" ? "disabled" : ""}/>
      <span class="ds-chk-nm">${escapeHtml(w.name || w.localPath)}</span><span class="ds-chk-path">${escapeHtml(w.localPath)}</span></label>`).join("")
    : `<div class="ds-note">${i18n.t('이 PC 에 워크스페이스가 없어요.')}</div>`;

  const memOpts = [8, 12, 16, 24, 32].filter((g) => g <= Math.max(8, Math.floor((st.hostGB || 0) / 2)));
  const cpuOpts = [4, 6, 8, 12, 16].filter((c) => c <= Math.max(4, (navigator.hardwareConcurrency || 8)));

  body.innerHTML = `
    <div class="fp-sub">${curOs === "linux"
      ? i18n.t('이 맥 안에서 에이전트가 쓰는 별도의 Linux 데스크톱이에요. macOS 와 따로 동시에 켤 수 있어요.')
      : i18n.t('이 맥 안에서 에이전트가 쓰는 별도의 macOS 데스크톱이에요. Linux 와 따로 동시에 켤 수 있어요.')}</div>
    <div class="ds-grp"><div class="ds-l">${i18n.t('상태')}</div>${statusRows}</div>
    <div class="ds-grp"><div class="ds-l">${i18n.t('연결된 워크스페이스')}</div>${wsRows}
      <div class="ds-warn">${i18n.t('바꾸면 다시 시작(약 10초). 폴더는 에이전트 PC 안 /Volumes/My Shared Files/ 에 보여요.')}</div></div>
    <div class="ds-grp"><div class="ds-l">${i18n.t('자원')}</div>
      <div class="ds-kv"><span>${i18n.t('메모리')}</span><b><select id="dsMem">${memOpts.map((g) => `<option value="${g}" ${g === res.memGB ? "selected" : ""}>${g} GB</option>`).join("")}</select> / ${st.hostGB || "?"} GB</b></div>
      <div class="ds-kv"><span>CPU</span><b><select id="dsCpu">${cpuOpts.map((c) => `<option value="${c}" ${c === res.cpu ? "selected" : ""}>${c}${i18n.t('코어')}</option>`).join("")}</select></b></div>
      <div class="ds-kv"><span>${i18n.t('안 쓰면 끄기')}</span><b><select id="dsIdle">${[[0, i18n.t('끄지 않음')], [30, i18n.t('{n}분', { n: 30 })], [60, i18n.t('{n}시간', { n: 1 })], [180, i18n.t('{n}시간', { n: 3 })]].map(([v, l]) => `<option value="${v}" ${v === idle ? "selected" : ""}>${l}</option>`).join("")}</select></b></div></div>
    ${hasVm ? `<div class="ds-grp"><div class="ds-l">${i18n.t('스냅샷')}</div>
      ${(snaps.snapshots || []).map((x) => `<div class="ds-kv ds-snap"><span>${escapeHtml(new Date(x.at).toLocaleString())}${x.label ? ` · ${escapeHtml(x.label)}` : ""}</span>
        <b><button class="fp-newfolder" data-restore="${escapeHtml(x.name)}">${i18n.t('되돌리기')}</button> <button class="fp-newfolder ds-x" data-snapdel="${escapeHtml(x.name)}" title="${i18n.t('삭제')}">×</button></b></div>`).join("")
        || `<div class="ds-note">${i18n.t('저장한 스냅샷이 없어요.')}</div>`}
      <div class="ds-actions"><button class="fp-btn" id="dsSnap">${i18n.t('지금 상태 저장')}</button></div></div>` : ""}
    ${st.phase !== "unsupported" && st.phase !== "no-tool" && st.phase !== "no-image" && st.phase !== "pulling"
      ? `<div class="ds-grp ds-danger"><span>${i18n.t('에이전트 PC 삭제')} (${fmtGB(st.diskSize && st.diskSize.allocated)} ${i18n.t('반환')})</span><button class="fp-newfolder" id="dsDelete">${i18n.t('삭제')}</button></div>` : ""}
    <div class="ds-err" id="dsErr"></div>`;

  const errEl = body.querySelector("#dsErr");
  const guard = (fn) => async (ev) => {
    const b = ev.currentTarget; b.disabled = true; errEl.textContent = "";
    try { await fn(); body.dataset.sig = ""; await paint(); }
    catch (e) { errEl.textContent = e && e.message ? e.message : String(e); b.disabled = false; }
  };
  body.querySelector("#dsPull")?.addEventListener("click", guard(() => api.desktopPull(curOs)));
  body.querySelector("#dsSnap")?.addEventListener("click", guard(async () => {
    const label = window.prompt(i18n.t('스냅샷 이름(선택)'), "") ; if (label === null) throw new Error("");
    await api.desktopSnapshot(label, curOs);
  }));
  for (const b of body.querySelectorAll("[data-restore]")) b.addEventListener("click", guard(async (ev) => {
    if (!window.confirm(i18n.t('이 스냅샷으로 되돌릴까요? 그 뒤에 에이전트 PC 안에서 바뀐 것은 사라집니다.'))) throw new Error("");
    await api.desktopRestore(ev.currentTarget.dataset.restore, curOs);
  }));
  for (const b of body.querySelectorAll("[data-snapdel]")) b.addEventListener("click", guard(async (ev) => { await api.desktopSnapshotDelete(ev.currentTarget.dataset.snapdel, curOs); }));
  body.querySelector("#dsStart")?.addEventListener("click", guard(() => api.desktopStart(curOs)));
  body.querySelector("#dsStop")?.addEventListener("click", guard(() => api.desktopStop(curOs)));
  body.querySelector("#dsRestart")?.addEventListener("click", guard(async () => { await api.desktopStop(curOs); await api.desktopStart(curOs); }));
  body.querySelector("#dsDelete")?.addEventListener("click", guard(async () => {
    if (!window.confirm(i18n.t('에이전트 PC 를 삭제할까요? 그 안에 설치한 것과 바꾼 설정이 사라집니다. 공유 폴더의 코드는 영향받지 않습니다.'))) throw new Error("");
    await api.desktopDelete(curOs);
  }));
  //  연결 체크 — 저장 즉시 반영은 "재시작" 이 필요하다. 켜져 있으면 물어보고 재시작.
  for (const cb of body.querySelectorAll(".ds-chk input")) {
    cb.addEventListener("change", async () => {
      const next = [...body.querySelectorAll(".ds-chk input")].filter((x) => x.checked).map((x) => x.dataset.path);
      try {
        await api.desktopSettingsSet({ sharedDirs: next }, curOs);
        if (st.phase === "running" && window.confirm(i18n.t('연결을 반영하려면 에이전트 PC 를 다시 시작해야 해요. 지금 다시 시작할까요?'))) {
          await api.desktopStop(curOs); await api.desktopStart(curOs);
        }
        body.dataset.sig = ""; await paint();
      } catch (e) { errEl.textContent = e && e.message ? e.message : String(e); }
    });
  }
  const onRes = async () => {
    try { await api.desktopSettingsSet({ memGB: Number(body.querySelector("#dsMem").value), cpu: Number(body.querySelector("#dsCpu").value) }, curOs); }
    catch (e) { errEl.textContent = e && e.message ? e.message : String(e); }
  };
  body.querySelector("#dsMem")?.addEventListener("change", onRes);
  body.querySelector("#dsIdle")?.addEventListener("change", async (ev) => {
    try { await api.desktopSettingsSet({ idleOffMin: Number(ev.currentTarget.value) }, curOs); }
    catch (e) { errEl.textContent = e && e.message ? e.message : String(e); }
  });
  body.querySelector("#dsCpu")?.addEventListener("change", onRes);
}
