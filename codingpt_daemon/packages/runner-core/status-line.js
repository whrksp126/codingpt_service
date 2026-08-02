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
// 푸터(모드 표시줄) 식별자 — claude 는 컴포저 아래 한 **행**(Ink flex row)에 vim 표시(-- INSERT --) +
//  모드 알약(⏸ manual/plan · ⏵⏵ accept edits/auto) + 힌트를 나란히 그린다. 2.1.220 실측 라벨:
//  `⏸ manual mode on` / `⏵⏵ accept edits on` / `⏸ plan mode on` / `⏵⏵ auto mode on` / `bypassing permissions`.
const CLAUDE_FOOTER_RE = /(⏵⏵|⏸|--\s*(INSERT|NORMAL|VISUAL|REPLACE)|\? for shortcuts|shift\+tab to cycle|mode on|bypassing permissions|for agents)/;
// 줄바꿈 부스러기 — 위 푸터 행이 **터미널 폭보다 길면 Ink 가 그 행을 감싸서** 꼬리(대개 vim 표시의
//  닫는 `--`)만 다음 줄에 남는다(2026-08-01 48컬럼 실측: `  --` 한 줄). 내용이 아니므로 미러하지 않는다.
const JUNK_RE = /^[-–—─·…\s]*$/;

// ── 에이전트 모드(권한 모드) — 채팅 알약의 원천 ────────────────────────────────
// claude 2.1.220 실측(격리 tmux, 40·60컬럼 모두 동일): shift+tab 이 아래 순서로 **한 방향 순환**하고
//  푸터에 라벨이 그대로 뜬다. 폭이 좁아도 **라벨은 안 잘린다**(힌트 쪽이 먼저 잘림) → 화면 파싱이 안전.
//  순환 순서는 세션 조건에 따라 달라진다(bypass 는 --dangerously-skip-permissions 세션에서만 낀다)
//  → 어디에도 순서를 박지 않는다. 조작은 "라벨 읽고 → BTab → 다시 읽기" 반복(cpt-server.chatMode).
const CLAUDE_MODES = [
  // id            푸터 라벨 판별            표시용 라벨(TUI 원문 그대로 — 사용자 확정 2026-08-01)
  { id: 'bypassPermissions', re: /bypassing permissions/, label: 'bypassing permissions', symbol: '⏵⏵' },
  { id: 'acceptEdits', re: /accept edits on/, label: 'accept edits on', symbol: '⏵⏵' },
  { id: 'plan', re: /plan mode on/, label: 'plan mode on', symbol: '⏸' },
  { id: 'auto', re: /auto mode on/, label: 'auto mode on', symbol: '⏵⏵' },
  { id: 'default', re: /manual mode on/, label: 'manual mode on', symbol: '⏸' },
];

/** 푸터 텍스트(ANSI 제거 여부 무관) → { id, label, symbol } | null. 순수 함수 — 테스트 정본. */
function parseMode(footerText) {
  const plain = stripAnsi(footerText || '');
  if (!plain) return null;
  for (const m of CLAUDE_MODES) {
    if (m.re.test(plain)) return { id: m.id, label: m.label, symbol: m.symbol };
  }
  return null;
}

/** 화면 → 현재 모드({id,label,symbol}) | null. claude 전용(codex 는 모드 개념이 달라 미지원). */
function extractMode(screen, agent) {
  if (agent !== 'claude') return null;
  const footer = claudeFooterOf(screen);
  return footer ? parseMode(footer) : null;
}

/** 화면 → claude 푸터 행(원문) | null. 모드 파싱과 statusline 분리가 같은 규칙을 쓰게 하는 지점. */
function claudeFooterOf(screen) {
  const parts = splitClaude(screen);
  return parts ? parts.footer : null;
}

/** claude 화면 → { status:[], footer:string|null } | null(구분선 없음 = 판정 불가). */
function splitClaude(screen) {
  if (!screen) return null;
  const lines = String(screen).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  let ri = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE_RE.test(stripAnsi(lines[i]))) { ri = i; break; }
  }
  if (ri < 0) return null;
  // 푸터는 **항상 마지막**이다(statusLine 스크립트 출력 위 → 푸터 행 → 그 행의 줄바꿈 꼬리).
  //  그래서 "첫 푸터 표식이 나온 줄부터 끝까지 = 푸터"로 자른다. 줄 단위로 푸터를 걸러내던 옛 규칙은
  //  표식이 없는 **꼬리 줄(`--`)을 statusline 으로 오인**해 채팅에 그대로 흘렸다(사용자 신고).
  const status = [];
  let footer = null;
  for (let i = ri + 1; i < lines.length; i++) {
    const plain = stripAnsi(lines[i]);
    if (!plain.trim()) continue;
    if (footer == null && CLAUDE_FOOTER_RE.test(plain)) { footer = lines[i].slice(0, MAX_LINE_BYTES); continue; }
    if (footer != null) continue;                                  // 푸터 이후(꼬리)는 전부 버린다
    if (JUNK_RE.test(plain)) continue;                             // 부스러기 방어(푸터 표식이 꼬리에 실린 경우)
    if (status.length < CLAUDE_MAX_LINES) status.push(lines[i].slice(0, MAX_LINE_BYTES));
  }
  return { status, footer };
}

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

  // claude — 마지막 구분선 뒤 구간(모드 파싱과 같은 분리 규칙을 쓴다).
  const parts = splitClaude(screen);
  if (!parts) return null;
  if (parts.status.length) return parts.status;
  return parts.footer ? [parts.footer] : null;
}

function watch(chatId, { cwdRel, tid, agent } = {}) {
  if (!chatId || !Number.isInteger(tid)) return;
  if (agent !== 'claude' && agent !== 'codex') return; // 추출 규칙이 있는 에이전트만
  watches.set(chatId, { cwdRel: typeof cwdRel === 'string' ? cwdRel : '', tid, agent, last: null, lastMode: null });
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
  // 모드는 statusline 과 **독립**으로 갱신한다 — 커스텀 statusline 이 있으면 푸터(=모드 원천)는
  //  미러 대상에서 빠지므로, 여기서 뽑아 두지 않으면 채팅 알약이 영영 갱신되지 않는다.
  const mode = extractMode(screen, w.agent);
  const modeKey = mode ? mode.id : null;
  const modeChanged = mode != null && modeKey !== w.lastMode;
  if (modeChanged) w.lastMode = modeKey;
  const lines = extractStatusLines(screen, w.agent);
  const key = lines ? lines.join('\n') : null;
  const linesChanged = key != null && key !== w.last;
  if (linesChanged) w.last = key;
  if (!linesChanged && !modeChanged) return;  // 변화 없음(추출 불가면 이전 값 유지 — 깜빡임 방지)
  if (emitFn) emitFn(chatId, w.last != null ? w.last.split('\n') : [], modeOf(w));
}

/** 캐치업(chat.since)용 — 지금 알고 있는 모드({id,label,symbol}) | null. 캡처하지 않는다(캐시 읽기). */
function modeFor(chatId) { return modeOf(watches.get(chatId)); }

// ── 즉시 확인(poke) ────────────────────────────────────────────────────────────
// 3초 폴링은 **놓쳤을 때의 안전망**이고, 모드가 바뀌는 순간을 알 수 있으면 그때 바로 확인하는 게
//  사용자가 느끼는 반응이다(사용자 요청 2026-08-02). 지금 아는 "그 순간" 두 가지:
//   ① 우리 터미널 입력 경로로 shift+tab(CSI Z)이 지나갈 때(pty.js) — TUI 에서 사람이 누른 그 키.
//   ② 채팅으로 전환(chat.open)할 때 — 화면을 여는 순간의 값은 캐시가 아니라 실제 화면이어야 한다.
//  TUI 가 다시 그리는 데 한 틱이 걸리므로 짧은 지연 뒤 1회 + 한 번 더(느린 리페인트 보정) 확인한다.
const POKE_DELAY_MS = 120;
const POKE_RETRY_MS = 500;

/** 특정 tmux 터미널 세션(cpt-…--t-<tid>)을 보는 감시자들을 즉시 확인시킨다. */
function pokeTermSession(termName) {
  const name = String(termName || '');
  if (!name || !watches.size) return;
  const ptyLib = require('./pty');
  for (const [chatId, w] of watches) {
    let mine = '';
    try { mine = ptyLib.termSession(ptyLib.sessionForCwd(w.cwdRel).session, w.tid); } catch (_) { continue; }
    if (mine !== name) continue;
    setTimeout(() => { pollOne(chatId).catch(() => { /* noop */ }); }, POKE_DELAY_MS);
    setTimeout(() => { pollOne(chatId).catch(() => { /* noop */ }); }, POKE_RETRY_MS);
  }
}

/** 입력 바이트에 shift+tab(CSI Z)이 들어 있으면 그 터미널을 즉시 확인시킨다(pty.js 가 호출). */
const CSI_Z = '\x1b[Z';
function onTerminalInput(termName, bytes) {
  if (!watches.size) return;
  const s = typeof bytes === 'string' ? bytes : (bytes && bytes.toString ? bytes.toString('latin1') : '');
  if (!s || s.indexOf(CSI_Z) < 0) return;
  pokeTermSession(termName);
}

/** watch 엔트리의 마지막 모드 → 와이어 객체({id,label,symbol}) | null. */
function modeOf(w) {
  if (!w || !w.lastMode) return null;
  const m = CLAUDE_MODES.find((x) => x.id === w.lastMode);
  return m ? { id: m.id, label: m.label, symbol: m.symbol } : null;
}

/** transcript.js 가 push 이미터를 주입한다(순환 require 회피). */
function setEmitter(fn) { emitFn = typeof fn === 'function' ? fn : null; }

/**
 * chat.open 응답용 → { lines, mode } | null.
 *  ★ 항상 **화면을 새로 읽는다**(캐시로 대충 답하지 않는다): TUI ↔ 채팅 토글은 "지금 화면을 보겠다"는
 *   행위라 그 순간의 값이 정본이어야 한다(사용자 요청 2026-08-02 — 토글할 때도 즉시 갱신).
 *   비용은 capture-pane 한 번이고, 감시자가 이미 등록돼 있으므로 폴링 주기와도 충돌하지 않는다.
 */
async function snapshotFor(chatId) {
  const w = watches.get(chatId);
  if (!w) return null;
  try { await pollOne(chatId); } catch (_) { /* noop */ }
  const lines = w.last != null ? w.last.split('\n') : null;
  const mode = modeOf(w);
  return lines || mode ? { lines, mode } : null;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  watches.clear();
}

module.exports = {
  watch, unwatch, setEmitter, snapshotFor, modeFor, pokeTermSession, onTerminalInput, stop,
  parseMode, extractMode, MODE_IDS: CLAUDE_MODES.map((m) => m.id),
  _extract: extractStatusLines, _watches: watches,
};
