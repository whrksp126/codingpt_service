// device-approval.js — 기기 승인(E2EE 열쇠 배포) **전역 카드**. 설정 화면 밖의 독립 표면.
//
// ★ 2026-07-28 사용자 확정(요구 원문): "승인 같은 건 설정>계정에서 하려고 하지 말고! 별도의 알림에서
//  바로 승인이나 또는 모달이나 바텀시트나 풀시트 같은 걸로 처리하는 게 좋을 것 같아! 구글에서 다른
//  기기로 로그인했을 때 승인된 기기에서 알림이 뜨는 것처럼!"
//  → 승인은 **일시적 사건**이고 설정(영구 상태 관리)과 수명이 다르다. 그래서 두 표면으로 분리했다:
//    ① 이 파일 = 화면 상단 중앙 카드(로그인 확인 프롬프트). 사건이 있는 동안만 존재한다.
//    ② 알림 패널 행 인라인 승인(notifications.js) — 카드를 닫았거나 나중에 처리할 때의 경로.
//  설정 > 계정 > `기기` 는 **연동 상태 관리**만 한다(누가 연동됐나 · [연동] 버튼) — 승인 버튼 없음.
//
// 왜 별도 스택인가: 기능1 승인 카드 스택(approvals.js `.approval-stack`)은 하단 중앙이고 자기 목록으로
//  DOM 을 화해한다(자기 것이 아닌 자식은 지운다). 같은 컨테이너에 끼워 넣으면 매 emit 마다 지워진다.
//  위치도 일부러 다르다 — 도구 승인(하단)과 계정 로그인 확인(상단)은 성격이 다른 사건이다.
//
// 시각 언어는 기능1 카드와 공유한다(`.approval-card` / `.apc-*`) — 사용자가 이미 아는 모양이고,
//  main.js previewShield SEL 이 `.approval-card` 를 이미 포함해 프리뷰 위 클릭이 새지 않는다.
import { state } from "./state.js";
import * as S from "./state.js";
import { icons } from "./icons.js";
import { e2ee, e2eePendingApprovable, approveDevice, denyDevice } from "./e2ee.js";
// 카드 조각(안전 코드 칩·요청번호·경고·시각)은 대기 화면(settings.js)과 **공유**한다 — 복사하면
//  한쪽만 다듬는 순간 두 화면이 다른 값을 그린다(대조 불가). 근거는 e2ee-card.js 헤더.
import { safetyChips, requestNo, fmtWhen, noSafetyCodeWarn, unverifiedWarn, compareInstr } from "./e2ee-card.js";

let stackEl = null;
// 사용자가 ✕ 로 닫은 요청(이 세션 한정) — 알림 패널에서 계속 처리할 수 있으므로 유실이 아니다.
const dismissed = new Set();
const codeOpen = new Set();
let busyId = null;
let errMsg = "";

export function mountDeviceApprovals() {
  if (stackEl) return;
  stackEl = document.createElement("div");
  stackEl.className = "dev-appr-stack";
  document.body.appendChild(stackEl);
  updateDeviceApprovals();
}

/** main.js render() 에서 매 emit 마다 호출 — 목록이 곧 화면이다(카드에 입력 상태가 없어 통째 렌더 OK). */
export function updateDeviceApprovals() {
  if (!stackEl) return;
  const rows = e2eePendingApprovable().filter((p) => !dismissed.has(p.enrollmentId));
  if (!rows.length) { stackEl.innerHTML = ""; return; }
  stackEl.innerHTML = rows.map(cardHtml).join("");
  bind();
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cardHtml(p) {
  const id = esc(p.enrollmentId);
  const noSafety = !p.safetyCode;
  const open = codeOpen.has(p.enrollmentId);
  const isPc = p.platform === "darwin" || p.platform === "win32" || p.platform === "linux";
  const busy = busyId === p.enrollmentId;
  return `<div class="approval-card${busy ? " busy" : ""}" data-id="${id}">
    <div class="apc-head">
      <span class="apc-ic" style="color:var(--text3)">${icons.shield({ size: 15 })}</span>
      <span class="apc-title">새 기기에서 로그인했어요</span>
      <span class="apc-clock">${esc(fmtWhen(p.requestedAt))}</span>
      <button class="dev-appr-x" data-act="dismiss" title="닫기">${icons.x({ size: 13 })}</button>
    </div>
    <div class="appr-dev">
      <span class="dev-ic">${isPc ? icons.monitor({ size: 15 }) : icons.smartphone({ size: 15 })}</span>
      <span class="dev-name" style="flex:1;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.label || "새 기기")}</span>
    </div>
    <div class="appr-ask">본인이 맞나요?</div>
    ${noSafety ? noSafetyCodeWarn() : ""}
    ${errMsg ? `<div class="apc-err">${esc(errMsg)}</div>` : ""}
    <div class="apc-actions" style="justify-content:flex-start">
      <button class="apc-btn" data-act="allow"${noSafety ? " disabled" : ""}>승인</button>
      <button class="apc-btn ghost" data-act="deny">본인이 아니에요</button>
    </div>
    ${noSafety ? "" : `<button class="appr-reveal" data-act="code">코드 확인 ${open ? "▴" : "▾"}</button>`}
    ${open && !noSafety ? `<div class="appr-code">
      ${compareInstr()}
      ${safetyChips(p.safetyCode, "var(--text)")}
      ${requestNo(p.verifyCode)}
      ${p.verified === false ? unverifiedWarn() : ""}
    </div>` : ""}
  </div>`;
}

function bind() {
  for (const el of stackEl.querySelectorAll(".approval-card")) {
    el.addEventListener("click", async (e) => {
      const b = e.target.closest?.("[data-act]");
      if (!b) return;
      e.stopPropagation();
      const id = el.dataset.id;
      const act = b.dataset.act;
      if (act === "dismiss") { dismissed.add(id); updateDeviceApprovals(); return; }
      if (act === "code") {
        if (codeOpen.has(id)) codeOpen.delete(id); else codeOpen.add(id);
        updateDeviceApprovals();
        return;
      }
      busyId = id;
      errMsg = "";
      updateDeviceApprovals();
      const r = act === "allow" ? await approveDevice(id) : await denyDevice(id);
      busyId = null;
      errMsg = r && r.ok ? "" : (r && r.error) || (act === "allow" ? "승인하지 못했어요" : "거절하지 못했어요");
      updateDeviceApprovals();
      S.emit();
    });
  }
}

/** 알림 행(notifications.js)이 쓰는 조회 — 알림의 sessionId = enrollmentId(back announce). */
export function deviceApprovalForNotif(n) {
  if (!n || n.kind !== "device_approval") return null;
  const id = n.sessionId || (typeof n.deeplink === "string" ? n.deeplink.split("/").pop() : "");
  if (!id) return null;
  return e2eePendingApprovable().find((p) => p.enrollmentId === id) || null;
}

/** 알림 행에서 카드를 다시 보이게 한다(✕ 로 닫았던 요청 복구 — 알림 클릭 시 자연스러운 기대). */
export function unDismissDeviceApproval(id) {
  if (!id) return;
  dismissed.delete(String(id));
  updateDeviceApprovals();
}

// 상태 참조(디버깅/테스트) — e2ee 상태를 여기서 복제하지 않는다는 표식.
export function _internals() { return { dismissed, codeOpen, e2ee, state }; }
