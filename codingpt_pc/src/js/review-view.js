// 코드 리뷰 화면(PC) — IDE 안에서 덩어리마다 승인/거절하고 줄에 코멘트를 단다.
//
// 이 화면이 뜨는 조건: **에이전트가 스스로 요청했을 때만**이다(`cpt review`). 사용자가 부른 적
//  없는 화면이 뜨므로 맨 위에 "왜 떴는지"를 한 줄 적는다(사용자 확정: 강제 관문이 아니라 도구).
//
// 조작(사용자 확정 그대로): 하단 바에 [◀ 이전 파일][파일명 i/N][다음 파일 ▶] … [보내기].
//  파일을 넘기면 그 파일의 diff 에서 **승인이 필요한 곳**(덩어리)을 보여 주고, 각 덩어리에
//  승인/거절/코멘트를 단다. **되돌리기는 없다**(사용자 확정) — 코멘트만 모아서 한 번에 회송한다.
//
// 앱(codingpt_app/src/workspace/ide/ReviewView.tsx)이 이 화면의 미러다. 판정(덩어리 세기·파일
//  판정·제출 페이로드)은 diff-parse.js 를, 문구는 text/review.js 를 **양쪽이 공유**한다 —
//  두 기기가 덩어리를 다르게 세면 엉뚱한 곳을 승인한 결과가 에이전트에게 간다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { tx } from "./text/index.js";
import { REVIEW_TEXT } from "./text/review.js";
import * as D from "./diff-parse.js";
import * as i18n from './i18n/index.js';

const TX = () => tx(REVIEW_TEXT);

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * 리뷰 상태 — 화면이 들고 있는 유일한 상태. 제출 전까지 데몬은 아무것도 모른다
 *  (한 곳 누를 때마다 서버를 두드리면 느리고, 중간 상태가 에이전트에게 새어 나간다).
 */
export function createReview(payload, ws) {
  const files = (payload.files || []).map((f) => {
    const hunks = D.parseHunks(f.diffText);
    return { path: f.path, diffText: f.diffText, truncated: !!f.truncated, hunkList: hunks, hunks: hunks.length };
  });
  return {
    reviewId: payload.reviewId,
    title: payload.title || TX().title,
    ws: payload.ws || "",
    wsMeta: ws || null,
    files,
    index: 0,
    decisions: {},     // `${path}#${i}` → 'approve' | 'reject'
    comments: [],      // { path, hunk, side, line, text }
    note: "",
    sending: false,
    done: false,
  };
}

/** 이 리뷰의 전송 경로 — 이 PC 워크스페이스면 소켓 직결, 아니면 back 릴레이(데몬 구현은 한 벌). */
async function call(state, cmd, args, isLocal) {
  if (isLocal) return api.reviewLocal(cmd, args);
  const body = { ...args };
  if (state.wsMeta && state.wsMeta.hostDeviceId != null) body.hostDeviceId = state.wsMeta.hostDeviceId;
  if (cmd === "review.submit") return api.reviewSubmit(body);
  if (cmd === "review.cancel") return api.reviewCancel(body);
  if (cmd === "review.get") return api.reviewGet(body);
  throw new Error(i18n.t('알 수 없는 리뷰 명령: ') + cmd);
}

export async function submitReview(state, isLocal) {
  const payload = D.buildSubmission(state.files, state.decisions, state.comments, state.note);
  return call(state, "review.submit", { id: state.reviewId, ...payload }, isLocal);
}

export async function cancelReview(state, isLocal, reason) {
  return call(state, "review.cancel", { id: state.reviewId, reason: reason || "user" }, isLocal);
}

// ── 한 파일 그리기 ───────────────────────────────────────────────────────────

/**
 * `host` 에 지금 파일(state.index)의 덩어리들을 그린다. 상태가 바뀌면 `onChange()` 를 부른다
 *  (하단 바의 남은 개수·보내기 활성이 같이 갱신되어야 한다).
 */
export function renderReviewFile(host, state, onChange) {
  const T = TX();
  const f = state.files[state.index];
  host.innerHTML = "";
  host.className = "ide-review";
  if (!f) return;

  const why = document.createElement("div");
  why.className = "rv-why";
  why.textContent = T.why;
  host.appendChild(why);

  if (!f.hunkList.length) {
    const e = document.createElement("div");
    e.className = "rv-empty";
    e.textContent = T.empty;
    host.appendChild(e);
    return;
  }

  f.hunkList.forEach((h) => {
    const key = `${f.path}#${h.index}`;
    const box = document.createElement("div");
    box.className = "rv-hunk";

    const head = document.createElement("div");
    head.className = "rv-hunk-head";
    const decided = state.decisions[key];
    head.innerHTML =
      `<span class="rv-hunk-loc">${esc(h.header.replace(/^@@ | @@.*$/g, ""))}</span>`
      + `<span class="rv-hunk-stat">+${h.adds} −${h.dels}</span>`;
    const btns = document.createElement("span");
    btns.className = "rv-hunk-btns";
    const mk = (label, val) => {
      const b = document.createElement("button");
      // 켜짐은 **색이 아니라 채움**으로 표시한다(accent = 상태 신호 전용 규율).
      b.className = "rv-btn" + (decided === val ? " on" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        // 같은 것을 다시 누르면 해제 — 잘못 누른 뒤 되돌릴 길이 있어야 한다.
        if (state.decisions[key] === val) delete state.decisions[key];
        else state.decisions[key] = val;
        renderReviewFile(host, state, onChange);
        onChange?.();
      });
      return b;
    };
    btns.append(mk(T.approve, "approve"), mk(T.reject, "reject"));
    head.appendChild(btns);
    box.appendChild(head);

    const body = document.createElement("div");
    body.className = "rv-lines";
    h.lines.forEach((ln, li) => {
      const row = document.createElement("div");
      row.className = "rv-line rv-" + ln.type;
      const no = ln.type === "del" ? ln.oldNo : ln.newNo;
      row.innerHTML =
        `<span class="rv-no">${no == null ? "" : no}</span>`
        + `<span class="rv-sign">${ln.type === "add" ? "+" : ln.type === "del" ? "−" : " "}</span>`
        + `<span class="rv-text">${esc(ln.text) || "&nbsp;"}</span>`;
      if (D.isCommentable(ln)) {
        const add = document.createElement("button");
        add.className = "rv-line-comment";
        add.title = T.comment;
        add.innerHTML = icons.chat ? icons.chat({ size: 12 }) : "+";
        add.addEventListener("click", () => openCommentBox(row, state, f, h, ln, host, onChange));
        row.appendChild(add);
      }
      body.appendChild(row);
      // 이 줄에 이미 달린 코멘트
      const anchor = D.anchorOf(ln);
      if (anchor) {
        state.comments
          .filter((c) => c.path === f.path && c.hunk === h.index && c.side === anchor.side && c.line === anchor.line)
          .forEach((c) => body.appendChild(commentRow(c, state, host, onChange)));
      }
      void li;
    });
    box.appendChild(body);
    host.appendChild(box);
  });

  if (f.truncated) {
    const t = document.createElement("div");
    t.className = "rv-trunc";
    t.textContent = T.truncated;
    host.appendChild(t);
  }
}

function commentRow(c, state, host, onChange) {
  const T = TX();
  const row = document.createElement("div");
  row.className = "rv-comment";
  row.innerHTML = `<span class="rv-comment-text">${esc(c.text)}</span>`;
  const del = document.createElement("button");
  del.className = "rv-comment-x";
  del.title = T.removeComment;
  del.innerHTML = icons.x({ size: 11 });
  del.addEventListener("click", () => {
    state.comments = state.comments.filter((x) => x !== c);
    renderReviewFile(host, state, onChange);
    onChange?.();
  });
  row.appendChild(del);
  return row;
}

function openCommentBox(afterEl, state, file, hunk, line, host, onChange) {
  const T = TX();
  if (afterEl.nextElementSibling && afterEl.nextElementSibling.classList.contains("rv-cbox")) {
    afterEl.nextElementSibling.remove();
    return;
  }
  const box = document.createElement("div");
  box.className = "rv-cbox";
  const ta = document.createElement("textarea");
  ta.className = "rv-cbox-input";
  ta.placeholder = T.commentPlaceholder;
  ta.rows = 2;
  const row = document.createElement("div");
  row.className = "rv-cbox-btns";
  const save = document.createElement("button");
  save.className = "rv-btn on";
  save.textContent = T.commentSave;
  const cancel = document.createElement("button");
  cancel.className = "rv-btn";
  cancel.textContent = T.commentCancel;
  row.append(save, cancel);
  box.append(ta, row);
  afterEl.after(box);
  ta.focus();

  const commit = () => {
    const text = ta.value.trim();
    if (!text) { box.remove(); return; }
    const a = D.anchorOf(line);
    state.comments.push({ path: file.path, hunk: hunk.index, side: a.side, line: a.line, text });
    renderReviewFile(host, state, onChange);
    onChange?.();
  };
  save.addEventListener("click", commit);
  cancel.addEventListener("click", () => box.remove());
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); box.remove(); return; }
    // ⌘/Ctrl+Enter = 달기. 줄바꿈이 필요한 코멘트가 많아 Enter 단독은 쓰지 않는다.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
  });
}

// ── 하단 바 ──────────────────────────────────────────────────────────────────

/**
 * [◀ 이전 파일][파일명 i/N][다음 파일 ▶] … [남은 곳][코멘트 n개][보내기] (사용자 확정 배치).
 *  `cbs` = { onNav(delta), onSubmit(), onCancel(), onApproveFile(), onApproveAll() }
 */
export function renderReviewBar(bar, state, cbs) {
  const T = TX();
  const f = state.files[state.index];
  const left = D.undecidedCount(state.files, state.decisions);
  const ready = D.allDecided(state.files, state.decisions);
  bar.innerHTML = "";
  bar.className = "ide-review-bar";

  const nav = document.createElement("div");
  nav.className = "rvb-nav";
  const prev = document.createElement("button");
  prev.className = "rvb-btn";
  prev.title = T.prev;
  prev.innerHTML = icons.chevronLeft ? icons.chevronLeft({ size: 14 }) : "◀";
  prev.disabled = state.index <= 0;
  prev.addEventListener("click", () => cbs.onNav(-1));
  const nameEl = document.createElement("span");
  nameEl.className = "rvb-name";
  nameEl.title = f ? f.path : "";
  nameEl.textContent = `${f ? f.path.split("/").pop() : ""} ${state.index + 1}/${state.files.length}`;
  const next = document.createElement("button");
  next.className = "rvb-btn";
  next.title = T.next;
  next.innerHTML = icons.chevronRight ? icons.chevronRight({ size: 14 }) : "▶";
  next.disabled = state.index >= state.files.length - 1;
  next.addEventListener("click", () => cbs.onNav(1));
  nav.append(prev, nameEl, next);

  const mid = document.createElement("div");
  mid.className = "rvb-mid";
  const approveFile = document.createElement("button");
  approveFile.className = "rvb-btn wide";
  approveFile.textContent = T.approveAll;
  approveFile.addEventListener("click", () => cbs.onApproveFile());
  const approveEvery = document.createElement("button");
  approveEvery.className = "rvb-btn wide";
  approveEvery.textContent = T.approveEverything;
  approveEvery.addEventListener("click", () => cbs.onApproveAll());
  mid.append(approveFile, approveEvery);

  const right = document.createElement("div");
  right.className = "rvb-right";
  const status = document.createElement("span");
  status.className = "rvb-status";
  // 실패는 **감추지 않는다** — 못 보냈는데 화면이 조용하면 사용자는 보낸 줄 안다.
  status.textContent = state.error
    ? `${T.sendFailed} — ${state.error}`
    : `${ready ? T.allDecided : T.remaining(left)} · ${T.commentCount(state.comments.length)}`;
  if (state.error) status.classList.add("err");
  const cancel = document.createElement("button");
  cancel.className = "rvb-btn";
  cancel.textContent = T.cancel;
  cancel.addEventListener("click", () => cbs.onCancel());
  const send = document.createElement("button");
  send.className = "rvb-btn primary";
  send.textContent = state.sending ? T.sending : T.send;
  // 안 정한 곳이 있어도 **보낼 수 있다** — 사용자가 일부만 보고 나머지는 에이전트에게 맡길 수
  //  있어야 한다. 대신 남은 개수를 옆에 계속 보여 준다(모르고 보내지 않게).
  send.disabled = !!state.sending;
  send.addEventListener("click", () => cbs.onSubmit());
  right.append(status, cancel, send);

  bar.append(nav, mid, right);
  void ready;
}
