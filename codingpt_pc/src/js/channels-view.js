// channels-view.js — 알림 채널 장소(state.view === "channels"). 폰 앱 ChannelsHost.tsx 와 같은 것.
//  다른 서비스(서버·배치·CI)가 웹훅으로 보낸 알림이 채널(대화방)에 쌓이고, 그 방에서 바로 PC 의 에이전트에게 일을 시킨다.
//  정본 = back /api/channels(PC 는 /api/daemon/channels — back_api 는 /api/daemon 아래만 연다). 실시간 = channel_event(ui-channel.js).
//  색 규율: 심각도 색은 상태 신호라 쓴다(빨강=오류·주황=경고·초록=해결). 그 밖의 강조는 무채색 명암으로만.
import { state } from "./state.js";
import * as S from "./state.js";
import { api } from "./api.js";
import { icons } from "./icons.js";
import * as i18n from "./i18n/index.js";
import { renderMarkdown } from "./chat-md.js";
const toast = (msg) => { import("./workspace-view.js").then((m) => m.wvToast(msg)).catch(() => {}); };
/** sidebar.confirmDialog(콜백형) → Promise. 눌렀을 때만 진행한다(취소는 영영 기다린다 — 다음 동작이 없다).
 *  sidebar.js 는 이 모듈을 import 하므로 여기서는 쓸 때 불러온다(정적 import 면 순환으로 vm-view 가 초기화 전 state 를 만진다). */
const confirmDialog = ({ title, message, confirmLabel }) => import("./sidebar.js").then((m) => new Promise((ok) => m.confirmDialog({ title, lines: [message], confirmLabel, onConfirm: () => ok(true) })));

const t = (s, v) => i18n.t(s, v);
const BASE = "/api/daemon/channels";
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LEVEL_TEXT = { info: "정보", success: "해결", warning: "경고", error: "오류", critical: "긴급" };
const MODE_OPTS = [["default", "매번 승인"], ["acceptEdits", "수정은 자동"], ["plan", "계획만"]];
const ERR_TEXT = {
  DAEMON_OFFLINE: "PC 가 꺼져 있거나 CodingPT 가 연결되어 있지 않아요", NO_WORKSPACE: "AI 가 일할 PC·폴더를 먼저 정하세요",
  AGENT_NOT_LOGGED_IN: "PC 의 에이전트에 로그인돼 있지 않아요", TIMEOUT: "PC 응답이 늦어요. 잠시 뒤 확인하세요",
  REQ_NOT_PENDING: "이미 처리된 요청이에요", EXTERNAL_DISABLED: "이 PC 는 외부 연동을 꺼 두었어요",
};
function codeOf(e) { const m = /HTTP \d+ ([A-Z_]+)/.exec(String((e && e.message) || e || "")); return m ? m[1] : ""; }
const errText = (e) => t(ERR_TEXT[codeOf(e)] || "문제가 생겼어요. 다시 시도해 주세요");
const call = (method, path, body, secs) => api.backApiAsync(method, BASE + path, body, secs || 20);

// ── 상태 ──
const st = { channels: [], loaded: false, selected: null, messages: new Map(), hasMore: new Map(), activity: new Map(), refs: [], draft: "" };
let el = null;
let modal = null;
const sel = () => st.channels.find((c) => c.id === st.selected) || null;

function levelColor(l) {
  if (l === "critical" || l === "error") return "var(--error)";
  if (l === "warning") return "var(--warn)";
  if (l === "success") return "var(--success)";
  return null;
}
function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  const hh = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hh : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
}
function docsUrlOf(u) { const m = /^(https?:\/\/[^/]+)/.exec(u || ""); return `${m ? m[1] : "https://codingpt-back.ghmate.com"}/api/v1/docs/channels`; }
/** 다른 프로젝트의 에이전트에게 붙여 넣을 안내문(폰 앱 agentGuideText 와 같은 글). */
function agentGuideText(ch) {
  return [
    `이 프로젝트에 문제가 생기면(서버 오류·크래시·배치 실패·헬스체크 실패 등) 내 CodingPT 앱의 「${ch.name}」 채널로 알림이 오게 해 줘.`,
    `- 방법 문서(먼저 읽어): ${docsUrlOf(ch.webhookUrl)}`,
    `- 웹훅 URL: ${ch.webhookUrl}`,
    "  이 URL 은 비밀값이야. 서버 환경변수 CODINGPT_WEBHOOK_URL 에만 넣고 코드·커밋·로그에 남기지 마.",
    "문서의 규칙(실패는 무시·타임아웃 3초·dedupeKey 로 반복 묶기·비밀값/개인정보 제외)대로 붙이고, 테스트 알림 한 건을 보내 확인한 뒤 어떤 상황에 무엇을 보내게 했는지 표로 알려 줘.",
  ].join("\n");
}

// ── 데이터 ──
function upsert(ch) {
  if (!ch) return;
  const c = state.view === "channels" && st.selected === ch.id ? { ...ch, unreadCount: 0 } : ch;
  const i = st.channels.findIndex((x) => x.id === ch.id);
  if (i >= 0) st.channels[i] = c; else st.channels.unshift(c);
  st.channels.sort((a, b) => (Date.parse(b.lastMessageAt || b.createdAt) || 0) - (Date.parse(a.lastMessageAt || a.createdAt) || 0));
}
export async function refreshChannels() {
  try { const r = await call("GET", ""); st.channels = r.channels || []; } catch (_) { /* 다음에 */ }
  st.loaded = true;
  S.emit();
}
async function loadMessages(id) {
  try {
    const r = await call("GET", `/${id}/messages?limit=80`);
    st.messages.set(id, r.messages || []);
    st.hasMore.set(id, !!r.hasMore);
    upsert(r.channel);
    if (r.channel && r.channel.agentState && !st.activity.has(id)) st.activity.set(id, { state: r.channel.agentState, text: null });
    if (r.channel && r.channel.unreadCount) call("POST", `/${id}/read`).catch(() => {});
    draw(true);
    S.emit();
  } catch (e) { toast(errText(e)); }
}
function putMessage(m) {
  const list = st.messages.get(m.channelId);
  if (!list) return;
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) list[i] = m; else { list.push(m); list.sort((a, b) => a.id - b.id); }
}
/** 사이드바 배지 — 끄지 않은 채널의 미읽음 합. */
export function channelsUnread() { return st.channels.reduce((n, c) => n + (c.muted ? 0 : c.unreadCount || 0), 0); }

/** ui-channel.js 의 channel_event. */
export function applyChannelEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.kind === "message" && ev.message) {
    putMessage(ev.message);
    if (ev.channel) upsert(ev.channel);
    if (state.view === "channels" && st.selected === ev.channelId && ev.channel && ev.channel.unreadCount) call("POST", `/${ev.channelId}/read`).catch(() => {});
    if (ev.message.role === "agent") st.activity.set(ev.channelId, { state: (st.activity.get(ev.channelId) || {}).state || null, text: null });
  } else if (ev.kind === "channel" && ev.channel) upsert(ev.channel);
  else if (ev.kind === "channel_removed") {
    st.channels = st.channels.filter((c) => c.id !== Number(ev.channelId));
    if (st.selected === Number(ev.channelId)) st.selected = null;
  } else if (ev.kind === "agent" && ev.channelId != null) {
    st.activity.set(ev.channelId, { state: ev.state || null, text: ev.activity || null });
    const c = st.channels.find((x) => x.id === ev.channelId);
    if (c) c.agentState = ev.state || null;
  }
  if (state.view === "channels") draw(ev.kind === "message" && ev.channelId === st.selected);
  S.emit();
}

// ── 열고 닫기 ──
export function openChannels(channelId) {
  S.setView("channels");
  if (channelId != null) selectChannel(Number(channelId));
  void refreshChannels();
  setTimeout(() => el?.focus?.(), 30);
}
export function closeChannels() { S.setView("workspace"); }
function selectChannel(id) {
  st.selected = id;
  st.refs = []; st.draft = "";
  draw();
  if (id != null) void loadMessages(id);
}

// ── 그리기 ──
export function mountChannelsView(container) {
  el = container;
  el.className = "channels-view tasks-view";
  el.tabIndex = 0;
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal) { if (st.selected != null && el.classList.contains("ch-narrow")) selectChannel(null); else closeChannels(); }
    if (e.target.classList?.contains("ch-input") && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
  el.addEventListener("input", (e) => {
    if (e.target.classList?.contains("ch-input")) {
      st.draft = e.target.value;
      e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
      el.querySelector(".ch-send")?.classList.toggle("on", !!st.draft.trim());
    }
  });
  void refreshChannels();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshChannels(); });
}

export function updateChannelsView() {
  if (!el) return;
  const on = state.view === "channels";
  el.hidden = !on;
  if (!on) { closeModal(); return; }
  draw();
}

let lastSig = "";
function draw(scrollEnd) {
  if (!el || el.hidden) return;
  const narrow = el.clientWidth && el.clientWidth < 760;
  el.classList.toggle("ch-narrow", !!narrow);
  const ch = sel();
  const msgs = ch ? st.messages.get(ch.id) : null;
  const act = ch ? st.activity.get(ch.id) : null;
  const sig = JSON.stringify([st.channels, st.selected, msgs, act, narrow, st.refs, i18n.getLang(), state.sidebarCollapsed]);
  if (sig === lastSig && !scrollEnd) return;
  lastSig = sig;
  const body = el.querySelector(".ch-msgs");
  const atBottom = !body || body.scrollTop + body.clientHeight >= body.scrollHeight - 80;
  const focused = document.activeElement && document.activeElement.classList.contains("ch-input");
  const top = `<div class="tv-top">` +
    (narrow && ch ? `<button class="tv-back" data-act="back">${icons.chevronLeft({ size: 13 })}${esc(t("목록"))}</button>` : "") +
    `<span class="tv-title">${esc(t("알림 채널"))}</span><span class="is-grow"></span>` +
    `<button class="ic-btn tv-ic" data-act="new" title="${esc(t("새 채널"))}">${icons.plus({ size: 15 })}</button></div>`;
  const list = (!narrow || !ch) ? `<div class="ch-list">${listHtml()}</div>` : "";
  const room = ch ? roomHtml(ch, msgs, act) : (narrow ? "" : `<div class="ch-room ch-empty-room">${esc(t("왼쪽에서 채널을 고르세요"))}</div>`);
  el.innerHTML = top + `<div class="ch-body">${list}${room}</div>`;
  const input = el.querySelector(".ch-input");
  if (input) { input.value = st.draft; if (focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }
  const nb = el.querySelector(".ch-msgs");
  if (nb && (atBottom || scrollEnd)) nb.scrollTop = nb.scrollHeight;
}

function listHtml() {
  if (st.loaded && !st.channels.length) {
    return `<div class="ch-intro"><div class="ch-intro-ic">${icons.bell({ size: 28 })}</div>` +
      `<div class="ch-intro-title">${esc(t("서비스 알림을 여기로 받으세요"))}</div>` +
      `<div class="ch-intro-sub">${esc(t("채널을 만들면 웹훅 URL 이 생겨요. 서버 오류·배포 실패 같은 알림을 그 URL 로 보내면 폰으로 오고, 같은 방에서 바로 AI 에게 고치라고 시킬 수 있어요."))}</div>` +
      `<button class="btn primary" data-act="new">${esc(t("채널 만들기"))}</button></div>`;
  }
  return st.channels.map((c) => {
    const dot = levelColor(c.lastLevel);
    const a = st.activity.get(c.id);
    const ast = a ? a.state : c.agentState;
    const working = ast === "working" || ast === "waiting";
    return `<button class="ch-row${c.id === st.selected ? " active" : ""}" data-ch="${c.id}">` +
      `<span class="ch-av">${icons.bell({ size: 14 })}${dot && c.unreadCount ? `<i style="background:${dot}"></i>` : ""}</span>` +
      `<span class="ch-row-main"><span class="ch-row-top"><b class="${c.unreadCount ? "unread" : ""}">${esc(c.name)}</b>${c.muted ? `<span class="ch-muted">${esc(t("무음"))}</span>` : ""}<span class="is-grow"></span><span class="ch-time">${esc(clock(c.lastMessageAt || c.createdAt))}</span></span>` +
      `<span class="ch-row-sub"><span class="ch-prev">${esc(working ? t("AI 가 작업 중이에요") : (c.lastPreview || t("아직 알림이 없어요")))}</span>${c.unreadCount ? `<span class="wsr-badge">${c.unreadCount > 99 ? "99+" : c.unreadCount}</span>` : ""}</span></span></button>`;
  }).join("");
}

function roomHtml(ch, msgs, act) {
  //  AI 상태는 agent 이벤트(act)가 정본 — 채널 사본의 agentState 는 읽음 처리 응답 등에 실려 늦게 도착할 수 있다(옛 값으로 덮지 않게).
  const ast = act ? act.state : ch.agentState;
  const working = ast === "working";
  const waiting = ast === "waiting";
  const head = `<div class="ch-head"><div class="ch-head-main"><b>${esc(ch.name)}</b>` +
    `<span>${esc(ch.cwd ? `${t("AI 작업 폴더")} · ${ch.cwd.split("/").pop()}` : t("AI 작업 폴더 없음"))}${ch.muted ? ` · ${esc(t("무음"))}` : ""}</span></div>` +
    `<button class="btn" data-act="connect">${icons.link({ size: 13 })}<span>${esc(t("연동"))}</span></button>` +
    `<button class="ic-btn" data-act="settings" title="${esc(t("채널 설정"))}">${icons.dots({ size: 15 })}</button></div>`;
  const rows = !msgs ? `<div class="ch-loading">${esc(t("불러오는 중…"))}</div>` : msgs.map((m) => msgHtml(ch, m)).join("");
  const bar = working || waiting ? `<div class="ch-agentbar"><span class="ch-pulse"></span><span class="ch-agentbar-t">${esc(waiting ? t("AI 가 답을 기다려요") : (act && act.text ? `${t("AI 작업 중")} · ${act.text}` : t("AI 작업 중")))}</span>` +
    (ch.threadId ? `<button class="btn ghost small" data-act="thread">${esc(t("대화 열기"))}</button>` : "") +
    (working ? `<button class="btn ghost small" data-act="interrupt">${esc(t("중단"))}</button>` : "") + `</div>` : "";
  const setup = !ch.deviceId || !ch.cwd ? `<button class="ch-setup" data-act="settings">${icons.monitor({ size: 14 })}<span>${esc(t("AI 에게 맡기려면 일할 PC·폴더를 정하세요"))}</span><b>${esc(t("정하기"))}</b></button>` : "";
  const refMsgs = (msgs || []).filter((m) => st.refs.includes(m.id));
  const chips = refMsgs.length ? `<div class="ch-chips">${refMsgs.map((m) => `<span class="ch-chip">${levelColor(m.level) ? `<i style="background:${levelColor(m.level)}"></i>` : ""}<span>${esc(m.title || m.body || t("알림"))}</span><button data-act="unref" data-id="${m.id}">${icons.x({ size: 10 })}</button></span>`).join("")}</div>` : "";
  const composer = `<div class="ch-composer">${setup}${chips}<div class="ch-box"><textarea class="ch-input" rows="1" placeholder="${esc(ch.cwd ? t("AI 에게 지시하기") : t("먼저 일할 PC·폴더를 정하세요"))}"></textarea>` +
    `<button class="ch-send${st.draft.trim() ? " on" : ""}" data-act="send" title="${esc(t("보내기"))}">${icons.arrowUp({ size: 14 })}</button></div></div>`;
  return `<div class="ch-room">${head}<div class="ch-msgs">${st.hasMore.get(ch.id) ? `<button class="btn ghost small ch-older" data-act="older">${esc(t("이전 알림 더 보기"))}</button>` : ""}${rows}</div>${bar}${composer}</div>`;
}

function msgHtml(ch, m) {
  if (m.role === "event") {
    const col = levelColor(m.level);
    const picked = st.refs.includes(m.id);
    const mono = /\n\s+at |Error|Exception|Traceback/.test(m.body || "");
    return `<div class="ch-ev${picked ? " picked" : ""}${col ? "" : " lv-none"}"${col ? ` style="--lv:${col}"` : ""}>` +
      `<div class="ch-ev-top"><span class="ch-lv">${esc(t(LEVEL_TEXT[m.level || "info"] || "정보"))}</span>${m.source ? `<span class="ch-src">· ${esc(m.source)}</span>` : ""}<span class="is-grow"></span>` +
      `${m.repeatCount > 1 ? `<span class="ch-rep">×${m.repeatCount}</span>` : ""}<span class="ch-time">${esc(clock(m.updatedAt || m.createdAt))}</span></div>` +
      (m.title ? `<div class="ch-ev-title">${esc(m.title)}</div>` : "") +
      (m.body ? `<pre class="ch-ev-body${mono ? " mono" : ""}">${esc(m.body)}</pre>` : "") +
      ((m.fields || []).length ? `<div class="ch-fields">${m.fields.map((f) => `<span><em>${esc(f.label)}</em> ${esc(f.value)}</span>`).join("")}</div>` : "") +
      `<div class="ch-ev-acts"><button class="btn small" data-act="ask" data-id="${m.id}">${picked ? icons.check({ size: 12 }) : icons.zap({ size: 12 })}<span>${esc(picked ? t("지시에 붙임") : t("AI 에게 맡기기"))}</span></button>` +
      (m.url ? `<button class="btn ghost small" data-act="url" data-url="${esc(m.url)}">${icons.external({ size: 12 })}<span>${esc(t("링크"))}</span></button>` : "") + `</div></div>`;
  }
  if (m.role === "user") {
    const n = (m.meta && m.meta.refs && m.meta.refs.length) || 0;
    return `<div class="ch-user"><div class="ch-bubble">${esc(m.body || "")}</div><div class="ch-meta">${n ? esc(t("알림 {n}개와 함께", { n })) + " · " : ""}${esc(clock(m.createdAt))}</div></div>`;
  }
  if (m.role === "agent") {
    const tools = (m.meta && m.meta.tools) || 0;
    return `<div class="ch-agent"><div class="ch-agent-h">${icons.claudeMark ? icons.claudeMark({ size: 12 }) : ""}<b>${m.meta && m.meta.agent === "codex" ? "Codex" : "Claude"}</b><span>${tools ? esc(t("도구 {n}번", { n: tools })) + " · " : ""}${esc(clock(m.createdAt))}</span></div>` +
      `<div class="ch-agent-body chat-md">${renderMarkdown(m.body || "")}</div>` +
      (ch.threadId && ch.threadId === m.threadId ? `<button class="btn ghost small" data-act="thread">${icons.chat({ size: 12 })}<span>${esc(t("전체 대화 보기"))}</span></button>` : "") + `</div>`;
  }
  const req = m.meta && m.meta.event === "request" ? m.meta.request : null;
  if (req) {
    const pending = req.status === "pending";
    const q = req.kind === "question" && req.questions && req.questions.length === 1 ? req.questions[0] : null;
    const doneText = { allowed: "허용함", denied: "거절함", answered: "답함", expired: "만료됨" }[req.status] || "처리됨";
    let acts = "";
    if (pending) {
      if (q && q.options && q.options.length) acts = q.options.slice(0, 4).map((o) => `<button class="btn small" data-act="answer" data-id="${m.id}" data-label="${esc(o.label)}">${esc(o.label)}</button>`).join("");
      else if (req.kind === "question") acts = `<button class="btn small" data-act="thread">${esc(t("대화에서 답하기"))}</button>`;
      else acts = `<button class="btn primary small" data-act="allow" data-id="${m.id}">${esc(t("허용"))}</button><button class="btn small" data-act="deny" data-id="${m.id}">${esc(t("거절"))}</button><button class="btn ghost small" data-act="thread">${esc(t("자세히"))}</button>`;
    }
    return `<div class="ch-req${pending ? " pending" : ""}"><div class="ch-req-top"><i></i><b>${esc(t(m.title || "AI 가 승인을 기다려요"))}</b><span class="is-grow"></span><span class="ch-time">${esc(pending ? clock(m.createdAt) : t(doneText))}</span></div>` +
      (req.tool ? `<div class="ch-req-tool">${esc(req.tool)}</div>` : "") +
      (req.summary ? `<pre class="ch-req-sum">${esc(req.summary)}</pre>` : "") + (q ? `<div class="ch-req-q">${esc(q.question)}</div>` : "") +
      (acts ? `<div class="ch-req-acts">${acts}</div>` : "") + `</div>`;
  }
  return `<div class="ch-sys${m.level === "error" ? " err" : ""}">${esc(m.body ? t(m.body) : "")} · ${esc(clock(m.createdAt))}</div>`;
}

// ── 동작 ──
async function send() {
  const ch = sel();
  const text = st.draft.trim();
  if (!ch || !text) return;
  if (!ch.deviceId || !ch.cwd) { openSettings(ch); return; }
  const keep = { draft: st.draft, refs: st.refs.slice() };
  st.draft = ""; st.refs = [];
  draw(true);
  try {
    const r = await call("POST", `/${ch.id}/messages`, { text, refs: keep.refs.length ? keep.refs : undefined }, 75);
    if (r.message) putMessage(r.message);
    if (r.channel) upsert(r.channel);
    draw(true);
  } catch (e) {
    st.draft = keep.draft; st.refs = keep.refs;
    toast(errText(e));
    void loadMessages(ch.id);
  }
}
function openThread() {
  const ch = sel();
  if (!ch || !ch.threadId) return;
  const w = state.workspaces.find((x) => String(x.hostDeviceId) === String(ch.deviceId) && x.localPath === ch.cwd) || state.workspaces.find((x) => x.localPath === ch.cwd);
  if (!w) { toast(t("이 폴더가 워크스페이스에 없어요")); return; }
  S.setActive(w.id, { allowTask: true });
  S.setView("workspace");
  requestAnimationFrame(() => { import("./workspace-view.js").then((m) => m.openConvTab(String(ch.threadId), ch.name)).catch(() => {}); });
}
async function respond(msgId, decision, answers) {
  const ch = sel();
  const m = ch && (st.messages.get(ch.id) || []).find((x) => x.id === Number(msgId));
  const req = m && m.meta && m.meta.request;
  if (!req) return;
  try {
    await call("POST", `/${ch.id}/requests/${encodeURIComponent(req.id)}`, answers ? { decision: "answer", answers } : { decision }, 20);
    m.meta = { ...m.meta, request: { ...req, status: answers ? "answered" : (decision === "allow" ? "allowed" : "denied") } };
    draw();
  } catch (e) { toast(errText(e)); }
}
async function loadOlder() {
  const ch = sel();
  const cur = ch && st.messages.get(ch.id);
  if (!cur || !cur.length) return;
  try {
    const r = await call("GET", `/${ch.id}/messages?before=${cur[0].id}&limit=80`);
    st.messages.set(ch.id, [...(r.messages || []), ...cur]);
    st.hasMore.set(ch.id, !!r.hasMore);
    draw();
  } catch (e) { toast(errText(e)); }
}

function onClick(e) {
  const row = e.target.closest(".ch-row");
  if (row) { selectChannel(Number(row.dataset.ch)); return; }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const ch = sel();
  switch (b.dataset.act) {
    case "new": openSettings(null); break;
    case "back": selectChannel(null); break;
    case "settings": if (ch) openSettings(ch); break;
    case "connect": if (ch) openConnect(ch); break;
    case "send": void send(); break;
    case "thread": openThread(); break;
    case "older": void loadOlder(); break;
    case "interrupt": if (ch) call("POST", `/${ch.id}/interrupt`).catch((err) => toast(errText(err))); break;
    case "url": import("./api.js").then((m) => m.api.openExternal ? m.api.openExternal(b.dataset.url) : window.open(b.dataset.url, "_blank")).catch(() => {}); break;
    case "unref": st.refs = st.refs.filter((x) => x !== Number(b.dataset.id)); draw(); break;
    case "ask": {
      const id = Number(b.dataset.id);
      if (!st.refs.includes(id)) st.refs = [...st.refs, id].slice(-5);
      if (!st.draft.trim()) st.draft = t("이 알림 원인을 찾아서 고쳐 줘");
      draw();
      const input = el.querySelector(".ch-input");
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      el.querySelector(".ch-send")?.classList.toggle("on", !!st.draft.trim());
      break;
    }
    case "allow": void respond(b.dataset.id, "allow"); break;
    case "deny": void respond(b.dataset.id, "deny"); break;
    case "answer": {
      const m = ch && (st.messages.get(ch.id) || []).find((x) => x.id === Number(b.dataset.id));
      const q = m && m.meta && m.meta.request && m.meta.request.questions && m.meta.request.questions[0];
      if (q) void respond(b.dataset.id, "answer", { [q.question]: b.dataset.label });
      break;
    }
    default: break;
  }
}

// ── 모달(설정·연동) ──
function closeModal() { if (modal) { modal.remove(); modal = null; } }
function modalShell(title, inner) {
  closeModal();
  modal = document.createElement("div");
  modal.className = "ch-modal-bd";
  modal.innerHTML = `<div class="ch-modal" role="dialog"><div class="ch-modal-h"><b>${esc(title)}</b><button class="ic-btn" data-x>${icons.x({ size: 13 })}</button></div><div class="ch-modal-b">${inner}</div></div>`;
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(); });
  modal.querySelector("[data-x]").addEventListener("click", closeModal);
  modal.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeModal(); el?.focus?.(); } });
  document.body.appendChild(modal);
  return modal;
}

function openSettings(ch) {
  const pcs = S.pcDevices().filter((d) => d.runnerKind !== "cloud");
  let deviceId = ch ? ch.deviceId : (pcs.length ? Number(S.activeDeviceId() || pcs[0].id) : null);
  const foldersOf = (dev) => (dev ? S.workspacesForDevice(dev) : []).filter((w) => w.localPath && !/\/\.codingpt\//.test(w.localPath))
    .map((w) => ({ cwd: w.localPath, name: S.wsDisplayName(w) })).filter((x, i, a) => a.findIndex((y) => y.cwd === x.cwd) === i);
  const opt = (v, n, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}>${esc(n)}</option>`;
  const folderSel = (dev, cur) => {
    const f = foldersOf(dev);
    if (!f.length) return `<div class="ch-hint">${esc(t("이 PC 에 워크스페이스가 없어요. 사이드바에서 먼저 추가하세요"))}</div>`;
    return `<select class="tk-input" name="cwd">${f.map((x) => opt(x.cwd, `${x.name} — ${x.cwd}`, cur || f[0].cwd)).join("")}</select>`;
  };
  const m = modalShell(ch ? t("채널 설정") : t("새 알림 채널"),
    `<label class="ch-lbl">${esc(t("이름"))}</label><input class="tk-input" name="name" maxlength="60" placeholder="${esc(t("예: 쇼핑몰 서버"))}" value="${esc(ch ? ch.name : "")}">` +
    `<label class="ch-lbl">${esc(t("AI 가 일할 PC"))}</label><select class="tk-input" name="device">${opt("", t("정하지 않음(알림만 받기)"), deviceId == null ? "" : deviceId)}${pcs.map((d) => opt(d.id, `${d.name}${d.online ? "" : ` (${t("꺼져 있음")})`}`, deviceId)).join("")}</select>` +
    `<div class="ch-dev-only"><label class="ch-lbl">${esc(t("프로젝트 폴더"))}</label><div class="ch-folder">${folderSel(deviceId, ch && ch.cwd)}</div>` +
    `<label class="ch-lbl">${esc(t("AI 권한"))}</label><select class="tk-input" name="mode">${MODE_OPTS.map(([v, n]) => opt(v, t(n), (ch && ch.agentMode) || "default")).join("")}</select>` +
    `<label class="ch-check"><input type="checkbox" name="worktree"${ch && ch.useWorktree ? " checked" : ""}><span>${esc(t("새 브랜치에서 작업"))}<em>${esc(t("지금 작업 중인 폴더를 건드리지 않아요(git 저장소만)"))}</em></span></label></div>` +
    `<label class="ch-check"><input type="checkbox" name="muted"${ch && ch.muted ? " checked" : ""}><span>${esc(t("푸시 끄기"))}<em>${esc(t("알림은 쌓이고 폰은 울리지 않아요"))}</em></span></label>` +
    `<div class="ch-modal-f">${ch ? `<button class="btn ghost danger" data-del>${esc(t("채널 지우기"))}</button>` : ""}<span class="is-grow"></span><button class="btn primary" data-save>${esc(ch ? t("저장") : t("만들기"))}</button></div>`);
  const devOnly = m.querySelector(".ch-dev-only");
  devOnly.hidden = deviceId == null;
  m.querySelector("[name=device]").addEventListener("change", (e) => {
    deviceId = e.target.value ? Number(e.target.value) : null;
    devOnly.hidden = deviceId == null;
    m.querySelector(".ch-folder").innerHTML = folderSel(deviceId, null);
  });
  setTimeout(() => m.querySelector("[name=name]").focus(), 20);
  m.querySelector("[data-save]").addEventListener("click", async (ev) => {
    const name = m.querySelector("[name=name]").value.trim();
    if (!name) { m.querySelector("[name=name]").focus(); return; }
    const cwdEl = m.querySelector("[name=cwd]");
    const body = {
      name, deviceId, cwd: deviceId && cwdEl ? cwdEl.value : null,
      agentMode: m.querySelector("[name=mode]").value, useWorktree: m.querySelector("[name=worktree]").checked, muted: m.querySelector("[name=muted]").checked,
    };
    ev.target.disabled = true;
    try {
      const r = ch ? await call("PATCH", `/${ch.id}`, body) : await call("POST", "", body);
      upsert(r.channel);
      closeModal();
      if (!ch) { selectChannel(r.channel.id); openConnect(r.channel); } else { toast(t("저장했어요")); draw(); }
    } catch (e) { ev.target.disabled = false; toast(errText(e)); }
  });
  m.querySelector("[data-del]")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: t("이 채널을 지울까요?"), message: t("웹훅 URL 도 더 이상 받지 않아요. 지난 알림도 함께 지워져요."), confirmLabel: t("지우기") });
    if (!ok) return;
    try {
      await call("DELETE", `/${ch.id}`);
      st.channels = st.channels.filter((c) => c.id !== ch.id);
      st.selected = null; closeModal(); draw(); S.emit();
    } catch (e) { toast(errText(e)); }
  });
}

function openConnect(ch) {
  const curl = `curl -X POST "${ch.webhookUrl}" -H 'Content-Type: application/json' -d '{"title":"테스트","text":"CodingPT 알림 연결 확인","level":"info"}'`;
  const block = (title, sub, value, key, mono) => `<div class="ch-cblock"><b>${esc(title)}</b><em>${esc(sub)}</em>` +
    `<button class="ch-copy${mono ? " mono" : ""}" data-copy="${key}"><span>${esc(value)}</span>${icons.copy({ size: 13 })}</button></div>`;
  const m = modalShell(t("서비스 연동"),
    `<p class="ch-p">${esc(t("이 URL 로 POST 하면 이 채널에 알림이 와요. 무엇을 언제 보낼지는 서비스 쪽에서 정해요."))}</p>` +
    block(t("에이전트에게 맡기기(추천)"), t("그 프로젝트를 작업하는 AI 에게 이 안내를 붙여 넣으면 문서를 읽고 알아서 연결해요"), agentGuideText(ch), "guide", false) +
    block(t("웹훅 URL"), t("비밀값이에요. 서버 환경변수(CODINGPT_WEBHOOK_URL)에만 넣으세요"), ch.webhookUrl, "url", true) +
    block(t("바로 보내 보기(curl)"), t("터미널에 붙여 넣으면 테스트 알림이 와요"), curl, "curl", true) +
    `<div class="ch-modal-f"><button class="btn ghost" data-rotate>${esc(t("URL 새로 만들기"))}</button><span class="is-grow"></span>` +
    `<button class="btn ghost" data-docs>${esc(t("문서"))}</button><button class="btn primary" data-test>${esc(t("테스트 알림 보내기"))}</button></div>`);
  const vals = { guide: agentGuideText(ch), url: ch.webhookUrl, curl };
  const msgs = { guide: t("안내문을 복사했어요"), url: t("URL 을 복사했어요"), curl: t("명령을 복사했어요") };
  m.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(vals[b.dataset.copy]); toast(msgs[b.dataset.copy]); } catch (_) { toast(t("복사하지 못했어요")); }
  }));
  m.querySelector("[data-test]").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try { await call("POST", `/${ch.id}/test`); toast(t("테스트 알림을 보냈어요")); } catch (e) { toast(errText(e)); } finally { ev.target.disabled = false; }
  });
  m.querySelector("[data-docs]").addEventListener("click", () => { try { api.openExternal ? api.openExternal(docsUrlOf(ch.webhookUrl)) : window.open(docsUrlOf(ch.webhookUrl), "_blank"); } catch (_) { /* noop */ } });
  m.querySelector("[data-rotate]").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: t("웹훅 URL 을 새로 만들까요?"), message: t("지금 URL 을 쓰는 서비스는 더 이상 보낼 수 없어요. 새 URL 로 바꿔 넣어야 해요."), confirmLabel: t("새로 만들기") });
    if (!ok) return;
    try { const r = await call("POST", `/${ch.id}/token`); upsert(r.channel); openConnect(r.channel); toast(t("새 URL 을 만들었어요")); } catch (e) { toast(errText(e)); }
  });
}
