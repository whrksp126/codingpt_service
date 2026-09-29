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
import { commandsFor, formatCombo, formatComboParts, findConflicts, normalizeCombo } from "./commands.js";
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

  // 크롬(안내/검색바)은 1회만 만들고 paint 는 **목록만** 다시 그린다 — 예전엔 검색 한 글자마다
  //  host 전체를 재구축하고 input 을 새로 만들어 focus 를 되살렸다(2026-08-15 성능/UX 개편).
  host.innerHTML = "";
  const note = document.createElement("div");
  note.className = "sm-section-note";
  note.textContent = SCT.note + " " + SCT.modHint;
  const bar = document.createElement("div");
  bar.className = "sc-bar";
  bar.innerHTML = `<input class="sc-search" placeholder="${esc(SCT.search)}" spellcheck="false" />`;
  const resetAll = document.createElement("button");
  resetAll.className = "sc-reset-all";
  resetAll.textContent = SCT.resetAll;
  resetAll.addEventListener("click", () => { SC.resetAll(); paint(); });
  bar.appendChild(resetAll);
  const conflictNote = document.createElement("div");
  conflictNote.className = "sc-conflict-note hidden";
  conflictNote.textContent = SCT.conflictNote;
  const list = document.createElement("div");
  list.className = "sm-card2 sc-list";
  const recHint = document.createElement("div");
  recHint.className = "sm-section-note hidden";
  recHint.textContent = SCT.recordingHint;
  host.append(note, bar, conflictNote, list, recHint);
  const search = bar.querySelector(".sc-search");
  search.addEventListener("input", () => { filter = search.value; paint(); });

  function paint() {
    const binds = SC.bindings();
    const conflicts = findConflicts(binds);
    conflictNote.classList.toggle("hidden", !Object.keys(conflicts).length);
    recHint.classList.toggle("hidden", !recording);
    list.innerHTML = "";

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
      // ── 행 전체가 버튼이다(2026-08-15 UI 개편) — 예전엔 우측 작은 알약만 클릭 대상이라
      //  "행을 누르고 새 조합" 안내와 실제 히트영역이 어긋났다. 조합은 낱개 키캡(⌘ ⇧ E)으로
      //  그리고, 보조 동작(기본값으로/지우기)은 평소엔 숨겼다가 hover 에만 보인다(노이즈 제거).
      const row = document.createElement("div");
      const isRec = recording === c.id;
      const clash = combo && conflicts[combo];
      row.className = "sc-row" + (isRec ? " rec" : "") + (clash ? " clash" : "");
      row.tabIndex = 0;
      const keysHtml = isRec
        ? `<span class="sc-waiting">${esc(SCT.recording)}</span>`
        : combo
          ? formatComboParts(combo, SC.IS_APPLE).map((k) => `<kbd class="sc-cap">${esc(k)}</kbd>`).join("")
          : `<span class="sc-none">${esc(SCT.none)}</span>`;
      row.innerHTML =
        `<span class="sc-name">${esc(label)}</span>`
        + (clash ? `<span class="sc-badge">${esc(SCT.conflict)}</span>` : "")
        + `<span class="sc-acts"></span>`
        + `<span class="sc-keys" title="${esc(shownCombo)}">${keysHtml}</span>`;
      row.addEventListener("click", () => (isRec ? (stopRecording(), paint()) : startRecording(c.id)));
      row.addEventListener("keydown", (e) => {
        if (!isRec && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); startRecording(c.id); }
      });
      const acts = row.querySelector(".sc-acts");
      const mini = (text, onClick) => {
        const b = document.createElement("button");
        b.className = "sc-mini";
        b.textContent = text;
        b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        acts.appendChild(b);
      };
      if (!SC.isDefault(c.id)) mini(SCT.reset, () => { SC.resetBinding(c.id); paint(); });
      else if (combo) mini(SCT.unbind, () => { SC.setBinding(c.id, null); paint(); });
      list.appendChild(row);
    }
    if (!shown) {
      const e = document.createElement("div");
      e.className = "sc-empty";
      e.textContent = T.empty;
      list.appendChild(e);
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
