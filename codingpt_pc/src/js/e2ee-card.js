// e2ee-card.js — 기기 승인/대기 화면이 **공유하는 조각들**(안전 코드 칩 · 요청번호 · 경고 · 시각 표기).
//
// 왜 별도 파일인가: 개정 6(2026-07-28)에서 승인 카드가 설정(settings.js)에서 전역 카드
//  (device-approval.js)로 옮겨갔고, 대기 화면은 설정에 남았다. 같은 값을 두 곳이 그리는데 조각을
//  복사해 두면 한쪽만 다듬는 순간 **폰과 PC가 다른 코드를 보여 준다**(대조가 깨진다 = 이 UX 의 존재
//  이유가 사라진다). 그래서 그리는 방법을 한 곳에 둔다 — 문구 정본은 여전히 카피 감사 문서다.
//  ⚠ 모바일 미러: SafetyCode/RequestNo/NoSafety(DeviceTrustCard.tsx). 한쪽만 바꾸지 말 것.
export function escCard(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** 승인 카드 헤더의 시각(모바일 DeviceTrustCard fmtWhen 미러 — 같은 표기여야 한다). */
export function fmtWhen(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!t) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

/** 60비트 안전 코드 — 4글자 3그룹 칩(모바일 SafetyCode 와 같은 그룹 구분·글자수·색). */
export function safetyChips(code, color) {
  const groups = String(code || "").split("-").filter(Boolean);
  const g = groups.length ? groups : ["—", "—", "—"];
  // flex-wrap = 좁은 창에서도 3블록이 잘리지 않고 접힌다(칩 자체는 줄어들지 않는다 — 대조 대상이다).
  return `<span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${g.map((s) => `
    <span style="padding:7px 10px;border-radius:var(--r-md);background:var(--elevated2);border:1px solid var(--border-ctrl);
      font-family:var(--mono);font-size:22px;font-weight:800;letter-spacing:2px;color:${color};user-select:text">${escCard(s)}</span>`).join("")}</span>`;
}

/** 요청 구분용 4자리(보조 표기) — 크기·문구로 "대조용이 아님"을 분명히 한다(모바일 RequestNo 미러). */
export function requestNo(code) {
  if (!code) return "";
  return `<div class="acct-msg" style="text-align:center">요청 <span style="font-family:var(--mono)">${escCard(code)}</span> · 대조용 아님</div>`;
}

/**
 * 안전 코드를 **계산할 수 없을 때**의 경고(= 파생 기준 userRef 미상 → e2ee.js deriveDisplay 가 null).
 *  '—' 만 그려 두면 사용자는 무엇을 대조해야 할지 모른 채 승인한다 → 칩 대신 이 경고를 그리고
 *  **승인 버튼을 비활성**한다(앱과 같은 규칙 — 카피 감사 §3-B).
 */
export function noSafetyCodeWarn() {
  return `<div class="acct-msg" style="color:var(--warn,#FBBF24)">안전 코드를 아직 못 만들었어요 · 승인하지 마세요</div>`;
}
/**
 * 같은 상황이지만 **대기 기기 자신**의 화면 전용 경고(모바일 `COPY.wait.noSafety` 와 동일 문구).
 *  그 화면에는 승인 버튼이 없다 → 승인자용 문구를 재사용하면 지시 대상이 어긋난다(누를 곳을 명시).
 */
export function waitNoSafetyWarn() {
  return `<div class="acct-msg" style="color:var(--warn,#FBBF24)">안전 코드를 아직 못 만들었어요 · 기존 기기에서 승인하지 마세요</div>`;
}
/** 표시값이 서버 지배 상태(verified=false) — 안전 코드가 **있을 때만** 그린다(경고는 한 번에 하나). */
export function unverifiedWarn() {
  return `<div class="acct-msg" style="color:var(--warn,#FBBF24)">요청 번호는 서버 값 · 코드로만 대조하세요</div>`;
}
/** 대조 지침(§2.10) — 접힌 `코드 확인` 안에서만 보인다(개정 5). */
export function compareInstr() {
  return `<div class="acct-msg" style="color:var(--text2);padding-top:0">새 기기 화면에도 같은 코드가 보이면 승인하세요. 정상이라면 항상 같아요 — 다르면 연결이 안전하지 않은 것이니 거절하세요.</div>`;
}
