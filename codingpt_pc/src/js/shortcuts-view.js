// 단축키 설정 화면(PC) — 명령 표를 그대로 그리고, 행을 눌러 새 조합을 받는다.
//
// 규율:
//  · **전부 바꿀 수 있다**(사용자 확정). 고정 단축키를 남겨 두면 "왜 이건 안 바뀌지"가 된다.
//  · 겹치면 **그 자리에서 말한다**. 저장을 막지는 않는다 — 사용자가 일부러 옛 조합을 옮기는
//    도중에 겹치는 순간이 있고, 그때 저장을 막으면 순서를 바꿔 가며 씨름하게 된다.
//  · 조합을 받는 동안에는 **모든 키를 삼킨다**. 안 그러면 새 조합을 누르는 그 순간 옛 조합이
//    실행된다(⌘W 를 새로 걸려다 pane 이 닫히는 사고).
//  · 목록은 명령 표 순서 그대로다. 알파벳순으로 다시 줄 세우면 "추가/실행/영역" 같은 묶음이
//    흩어져 찾기 어려워진다.
import { commandsFor, formatCombo, findConflicts, normalizeCombo } from "./commands.js";
import * as SC from "./shortcuts.js";
import { tx } from "./text/index.js";
import { PALETTE_TEXT } from "./text/palette.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function renderShortcutsInto(host) {
  const T = tx(PALETTE_TEXT);
  const SCT = T.sc;
  let filter = "";
  let recording = null;      // 지금 새 조합을 받는 명령 id
  let keyTrap = null;

  const stopRecording = () => {
    recording = null;
    if (keyTrap) { window.removeEventListener("keydown", keyTrap, true); keyTrap = null; }
  };

  function startRecording(id) {
    stopRecording();
    recording = id;
    // capture:true — 앱의 단축키 처리보다 **먼저** 가로챈다. 이게 없으면 새 조합을 누르는 순간
    //  기존 명령이 실행된다.
    keyTrap = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { stopRecording(); paint(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { SC.setBinding(id, null); stopRecording(); paint(); return; }
      const combo = SC.comboOf(e);
      if (!combo) return;    // 수식어만 눌린 상태 — 계속 기다린다
      SC.setBinding(id, combo);
      stopRecording();
      paint();
    };
    window.addEventListener("keydown", keyTrap, true);
    paint();
  }

  function paint() {
    const binds = SC.bindings();
    const conflicts = findConflicts(binds);
    host.innerHTML = "";

    const note = document.createElement("div");
    note.className = "sm-section-note";
    note.textContent = SCT.note + " " + SCT.modHint;
    host.appendChild(note);

    const bar = document.createElement("div");
    bar.className = "sc-bar";
    bar.innerHTML = `<input class="sc-search" placeholder="${esc(SCT.search)}" value="${esc(filter)}" spellcheck="false" />`;
    const resetAll = document.createElement("button");
    resetAll.className = "sc-reset-all";
    resetAll.textContent = SCT.resetAll;
    resetAll.addEventListener("click", () => { SC.resetAll(); paint(); });
    bar.appendChild(resetAll);
    host.appendChild(bar);
    const search = bar.querySelector(".sc-search");
    search.addEventListener("input", () => { filter = search.value; paint(); search.focus(); });

    if (Object.keys(conflicts).length) {
      const w = document.createElement("div");
      w.className = "sc-conflict-note";
      w.textContent = SCT.conflictNote;
      host.appendChild(w);
    }

    const list = document.createElement("div");
    list.className = "sm-card2 sc-list";
    host.appendChild(list);

    const q = filter.trim().toLowerCase();
    let lastGroup = null;
    let shown = 0;
    for (const c of commandsFor("pc")) {
      const label = T.cmd[c.id] || c.id;
      const groupName = T.group[c.group] || c.group;
      const combo = binds[c.id];
      const shownCombo = combo ? formatCombo(combo, SC.IS_APPLE) : "";
      if (q && !(`${label} ${groupName} ${c.id} ${shownCombo}`.toLowerCase().includes(q))) continue;
      shown++;
      if (groupName !== lastGroup) {
        lastGroup = groupName;
        const h = document.createElement("div");
        h.className = "sc-group";
        h.textContent = groupName;
        list.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "sc-row";
      const isRec = recording === c.id;
      const clash = combo && conflicts[combo];
      row.innerHTML =
        `<span class="sc-name">${esc(label)}</span>`
        + (clash ? `<span class="sc-badge">${esc(SCT.conflict)}</span>` : "")
        + `<button class="sc-key${isRec ? " rec" : ""}${combo ? "" : " empty"}">`
        + esc(isRec ? SCT.recording : combo ? shownCombo : SCT.none)
        + `</button>`;
      const keyBtn = row.querySelector(".sc-key");
      keyBtn.addEventListener("click", () => (isRec ? (stopRecording(), paint()) : startRecording(c.id)));
      if (!SC.isDefault(c.id)) {
        const rst = document.createElement("button");
        rst.className = "sc-mini";
        rst.textContent = SCT.reset;
        rst.addEventListener("click", () => { SC.resetBinding(c.id); paint(); });
        row.appendChild(rst);
      } else if (combo) {
        const clr = document.createElement("button");
        clr.className = "sc-mini";
        clr.textContent = SCT.unbind;
        clr.addEventListener("click", () => { SC.setBinding(c.id, null); paint(); });
        row.appendChild(clr);
      }
      list.appendChild(row);
    }
    if (!shown) {
      const e = document.createElement("div");
      e.className = "sc-empty";
      e.textContent = T.empty;
      list.appendChild(e);
    }
    if (recording) {
      const hint = document.createElement("div");
      hint.className = "sm-section-note";
      hint.textContent = SCT.recordingHint;
      host.appendChild(hint);
    }
  }

  paint();
  // 화면을 떠날 때 녹음 상태가 남아 키를 계속 삼키면 앱이 먹통이 된다.
  return () => stopRecording();
}

/** 조합 문자열이 쓸 만한가(설정 밖에서 검사할 일이 있을 때). */
export function isUsableCombo(s) {
  return normalizeCombo(s) != null;
}
