// emulator-close — 모바일 화면(시뮬레이터/에뮬레이터)을 보여 주던 pane·탭을 닫을 때, 그 기기가 아직 켜져
//  있으면 끌지 묻는다(2026-10-23 사용자 확정).
//  ★ 배경: pane 을 닫아도 기기는 그대로 켜져 있었다(EmulatorView.dispose 는 영상만 끊는다). 사용자는 "닫으면
//   꺼진다"고 믿었고, 화면 없이 부팅된 iOS 시뮬레이터가 22일 동안 3~5분마다 CPU 를 튀기고 있었다.
//  규칙: 켜져 있으면 [끄고 닫기 / 켜 둔 채 닫기 / 취소], 꺼져 있으면(또는 기기를 안 골랐으면) 묻지 않고 닫는다.
//   CodingPT 밖에서 켠 기기여도 똑같이 묻는다 — "켜 둔 채 닫기" 가 있어서 손해가 없다.
//   에이전트 PC(desktop:*)는 대상이 아니다(VM 은 자체 전원 버튼·유휴 정리가 따로 있다).
//   사용자가 직접 닫을 때만 부른다 — 탭 이동·pane 합치기·다른 기기에서 온 닫기는 묻지 않는다.
import { api } from "./api.js";
import * as T from "./tiling.js";
import * as i18n from "./i18n/index.js";

const isDesk = (id) => typeof id === "string" && id.startsWith("desktop:");

/** 닫히는 노드(leaf 또는 탭) 안의 모바일 화면 기기 id 들. */
export function emulatorIdsOf(node) {
  const ids = [];
  if (!node) return ids;
  if (node.kind === "emulator" && node.deviceId && !isDesk(node.deviceId)) ids.push(node.deviceId);
  for (const t of node.tabs || []) if (t && t.kind === "emulator" && t.deviceId && !isDesk(t.deviceId)) ids.push(t.deviceId);
  return [...new Set(ids)];
}

/** 같은 기기를 다른 곳(이 레이아웃의 다른 pane/탭)에서도 보고 있으면 끄자고 묻지 않는다. */
function shownElsewhere(layout, id, except) {
  let hit = false;
  T.eachLeaf(layout, (l) => {
    if (hit) return;
    if (l.kind === "emulator" && l !== except && l.deviceId === id) hit = true;
    for (const t of l.tabs || []) if (t !== except && t.kind === "emulator" && t.deviceId === id) hit = true;
  });
  return hit;
}

function ask(names) {
  return new Promise((resolve) => {
    if (document.querySelector(".quit-guard-backdrop")) { resolve("cancel"); return; }
    const bd = document.createElement("div");
    bd.className = "quit-guard-backdrop";
    bd.innerHTML = `
      <div class="quit-guard">
        <div class="qg-title"></div>
        <div class="qg-desc"></div>
        <div class="qg-actions">
          <button class="qg-btn qg-cancel"></button>
          <button class="qg-btn qg-keep"></button>
          <button class="qg-btn qg-quit qg-off"></button>
        </div>
      </div>`;
    bd.querySelector(".qg-title").textContent = i18n.t("기기를 끌까요?");
    bd.querySelector(".qg-desc").textContent = i18n.t("{name}이(가) 아직 켜져 있어요. 화면을 닫아도 기기는 꺼지지 않고 계속 돌아갑니다.", { name: names.join(", ") });
    bd.querySelector(".qg-cancel").textContent = i18n.t("취소");
    bd.querySelector(".qg-keep").textContent = i18n.t("켜 둔 채 닫기");
    bd.querySelector(".qg-off").textContent = i18n.t("끄고 닫기");
    const done = (v) => { bd.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done("cancel"); } };
    bd.querySelector(".qg-cancel").addEventListener("click", () => done("cancel"));
    bd.querySelector(".qg-keep").addEventListener("click", () => done("keep"));
    bd.querySelector(".qg-off").addEventListener("click", () => done("off"));
    bd.addEventListener("click", (e) => { if (e.target === bd) done("cancel"); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(bd);
    bd.querySelector(".qg-off").focus();
  });
}

/**
 * 닫기 전 확인. true = 닫아도 된다(필요하면 기기 끄기를 이미 시작했다), false = 취소.
 * @param node 닫히는 leaf 또는 탭
 * @param layout 현재 워크스페이스 레이아웃(다른 곳에서도 보는 기기 판정용)
 */
export async function confirmEmulatorClose(node, layout) {
  const ids = emulatorIdsOf(node).filter((id) => !shownElsewhere(layout, id, node));
  if (!ids.length) return true;
  let devices = [];
  try { devices = ((await api.emulatorList()) || {}).devices || []; } catch (_) { return true; } // 데몬 불통 — 묻지 않고 닫는다(지금까지와 같음)
  const on = devices.filter((d) => ids.includes(d.id) && d.state === "booted" && !d.physical);
  if (!on.length) return true;
  const ans = await ask(on.map((d) => d.name || d.id));
  if (ans === "cancel") return false;
  if (ans === "off") for (const d of on) api.emulatorPower(d.id, "shutdown").catch((e) => api.debugLog(`[emu] 끄기 실패 ${d.id}: ${e && e.message ? e.message : e}`));
  return true;
}
