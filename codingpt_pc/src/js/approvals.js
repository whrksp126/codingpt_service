// approvals.js — 원격 승인 인박스(기능1) PC UI. 카드 렌더 + 응답 + 카운트다운.
//
// 왜 DOM 카드인가(별도 오버레이 창 불필요): punch-through 전환 이후 프리뷰 네이티브 웹뷰는 앱 UI
//  **아래층**이라, 평범한 DOM 이 프리뷰 위에 그려진다(pane.js 헤더 주석·알림 패널과 같은 전제).
//  단 프리뷰 구멍 안의 클릭이 뒤로 내려가지 않게 main.js 의 previewShield SEL 에 `.approval-card` 를
//  넣어야 한다 — 안 하면 카드가 보이는데 뒤의 프리뷰가 클릭을 받는다.
//
// ★ 표시 위치 = **Chat 모드의 컴포저 위 슬롯 `.chat-approvals` 하나뿐**(2026-07-28 확정).
//  TUI 모드에는 띄우지 않는다 — 터미널 화면이 이미 그 질문을 그리고 있어서 같은 질문이 두 개로 보인다.
//
//  **전역 스택은 폐기했다.** 화면 하단 중앙에 모든 대기 카드를 띄웠더니, codex 탭을 보고 있는데
//  claude 탭의 질문 카드가 떠 있었다(사용자 신고). 어느 터미널의 질문인지 화면이 말해주지 않으면
//  답이 엉뚱한 세션으로 간다 — 터미널 간 간섭 0 이 이 라운드의 요구사항이다.
//  다른 탭에서 기다리는 건 **탭의 점**과 알림(패널/푸시)이 알린다. win 을 못 실은 구 요청은 알림 행에서
//  바로 응답한다(notifications.js) — 답할 길이 사라지지는 않는다.
//
// 절대 만들지 않는 것: **"항상 허용"** 버튼. claude 2.1.220 의 PermissionRequest 훅에는 그 개념이 없고
//  (실측), 있는 척 만들면 사용자가 "다시 안 묻겠지" 하고 눌렀는데 계속 묻는 신뢰 붕괴가 된다.
import * as S from "./state.js";
import { state } from "./state.js";
import { icons } from "./icons.js";
import { renderMarkdown, escapeHtml } from "./chat-md.js";
import { fmtRemain, remainMs } from "./chat-model.js";
import { setChatApprovalRenderer, refreshChatApprovals } from "./chat-view.js";

// '기타' 선택 표식 — 실제 라벨과 부딪히지 않게 내부 전용 심볼 문자열을 쓴다.
const ETC = "\u0000etc";

let mounted = false;
let tickTimer = null;

export function mountApprovals() {
  if (mounted) return;
  mounted = true;
  // Chat 뷰가 자기 슬롯을 그릴 때 이 렌더러를 쓴다(순환 import 회피 — chat-view 는 우리를 모른다).
  setChatApprovalRenderer(renderScoped);
  // 카운트다운 — 카드가 있을 때만 1s 틱(없으면 타이머도 없다).
  tickTimer = setInterval(() => {
    if (!state.approvals.length) return;
    for (const el of document.querySelectorAll(".approval-card[data-deadline]")) {
      const left = remainMs(el.dataset.deadline);
      const t = el.querySelector(".apc-clock");
      if (t) t.textContent = left > 0 ? fmtRemain(left) : "마감";
      const expired = left <= 0;
      if (expired !== (el.dataset.expired === "1")) {
        el.dataset.expired = expired ? "1" : "0";
        // 마감 = 데몬이 defer 로 TUI 다이얼로그에 넘긴 상태. 여기서 답하면 410 이므로 응답 UI 를 걷는다.
        el.classList.toggle("expired", expired);
        const acts = el.querySelector(".apc-actions");
        if (acts && expired) {
          acts.innerHTML = `<div class="apc-expired-msg">마감됐습니다 — PC 터미널에서 답해주세요</div>` +
            `<button class="apc-btn ghost" data-act="dismiss">확인</button>`;
        }
      }
    }
  }, 1000);
}

// 매 emit 마다 호출(main.js render) — Chat 슬롯(컴포저 위)을 동기화한다.
export function updateApprovals() {
  refreshChatApprovals();
}

// 이 터미널의 대기 목록 — **엄격 일치**(cwd + win). win 이 없는 요청은 어느 pane 에도 붙이지 않는다.
//  "남의 터미널에 뜨는 것" 이 "그 탭에 안 뜨는 것" 보다 나쁘다(앱 paneApproval.ts 와 같은 규칙).
export function forPane(cwd, win) {
  if (!cwd || win == null) return [];
  return state.approvals.filter((a) => (a.cwd || "") === cwd && a.win === win);
}

// 탭의 점용 — **아직 답할 수 있는** 요청만 센다. 마감이 지난 건(PC 터미널로 넘어감)은 그 탭을
//  열어도 할 수 있는 일이 없으므로 부르지 않는다.
export function paneApprovalCount(cwd, win) {
  const now = Date.now();
  return forPane(cwd, win).filter((a) => !a.deadlineAt || a.deadlineAt > now).length;
}

// Chat 뷰 슬롯용 — 그 (cwd,win) 카드만.
function renderScoped(host, { cwd, win, visible }) {
  renderList(host, visible ? forPane(cwd, win) : []);
}

// ── 렌더 ──
// 카드 DOM 은 id 로 재사용한다(매 emit 마다 innerHTML 을 갈아치우면 사용자가 입력 중인 자유답변
//  텍스트와 다중선택 체크가 날아간다 — 알림 패널처럼 통째 재생성하면 안 되는 이유).
function renderList(host, rows) {
  const want = new Map(rows.map((a) => [a.id, a]));
  for (const el of [...host.children]) {
    if (!want.has(el.dataset.id)) el.remove();
  }
  for (const a of rows) {
    let el = host.querySelector(`.approval-card[data-id="${cssEsc(a.id)}"]`);
    if (!el) { el = buildCard(a); host.appendChild(el); }
    syncCard(el, a);
  }
}

function cssEsc(s) {
  try { return CSS.escape(String(s)); } catch (_) { return String(s).replace(/["\\]/g, "\\$&"); }
}

function isChoice(a) {
  const k = (a.prompt && a.prompt.kind) || a.kind;
  return k === "choice";
}
function questionsOf(a) {
  const qs = a.prompt && Array.isArray(a.prompt.questions) ? a.prompt.questions : null;
  return qs && qs.length ? qs : null;
}

function buildCard(a) {
  const el = document.createElement("div");
  el.className = "approval-card";
  el.dataset.id = a.id;
  if (a.deadlineAt) el.dataset.deadline = String(a.deadlineAt);

  // ★ 질문(AskUserQuestion)은 **승인 카드가 아니라 질문 카드**다(사용자 확정 2026-07-28).
  //  '승인 필요' 배지·도구명·「워크스페이스」·호스트·요청 상세는 전부 잡음이다 — 사용자가 볼 것은
  //  질문 하나와 고를 항목뿐이다. 질문이 여러 개면 **한 번에 하나씩**, ‹ › 로 오가며 답한다
  //  (전부 펼쳐 놓으면 화면을 가득 채운다 — 그 화면이 이 규칙을 만든 계기다).
  const qsAll = questionsOf(a);
  if (isChoice(a) && qsAll) {
    el.classList.add("q");
    el._qs = qsAll;
    el._picks = new Map();
    el._etc = new Map();   // qi → 기타 입력값
    el._step = 0;
    el._folded = false;
    el.innerHTML = `<div class="apc-qwrap"></div><div class="apc-err hidden"></div>`;
    renderQuestionStep(el, a);
    el.addEventListener("click", (e) => onCardClick(e, el, a));
    // '기타' 입력은 Enter 로 보낸다(별도 버튼을 두면 푸터가 복잡해진다).
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.classList?.contains("apc-free-input")) return;
      e.preventDefault();
      syncEtc(el);
      const i = el._step || 0;
      if (i < (el._qs || []).length - 1) { el._step = i + 1; renderQuestionStep(el, a); return; }
      submitQuestionCard(el, a).catch(() => {});
    });
    return el;
  }

  const host = a.hostName ? ` · ${a.hostName}` : "";
  const where = a.wsName ? `「${a.wsName}」` : "";
  el.innerHTML =
    `<div class="apc-head">` +
      `<span class="apc-ic">${icons.shield({ size: 15 })}</span>` +
      `<span class="apc-title">승인 필요</span>` +
      `<span class="apc-tool">${escapeHtml(a.tool || "Tool")}</span>` +
    `</div>` +
    `<div class="apc-where">${escapeHtml(where + host)}</div>` +
    `<div class="apc-body"></div>` +
    `<div class="apc-err hidden"></div>` +
    `<div class="apc-actions"></div>`;

  // 본문 — 도구 성격별로 보여줄 것이 다르다.
  const body = el.querySelector(".apc-body");
  const plan = a.prompt && typeof a.prompt.plan === "string" ? a.prompt.plan : "";
  if (plan) {
    const p = document.createElement("div");
    p.className = "apc-plan";
    p.innerHTML = renderMarkdown(plan);
    body.appendChild(p);
  } else if (a.summary) {
    const s = document.createElement("div");
    s.className = "apc-summary" + (a.tool === "Bash" ? " mono" : "");
    s.textContent = a.summary;
    body.appendChild(s);
  }
  if (a.relPath) {
    const p = document.createElement("div");
    p.className = "apc-path";
    p.textContent = a.relPath;
    body.appendChild(p);
  }
  // diff(파일 수정) — 있으면 접힌 프리뷰. 데몬이 채우면 표시된다(없어도 정상).
  if (a.diff && (a.diff.newContent || a.diff.oldContent)) {
    const d = document.createElement("details");
    d.className = "apc-fold";
    d.innerHTML = `<summary>변경 내용</summary><pre class="apc-pre">${escapeHtml(String(a.diff.newContent || a.diff.oldContent).slice(0, 4000))}</pre>`;
    body.appendChild(d);
  }
  // 원본 입력 — 명령 전문/인수는 접어둔다(카드가 길어지면 버튼이 화면 밖으로 밀린다).
  if (a.inputPreview && typeof a.inputPreview === "object" && !a.inputPreview.truncated) {
    let txt = "";
    try { txt = JSON.stringify(a.inputPreview, null, 2); } catch (_) { txt = ""; }
    if (txt && txt.length > 2) {
      const d = document.createElement("details");
      d.className = "apc-fold";
      d.innerHTML = `<summary>요청 상세</summary><pre class="apc-pre">${escapeHtml(txt.slice(0, 4000))}</pre>`;
      body.appendChild(d);
    }
  }

  buildActions(el, a);

  el.addEventListener("click", (e) => onCardClick(e, el, a));
  return el;
}

// ── 질문 카드(한 번에 하나) ─────────────────────────────────────────
// 배치는 Claude 앱과 같다: [질문] … [‹ n개 중 m개 ›] [✕] / 번호 붙은 선택지 / [✎ 기타] [건너뛰기].
//  · 선택 = 다음 질문으로 자동 진행(마지막이면 전송) — Enter 한 번으로 끝나는 흐름.
//  · 고른 답은 el._picks 에 모아 두고 **마지막에 한 번에** 보낸다(첫 답만 가면 나머지가 미답이 된다).
//  · 답을 되짚어 고칠 수 있어야 하므로 ‹ › 로 앞뒤 이동한다(선택은 유지된다).
function renderQuestionStep(el, a) {
  const qs = el._qs || [];
  const i = Math.max(0, Math.min(qs.length - 1, el._step || 0));
  el._step = i;
  const q = qs[i] || {};
  const picks = el._picks.get(i) || [];
  const multi = !!q.multiSelect;
  const wrap = el.querySelector(".apc-qwrap");
  if (!wrap) return;
  const etcOn = picks.includes(ETC);
  const opts = (q.options || []).map((o, k) => {
    const on = picks.includes(o.label);
    return `<button class="apc-qopt${on ? " on" : ""}" type="button" data-act="qpick" data-label="${escapeHtml(o.label || "")}">` +
      `<span class="apc-qtext"><span class="apc-qlabel">${escapeHtml(o.label || `선택 ${k + 1}`)}</span>` +
      (o.description ? `<span class="apc-qdesc">${escapeHtml(o.description)}</span>` : "") + `</span>` +
      `<span class="apc-qnum">${k + 1}</span>` +
    `</button>`;
  }).join("");
  // 기타 — 선택지에 없는 답. 행 자체가 하나의 선택지이고, 고르면 그 안에서 바로 입력한다.
  const etcNum = (q.options || []).length + 1;
  const etc =
    `<div class="apc-qopt etc${etcOn ? " on" : ""}">` +
      `<button class="apc-qetc-head" type="button" data-act="qetc">` +
        `<span class="apc-qlabel">기타</span><span class="apc-qnum">${etcNum}</span>` +
      `</button>` +
      (etcOn ? `<input class="apc-free-input" type="text" placeholder="여기에 답변을 입력하세요" value="${escapeHtml(el._etc.get(i) || "")}" />` : "") +
    `</div>`;
  const lastOne = i === qs.length - 1;
  const canGo = picks.length > 0 || !!String(el._etc.get(i) || "").trim();
  wrap.innerHTML =
    `<div class="apc-qtop">` +
      (qs.length > 1 ? `<span class="apc-qbadge">${i + 1}/${qs.length}</span>` : "") +
      `<span class="apc-qtitle">${escapeHtml(q.question || q.header || "")}</span>` +
      `<button class="apc-nav" type="button" data-act="qfold" title="접기">${el._folded ? "⌃" : "⌄"}</button>` +
      `<button class="apc-nav" type="button" data-act="dismiss" title="닫기">✕</button>` +
    `</div>` +
    (el._folded ? "" :
      `<div class="apc-qopts">${opts}${etc}</div>` +
      `<div class="apc-qfoot">` +
        `<button class="apc-btn ghost" type="button" data-act="qprev" ${i === 0 ? "disabled" : ""}>뒤로</button>` +
        `<span class="apc-qspacer"></span>` +
        `<button class="apc-btn ghost" type="button" data-act="qskip">건너뛰기</button>` +
        `<button class="apc-btn primary" type="button" data-act="qadvance" ${canGo ? "" : "disabled"}>${lastOne ? "보내기" : "다음"} ↵</button>` +
      `</div>`) +
    (multi ? `<div class="apc-qhint">여러 개 고를 수 있어요</div>` : "");
  if (etcOn) wrap.querySelector(".etc .apc-free-input")?.focus();
}

// 화면의 '기타' 입력값을 상태로 옮긴다 — 재렌더로 DOM 이 갈리기 전에 반드시 부른다.
function syncEtc(el) {
  const input = el.querySelector(".etc .apc-free-input");
  if (input) el._etc.set(el._step || 0, String(input.value || ""));
}

// 지금까지 고른 답을 **한 번에** 보낸다. 아무것도 없으면 거절로 끝낸다(빈 응답 금지).
async function submitQuestionCard(el, a) {
  syncEtc(el);
  const answers = [];
  for (const [qi, labels] of [...el._picks.entries()].sort((x, y) => x[0] - y[0])) {
    if (!labels || !labels.length) continue;
    if (labels.includes(ETC)) {
      const text = String(el._etc.get(qi) || "").trim();
      if (text) answers.push({ questionIndex: qi, labels: [], text });
      continue;
    }
    answers.push({ questionIndex: qi, labels });
  }
  if (!answers.length) { await S.respondApproval(a.id, { decision: "deny", message: "원격 기기에서 건너뛰었습니다" }); return; }
  await S.respondApproval(a.id, { decision: "answer", answers });
}

// 응답 UI — 선택형(choice)과 권한형(permission)이 완전히 다르다.
function buildActions(el, a) {
  const acts = el.querySelector(".apc-actions");
  acts.innerHTML = "";
  // 질문(선택지) 카드는 buildCard 가 renderQuestionStep 으로 따로 그린다 — 여기 오지 않는다.
  if (isChoice(a)) {
    // 선택지가 없는 선택형 = ExitPlanMode(계획 승인). 데몬 규약상
    //  allow → "계획을 승인했습니다. 계획대로 진행하세요." / deny(+message) → "거절했습니다: …"
    //  answer.text → "다음과 같이 답했습니다: …"(계획을 조금 고쳐 진행시키는 경로).
    const wrap = document.createElement("div");
    wrap.className = "apc-choices";
    wrap.innerHTML =
      `<div class="apc-free">` +
        `<input class="apc-free-input" type="text" placeholder="의견을 붙여 답하기(선택)…" />` +
        `<button class="apc-btn" type="button" data-act="answerText">의견 보내기</button>` +
      `</div>` +
      `<div class="apc-actions-inline">` +
        `<button class="apc-btn ghost" type="button" data-act="deny">거절</button>` +
        `<button class="apc-btn primary" type="button" data-act="allow">승인</button>` +
      `</div>`;
    acts.appendChild(wrap);
    return;
  }
  // 권한형 — [거절][허용] 2버튼. "항상 허용"은 만들지 않는다(위 헤더 주석).
  acts.innerHTML =
    `<button class="apc-btn ghost" type="button" data-act="deny">거절</button>` +
    `<button class="apc-btn primary" type="button" data-act="allow">허용</button>`;
}

function syncCard(el, a) {
  if (a.deadlineAt) el.dataset.deadline = String(a.deadlineAt);
  el.classList.toggle("busy", !!a._busy);
  const err = el.querySelector(".apc-err");
  if (err) {
    err.classList.toggle("hidden", !a._err);
    err.textContent = a._err || "";
  }
}

async function onCardClick(e, el, a) {
  const btn = e.target.closest?.("[data-act]");
  if (!btn) return;
  e.stopPropagation();
  const act = btn.dataset.act;
  if (act === "dismiss") { S.dismissApproval(a.id); return; }
  if (a._busy) return;
  if (act === "allow") { await S.respondApproval(a.id, { decision: "allow" }); return; }
  if (act === "deny") { await S.respondApproval(a.id, { decision: "deny" }); return; }
  // ── 질문 카드(한 번에 하나) ──
  //  선택 = **고르기만** 한다(자동 진행 없음). 넘어가는 것은 [다음] / [건너뛰기] 뿐 —
  //  누르자마자 넘어가면 잘못 눌렀을 때 되돌릴 틈이 없다(참고 UI 도 같은 규칙).
  if (act === "qprev") { syncEtc(el); el._step = Math.max(0, (el._step || 0) - 1); renderQuestionStep(el, a); return; }
  if (act === "qfold") { el._folded = !el._folded; renderQuestionStep(el, a); return; }
  if (act === "qpick") {
    syncEtc(el);
    const i = el._step || 0;
    const q = (el._qs || [])[i] || {};
    const label = btn.dataset.label || "";
    const cur = el._picks.get(i) || [];
    if (q.multiSelect) el._picks.set(i, cur.includes(label) ? cur.filter((x) => x !== label) : [...cur.filter((x) => x !== ETC), label]);
    else el._picks.set(i, cur.length === 1 && cur[0] === label ? [] : [label]);
    renderQuestionStep(el, a);
    return;
  }
  if (act === "qetc") {
    syncEtc(el);
    const i = el._step || 0;
    const cur = el._picks.get(i) || [];
    // 기타는 선택지와 배타 — 고르면 그 질문의 답은 자유 입력이 된다.
    el._picks.set(i, cur.includes(ETC) ? [] : [ETC]);
    renderQuestionStep(el, a);
    return;
  }
  if (act === "qskip") {
    const i = el._step || 0;
    el._picks.delete(i);
    el._etc.delete(i);
    if (i < (el._qs || []).length - 1) { el._step = i + 1; renderQuestionStep(el, a); return; }
    await submitQuestionCard(el, a);
    return;
  }
  if (act === "qadvance") {
    syncEtc(el);
    const i = el._step || 0;
    if (i < (el._qs || []).length - 1) { el._step = i + 1; renderQuestionStep(el, a); return; }
    await submitQuestionCard(el, a);
    return;
  }
  // (구 '전부 펼치기' 카드의 toggle/one/pick/pickMulti 핸들러는 질문 카드 스테퍼로 대체돼 삭제됐다.)
  if (act === "answerText") {
    const input = el.querySelector(".apc-free-input");
    const text = String(input?.value || "").trim();
    if (!text) { flashErr(el, "보낼 내용을 입력해 주세요"); input?.focus(); return; }
    await S.respondApproval(a.id, { decision: "answer", answers: [{ questionIndex: 0, labels: [], text }] });
    return;
  }
}

function flashErr(el, msg) {
  const err = el.querySelector(".apc-err");
  if (!err) return;
  err.textContent = msg;
  err.classList.remove("hidden");
  setTimeout(() => { if (err.textContent === msg) err.classList.add("hidden"); }, 2500);
}

// 알림 패널의 승인 행에서 쓰는 인라인 응답(notifications.js) — 카드와 같은 계약을 재사용한다.
export function approvalForNotif(n) {
  if (!n || n.kind !== "approval_request") return null;
  // 알림 행에는 approvalId 가 없다 → (cwd,win,notifId) 로 대기 목록에서 되찾는다.
  return (
    state.approvals.find((a) => a.notifId != null && n.id != null && String(a.notifId) === String(n.id)) ||
    state.approvals.find((a) => (a.cwd || "") === (n.cwd || "") && String(a.win) === String(n.win)) ||
    null
  );
}
export { isChoice as isChoiceApproval };
