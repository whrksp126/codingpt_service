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
// "허용하고 다음부터 묻지 않기"(2번 선택지)는 **claude 가 그 요청에 규칙을 제안했을 때만** 그린다
//  (a.alwaysLabel 존재 = TUI 2번과 동일 조건). ⚠ 옛 헤더 주석은 "훅에 그 개념이 없다(실측) → 절대
//  만들지 말 것"이었으나 2026-07-29 재실측으로 **오판**으로 판명됐다(decision.updatedPermissions 로
//  규칙이 실제 기록됨). 제안이 없는데 만들면 "다시 안 묻겠지" 하고 눌렀는데 계속 묻는 신뢰 붕괴가
//  된다는 경고 자체는 여전히 유효하다 — 그래서 무조건 그리지 않고 제안 존재를 조건으로 건다.
//  codex 는 훅 계약에 이 개념이 없어(updatedPermissions 예약 필드) 항상 2개(허용/거절)다.
import * as S from "./state.js";
import { state } from "./state.js";
import { icons } from "./icons.js";
import { renderMarkdown, escapeHtml } from "./chat-md.js";
import { fmtRemain, remainMs } from "./chat-model.js";
import { setChatApprovalRenderer, refreshChatApprovals } from "./chat-view.js";
import { api } from "./api.js";

// 사용자가 ✕ 로 접은 TUI 폴백 질문 카드 — 승인 인박스에 실체가 없어(합성 행) 로컬로만 기억한다.
//  답이 트랜스크립트에 붙으면 tuiQuestion 자체가 사라지므로 영속할 필요 없다.
const dismissedTui = new Set();

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
      if (t) t.textContent = left > 0 ? fmtRemain(left) : "종료";
      const expired = left <= 0;
      if (expired !== (el.dataset.expired === "1")) {
        el.dataset.expired = expired ? "1" : "0";
        // ⚠ 이건 "마감시간"이 아니다 — 원격 카드에는 마감이 없다(2026-07-28 폐지, TUI 와 동일하게
        //  무기한 대기). 이 분기는 데몬의 좀비 청소 안전장치(24h)가 발동해 요청이 TUI 로 넘어간
        //  **극단 상황**에서만 도달한다. 여기서 답하면 410 이므로 응답 UI 를 걷고 안내만 남긴다.
        el.classList.toggle("expired", expired);
        const acts = el.querySelector(".apc-actions");
        if (acts && expired) {
          acts.innerHTML = `<div class="apc-expired-msg">이 요청은 종료됐어요 — PC 터미널에서 답해주세요</div>` +
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
//  승인 요청이 하나도 없는데 **TUI 로 폴백된 미응답 질문**이 있으면(훅 마감/데몬 재시작 뒤),
//  같은 모양의 카드를 트랜스크립트 기준으로 세운다 — TUI 가 질문을 띄우고 있는 한 채팅에서도
//  계속 답할 수 있어야 한다(2026-07-28 사용자 확정). 답은 chat.answer(다이얼로그 키 조작)로 간다.
function renderScoped(host, { cwd, win, visible, tuiQuestion }) {
  let rows = visible ? forPane(cwd, win) : [];
  // 만료 카드("PC 터미널에서 답해주세요")보다 **답할 수 있는** TUI 카드가 우선 — 같은 질문이 TUI 로
  //  넘어갔다면 이제 이 카드가 그 다이얼로그를 대신 조작한다.
  if (rows.length && tuiQuestion && tuiQuestion.msg) {
    const now = Date.now();
    if (rows.every((a) => a.deadlineAt && a.deadlineAt <= now)) rows = [];
  }
  if (visible && !rows.length && tuiQuestion && tuiQuestion.msg
      && !dismissedTui.has("tui:" + (tuiQuestion.msg.tool && tuiQuestion.msg.tool.id ? tuiQuestion.msg.tool.id : tuiQuestion.msg.seq))) {
    const m = tuiQuestion.msg;
    rows = [{
      id: "tui:" + (m.tool && m.tool.id ? m.tool.id : m.seq),
      prompt: { kind: "choice", questions: m.questions },
      cwd, win,
      _tui: {
        cwd, win, hostDeviceId: tuiQuestion.hostDeviceId,
        expect: (m.questions[0] && (m.questions[0].question || m.questions[0].header)) || "",
        onAnswered: tuiQuestion.onAnswered,
      },
    }];
  }
  renderList(host, rows);
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
// 카드 제목 — TUI 의 "Bash command" / "Edit file" 자리. 도구명만 던지지 않고 무엇을 하려는지로 읽히게 한다.
const TOOL_TITLES = {
  Bash: "명령 실행", Write: "파일 쓰기", Edit: "파일 수정", MultiEdit: "파일 여러 곳 수정",
  NotebookEdit: "노트북 수정", Read: "파일 읽기", WebFetch: "웹 가져오기", WebSearch: "웹 검색",
};
function toolTitle(tool) {
  const t = String(tool || "Tool");
  return TOOL_TITLES[t] || t;
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

  // ★ TUI 미러(prompt.mirror) — 훅이 끊겨 TUI 로 폴백된 **권한 다이얼로그의 화면 미러**(2026-07-29).
  //  선택지 문구는 화면 그대로이고, 상호작용도 TUI 와 동일하게 **누르면 즉시 전송**이다.
  //  질문 카드 부속(기타/건너뛰기/보내기/스테퍼)은 TUI 다이얼로그에 없으므로 여기에도 없다.
  const qsMirror = questionsOf(a);
  if (isChoice(a) && qsMirror && a.prompt && a.prompt.mirror) {
    const q = qsMirror[0] || {};
    el.innerHTML =
      `<div class="apc-head"><span class="apc-title">${escapeHtml(toolTitle(a.tool))}</span>` +
        `<span class="apc-qspacer"></span>` +
        `<button class="apc-nav" type="button" data-act="dismiss" title="닫기">✕</button></div>` +
      `<div class="apc-body">` +
        // 줄 구조 보존(pre-wrap) — TUI 와 같은 모양: 명령 줄들 + 설명 줄이 그대로 보인다.
        (q.question ? `<div class="apc-summary apc-prewrap${a.tool === "Bash" ? " mono" : ""}">${escapeHtml(q.question)}</div>` : "") +
      `</div>` +
      `<div class="apc-err hidden"></div>` +
      `<div class="apc-actions"><div class="apc-qopts">` +
        (q.options || []).map((o, i) => optRowHtml(`mirror:${i}`, o.label || `선택 ${i + 1}`, "", i + 1)).join("") +
      `</div></div>`;
    el.addEventListener("click", async (e) => {
      const btn = e.target.closest?.("[data-act]");
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "dismiss") { S.dismissApproval(a.id); return; }
      const m = /^mirror:(\d+)$/.exec(act);
      if (!m || a._busy) return;
      const label = ((q.options || [])[parseInt(m[1], 10)] || {}).label;
      if (!label) return;
      // TUI 숫자키 한 번과 동일 — 고르는 즉시 전달(데몬이 그 번호를 터미널에 눌러준다).
      await S.respondApproval(a.id, { decision: "answer", answers: [{ questionIndex: 0, labels: [label] }] });
    });
    return el;
  }

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

  // ★ 권한형 카드도 TUI 프롬프트와 같은 것만 보여준다(2026-07-29 사용자 확정).
  //  TUI 는 "무엇을 하려는가(도구 제목) / 대상(명령·경로) / 왜(설명) / 고를 것" 네 가지만 그린다.
  //  우리가 덧붙였던 '승인 필요' 배지·「워크스페이스」·호스트명·접힌 '요청 상세' JSON 은 전부 잡음이었다
  //  — 카드는 이미 그 워크스페이스의 그 터미널 안에 붙어 있으므로 출처를 다시 적을 이유가 없고,
  //  정작 필요한 설명(Bash description)은 접혀 있어 매번 펼쳐야 했다. 출처가 필요한 표면(알림 패널·
  //  OS 배너)은 별도 경로라 영향받지 않는다.
  el.innerHTML =
    `<div class="apc-head"><span class="apc-title">${escapeHtml(toolTitle(a.tool))}</span></div>` +
    `<div class="apc-body"></div>` +
    `<div class="apc-err hidden"></div>` +
    `<div class="apc-actions"></div>`;

  // 본문 — 도구 성격별로 보여줄 것이 다르다(TUI 와 같은 구성: 대상 → 설명).
  const body = el.querySelector(".apc-body");
  const plan = a.prompt && typeof a.prompt.plan === "string" ? a.prompt.plan : "";
  if (plan) {
    const p = document.createElement("div");
    p.className = "apc-plan";
    p.innerHTML = renderMarkdown(plan);
    body.appendChild(p);
  } else {
    // 대상 = 명령 원문(Bash) 또는 파일 경로(Write/Edit/Read…). summary 가 그 값이다.
    const target = a.summary || a.relPath || "";
    if (target) {
      const s = document.createElement("div");
      s.className = "apc-summary" + (a.tool === "Bash" ? " mono" : "");
      s.textContent = target;
      body.appendChild(s);
    }
    // 경로가 summary 와 다르면(Bash 인데 파일이 특정된 경우 등) 따로 한 줄.
    if (a.relPath && a.relPath !== target) {
      const p = document.createElement("div");
      p.className = "apc-path";
      p.textContent = a.relPath;
      body.appendChild(p);
    }
    // 설명 — TUI 가 명령 아래 회색으로 붙이는 그 한 줄. 접지 않는다(이걸 보려고 펼치던 게 문제였다).
    if (a.detail) {
      const d = document.createElement("div");
      d.className = "apc-detail";
      d.textContent = a.detail;
      body.appendChild(d);
    }
  }
  // 전체 명령(Bash) — summary 는 200자 클립이라 긴 명령의 뒷부분이 잘린다. 원문(마스킹된
  //  inputPreview.command, ~2KB)이 더 길면 접기로 전문을 제공한다(앱 도크와 같은 규칙).
  const cmdFull = a.inputPreview && typeof a.inputPreview.command === "string" ? a.inputPreview.command : "";
  if (cmdFull && cmdFull.length > String(a.summary || "").length) {
    const d = document.createElement("details");
    d.className = "apc-fold";
    d.innerHTML = `<summary>전체 명령</summary><pre class="apc-pre">${escapeHtml(cmdFull.slice(0, 4000))}</pre>`;
    body.appendChild(d);
  }
  // diff(파일 수정) — 접힌 프리뷰. Edit/MultiEdit 는 이전 → 새 내용을 나눠 보여준다(데몬 diffOf 가
  //  리댁션·16KB 캡을 이미 적용한 값). "무엇이 쓰이는지 못 보고 승인"을 없애는 유일한 표면이다.
  if (a.diff && (a.diff.newContent || a.diff.oldContent)) {
    const d = document.createElement("details");
    d.className = "apc-fold";
    const cap = (s) => escapeHtml(String(s).slice(0, 8000));
    const old = a.diff.oldContent ? `<pre class="apc-pre apc-diff-old">${cap(a.diff.oldContent)}</pre>` : "";
    const neu = a.diff.newContent ? `<pre class="apc-pre apc-diff-new">${cap(a.diff.newContent)}</pre>` : "";
    const note = a.diff.truncated ? `<div class="apc-diff-note">내용이 길어 일부만 표시됩니다</div>` : "";
    d.innerHTML = `<summary>${a.diff.kind === "write" ? "파일 내용" : "변경 내용"}</summary>${old}${neu}${note}`;
    body.appendChild(d);
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
  let canGo = picks.length > 0 || !!String(el._etc.get(i) || "").trim();
  // TUI 폴백 카드는 건너뛰기가 없다(다이얼로그가 질문을 순서대로 지나간다) — 마지막 [보내기]는
  //  **모든 질문**이 답을 갖고 있어야 켠다(하나라도 비면 데몬 조작이 중간에 멈춘다).
  const tui = !!a._tui;
  if (tui && lastOne && canGo) {
    const answered = (k) => (el._picks.get(k) || []).length > 0 || !!String(el._etc.get(k) || "").trim();
    canGo = qs.every((_, k) => k === i || answered(k));
  }
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
        (tui ? "" : `<button class="apc-btn ghost" type="button" data-act="qskip">건너뛰기</button>`) +
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

/**
 * 고른 것 → 와이어 answers[]. **순수 함수**로 뽑아 둔 이유: 여기서 조용히 틀리면(질문이 빠지거나
 *  questionIndex 가 밀리면) 에이전트가 엉뚱한 답을 받고 화면에는 아무 오류도 안 뜬다. 실제로
 *  '질문 4개 중 1개만 전달' 사고가 이 계열이었다 → contract 테스트가 이 함수를 직접 고정한다.
 *  · 라벨 선택 → { questionIndex, labels }
 *  · 기타(ETC) → { questionIndex, labels: [], text }  (빈 텍스트면 그 질문은 미답으로 둔다)
 *  · 건너뛴 질문 → 아예 싣지 않는다(빈 labels 를 보내면 데몬이 무시하거나 오해한다)
 */
export function buildAnswers(picks, etcs) {
  const out = [];
  for (const [qi, labels] of [...(picks || new Map()).entries()].sort((x, y) => x[0] - y[0])) {
    if (!labels || !labels.length) continue;
    if (labels.includes(ETC)) {
      const text = String((etcs && etcs.get(qi)) || "").trim();
      if (text) out.push({ questionIndex: qi, labels: [], text });
      continue;
    }
    out.push({ questionIndex: qi, labels });
  }
  return out;
}
export { ETC as _ETC };

// 지금까지 고른 답을 **한 번에** 보낸다. 아무것도 없으면 거절로 끝낸다(빈 응답 금지).
async function submitQuestionCard(el, a) {
  syncEtc(el);
  const answers = buildAnswers(el._picks, el._etc);
  // ── TUI 폴백 질문 — 훅이 없으므로 데몬이 다이얼로그를 키 입력으로 조작한다(chat.answer). ──
  //  다이얼로그는 질문을 **순서대로** 지나가므로 건너뛰기가 없다: 전부 답해야 보낼 수 있다.
  if (a._tui) {
    const qs = el._qs || [];
    if (answers.length !== qs.length) { flashErr(el, "모든 질문에 답해야 보낼 수 있어요"); return; }
    const wire = qs.map((q, i) => {
      const ans = answers.find((x) => x.questionIndex === i);
      const optionCount = (q.options || []).length;
      if (ans.text) return { optionIndexes: [], text: ans.text, multiSelect: !!q.multiSelect, optionCount };
      return {
        optionIndexes: ans.labels.map((l) => (q.options || []).findIndex((o) => o.label === l) + 1).filter((n) => n >= 1),
        multiSelect: !!q.multiSelect, optionCount,
      };
    });
    el.classList.add("busy");
    try {
      await api.chatAnswer({
        cwd: a._tui.cwd, tid: a._tui.win, expect: a._tui.expect, answers: wire,
        ...(a._tui.hostDeviceId != null ? { hostDeviceId: a._tui.hostDeviceId } : {}),   // 멀티 PC 라우팅
      });
      dismissedTui.add(a.id);          // 낙관적 회수 — 트랜스크립트에 답이 붙으면 어차피 사라진다
      el.remove();
      a._tui.onAnswered?.();
    } catch (e) {
      el.classList.remove("busy");
      const msg = String(e || "");
      flashErr(el, /QUESTION_NOT_ON_SCREEN/.test(msg) ? "터미널에 질문 다이얼로그가 떠 있지 않아요 — TUI 를 확인해 주세요"
        : /QUESTION_MISMATCH/.test(msg) ? "화면의 질문이 바뀌었어요 — 잠시 후 다시 시도해 주세요"
        : "답변을 전달하지 못했어요 — 다시 시도해 주세요");
    }
    return;
  }
  if (!answers.length) { await S.respondApproval(a.id, { decision: "deny", message: "원격 기기에서 건너뛰었습니다" }); return; }
  await S.respondApproval(a.id, { decision: "answer", answers });
}

// 선택지 행 1개 — 질문 카드(.apc-qopt)와 같은 시각 언어(번호 붙은 세로 행). 앱 도크와 동일 형태.
function optRowHtml(act, label, desc, num) {
  return `<button class="apc-qopt" type="button" data-act="${act}">` +
    `<span class="apc-qtext"><span class="apc-qlabel">${escapeHtml(label)}</span>` +
    (desc ? `<span class="apc-qdesc">${escapeHtml(desc)}</span>` : "") + `</span>` +
    `<span class="apc-qnum">${num}</span>` +
  `</button>`;
}

// 응답 UI — **TUI 프롬프트와 같은 번호 선택지**(2026-07-29 사용자 확정: 순서·형태 3플랫폼 동일).
//  · 권한형: 1 허용 / 2 허용하고 다음부터 묻지 않기(제안 있을 때만 — TUI 동일 조건) / 3 거절
//  · 계획 승인(ExitPlanMode): 1 계획대로 진행 / 2 거절 + 의견 입력(선택 — 고른 행에 실려 간다)
function buildActions(el, a) {
  const acts = el.querySelector(".apc-actions");
  acts.innerHTML = "";
  // 질문(선택지) 카드는 buildCard 가 renderQuestionStep 으로 따로 그린다 — 여기 오지 않는다.
  if (isChoice(a)) {
    // 선택지가 없는 선택형 = ExitPlanMode(계획 승인). 데몬 규약상
    //  allow → "계획을 승인했습니다. 계획대로 진행하세요." / deny(+message) → "거절했습니다: …"
    //  answer.text → "다음과 같이 답했습니다: …"(계획을 조금 고쳐 진행시키는 경로 — 의견이 있으면
    //  '계획대로 진행'이 이 경로를 탄다. 앱 모달과 같은 규칙).
    const wrap = document.createElement("div");
    wrap.className = "apc-choices";
    wrap.innerHTML =
      `<div class="apc-free">` +
        `<input class="apc-free-input" type="text" placeholder="의견 남기기(선택)…" />` +
      `</div>` +
      `<div class="apc-qopts">` +
        optRowHtml("planAllow", "계획대로 진행", "", 1) +
        optRowHtml("deny", "거절", "", 2) +
      `</div>`;
    acts.appendChild(wrap);
    return;
  }
  // 권한형 — 2번("다음부터 묻지 않기")은 **claude 가 그 요청에 대해 규칙을 제안했을 때만**
  //  (a.alwaysLabel 존재) 그린다 — TUI 도 정확히 같은 조건에서만 2번을 띄운다. codex 는 항상 없음.
  const rows = [
    { act: "allow", label: "허용", desc: "" },
    ...(a.alwaysLabel ? [{ act: "allowAlways", label: "허용하고 다음부터 묻지 않기", desc: a.alwaysLabel }] : []),
    { act: "deny", label: "거절", desc: "" },
  ];
  acts.innerHTML = `<div class="apc-qopts">${rows.map((r, i) => optRowHtml(r.act, r.label, r.desc, i + 1)).join("")}</div>`;
}

function syncCard(el, a) {
  if (a._tui) return;   // 합성 행 — busy/err 는 submit 경로가 el 에 직접 관리한다(매 emit 재생성 값에 덮이면 안 됨)
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
  if (act === "dismiss") {
    if (a._tui) { dismissedTui.add(a.id); el.remove(); return; }   // 합성 행 — 로컬로만 접는다
    S.dismissApproval(a.id);
    return;
  }
  if (a._busy) return;
  if (act === "allow") { await S.respondApproval(a.id, { decision: "allow" }); return; }
  // 규칙은 데몬이 보관한 claude 제안 그대로 적용된다 — 우리는 "그걸 원한다"는 플래그만 보낸다.
  if (act === "allowAlways") { await S.respondApproval(a.id, { decision: "allow", always: true }); return; }
  if (act === "deny") {
    // 계획 승인 카드의 의견 입력은 거절 사유로도 실려 간다(앱 모달과 같은 규칙).
    const text = isChoice(a) ? String(el.querySelector(".apc-free-input")?.value || "").trim() : "";
    await S.respondApproval(a.id, { decision: "deny", ...(text ? { message: text } : {}) });
    return;
  }
  // 계획 승인(1번 행) — 의견이 있으면 answer.text 로(계획을 조금 고쳐 진행), 없으면 순수 allow.
  if (act === "planAllow") {
    const text = String(el.querySelector(".apc-free-input")?.value || "").trim();
    if (text) await S.respondApproval(a.id, { decision: "answer", answers: [{ questionIndex: 0, labels: [], text }] });
    else await S.respondApproval(a.id, { decision: "allow" });
    return;
  }
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
  // (구 '전부 펼치기' 카드의 toggle/one/pick/pickMulti 핸들러와 별도 '의견 보내기' 버튼(answerText)은
  //  질문 카드 스테퍼·계획 승인 번호 행(의견이 행에 실려 감)으로 대체돼 삭제됐다.)
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
