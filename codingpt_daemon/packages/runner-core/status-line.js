// status-line — TUI 하단 statusline 을 채팅 UI 로 미러하는 감시자.
//
// 배경(2026-07-30 사용자 확정): claude 는 공식 statusLine(사용자 스크립트)이, codex 는
//  [tui] status_line(내장 항목)이 터미널 하단에 상태를 그리는데 채팅 UI 에선 안 보인다.
//  사용자 선택 = **TUI 원문 미러**(구조화 재구성이 아니라 화면에 있는 그 줄을 색까지 그대로).
//
// 동작: chat.open 된 채팅(chatId)마다 (cwdRel, tid, agent) 를 등록하고, 3s 틱으로 해당
//  tmux pane 을 `capture-pane -e`(ANSI 포함)로 떠 하단 상태 영역을 추출한다. 내용이 바뀌면
//  기존 chat_event 채널의 control 프레임(kind='status_line')으로 push 한다 — back 팬아웃이
//  control 을 원문 그대로 통과시키므로 서버 무변경, 구 클라이언트는 미지 kind 를 무시(실측).
//
// 추출 규칙(2026-07-30 라이브 실측 — 캡처 원문이 테스트 픽스처):
//  · claude: 컴포저 아래 **마지막 구분선(─ 연속)** 뒤 ~ 푸터(⏵⏵/-- INSERT --/? for shortcuts)
//    사이의 비어있지 않은 줄들 = statusLine 스크립트 출력(멀티라인 허용, 최대 3줄).
//    커스텀 statusline 이 없으면 그 구간이 비므로 푸터 줄을 폴백으로 미러한다(모드 정보).
//  · codex: 마지막 컴포저(`›`) 줄 **아래**의 비어있지 않은 줄들 = [tui] status_line (최대 2줄).
//  · 다이얼로그/알 수 없는 화면이면 추출 실패 → 이전 값 유지(빈 값 덮어쓰기로 깜빡이지 않는다).
const POLL_MS = 3000;
const MAX_LINE_BYTES = 2000;   // 줄당 상한(ANSI 포함) — 폭주 방어
const CLAUDE_MAX_LINES = 3;
const CODEX_MAX_LINES = 2;

const watches = new Map(); // chatId → { cwdRel, tid, agent, last: string|null }
let timer = null;
let emitFn = null;         // transcript.js 가 주입 — (chatId, lines) => void

function stripAnsi(s) {
  // CSI/OSC 만 걷어낸다(추출 판정용) — 렌더는 원문을 쓴다.
  return String(s || '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

const RULE_RE = /^\s*─{8,}\s*$/;
const CLAUDE_FOOTER_RE = /(⏵⏵|-- INSERT --|\? for shortcuts|shift\+tab to cycle|plan mode on|bypassing permissions)/;

/** 화면(ANSI 포함) → 미러할 statusline 줄 목록. 추출 불가면 null(이전 값 유지). 순수 함수 — 테스트 정본. */
function extractStatusLines(screen, agent) {
  if (!screen) return null;
  const lines = String(screen).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;

  if (agent === 'codex') {
    // 마지막 `›` 줄(컴포저) 아래의 비어있지 않은 줄들.
    let ci = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*›/.test(stripAnsi(lines[i]))) { ci = i; break; }
    }
    if (ci < 0) return null;
    const out = [];
    for (let i = ci + 1; i < lines.length && out.length < CODEX_MAX_LINES; i++) {
      if (stripAnsi(lines[i]).trim()) out.push(lines[i].slice(0, MAX_LINE_BYTES));
    }
    return out.length ? out : null;
  }

  // claude — 마지막 구분선 뒤 구간.
  let ri = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE_RE.test(stripAnsi(lines[i]))) { ri = i; break; }
  }
  if (ri < 0) return null;
  const status = [];
  let footer = null;
  for (let i = ri + 1; i < lines.length; i++) {
    const plain = stripAnsi(lines[i]);
    if (!plain.trim()) continue;
    if (CLAUDE_FOOTER_RE.test(plain)) { footer = lines[i].slice(0, MAX_LINE_BYTES); continue; }
    if (status.length < CLAUDE_MAX_LINES) status.push(lines[i].slice(0, MAX_LINE_BYTES));
  }
  if (status.length) return status;
  return footer ? [footer] : null;
}

function watch(chatId, { cwdRel, tid, agent } = {}) {
  if (!chatId || !Number.isInteger(tid)) return;
  if (agent !== 'claude' && agent !== 'codex') return; // 추출 규칙이 있는 에이전트만
  watches.set(chatId, { cwdRel: typeof cwdRel === 'string' ? cwdRel : '', tid, agent, last: null });
  ensureTimer();
  // 첫 페인트를 틱까지 기다리지 않는다 — 즉시 1회.
  pollOne(chatId).catch(() => { /* noop */ });
}

function unwatch(chatId) {
  watches.delete(chatId);
  if (!watches.size && timer) { clearInterval(timer); timer = null; }
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    for (const id of watches.keys()) pollOne(id).catch(() => { /* noop */ });
  }, POLL_MS);
  if (timer.unref) timer.unref();
}

async function pollOne(chatId) {
  const w = watches.get(chatId);
  if (!w) return;
  const ptyLib = require('./pty');
  const { session } = ptyLib.sessionForCwd(w.cwdRel);
  const target = `=${ptyLib.termSession(session, w.tid)}:0`;
  let screen = null;
  try { screen = await ptyLib.runTmux(['capture-pane', '-e', '-p', '-t', target]); }
  catch (_) { return; } // 터미널 없음 — tail 수명은 transcript 가 관리, 여기선 침묵
  const lines = extractStatusLines(screen, w.agent);
  if (!lines) return;                       // 추출 불가 — 이전 값 유지(깜빡임 방지)
  const key = lines.join('\n');
  if (key === w.last) return;
  w.last = key;
  if (emitFn) emitFn(chatId, lines);
}

/** transcript.js 가 push 이미터를 주입한다(순환 require 회피). */
function setEmitter(fn) { emitFn = typeof fn === 'function' ? fn : null; }

/** chat.open 응답용 — 즉시 1회 추출(캐시가 있으면 그것). */
async function snapshotFor(chatId) {
  const w = watches.get(chatId);
  if (!w) return null;
  if (w.last != null) return w.last.split('\n');
  try { await pollOne(chatId); } catch (_) { /* noop */ }
  return w.last != null ? w.last.split('\n') : null;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  watches.clear();
}

module.exports = { watch, unwatch, setEmitter, snapshotFor, stop, _extract: extractStatusLines, _watches: watches };
