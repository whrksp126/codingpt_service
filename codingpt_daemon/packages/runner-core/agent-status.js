// agent-status — 에이전트 상태(모델·컨텍스트·사용 한도·비용)를 **공식 채널**에서 받아 둔다.
//
// ★ 2026-08-03 사용자 확정. 왜 이 모듈이 생겼는가:
//  종전엔 이 값들을 `status-line.js` 가 **터미널 화면을 3초마다 capture-pane 해서 정규식으로 긁어**
//  얻었다. 그 방식의 구조적 결함 3가지가 실측으로 드러났다.
//   ① 3초 늦다.  ② 화면 배치가 바뀌면 못 읽는다.  ③ "값이 바뀔 때만" push 하는데 유휴 터미널은
//      60초에 0건이라(실측), 한 번 놓치면 되살아날 계기가 없어 채팅이 영영 빈칸이었다.
//
// 두 CLI 모두 **숫자를 그대로 내주는 공식 경로**가 있다(격리 실측 정본 — 2026-08-03):
//
//  · claude = `statusLine` 훅. settings 의 `statusLine:{type:'command',command}` 로 지정한 프로그램을
//    **값이 바뀌는 순간에만** 실행하며 stdin 으로 JSON 을 준다(shift+tab 누르면 즉시 1회 발화 확인).
//    실측 페이로드: model.{id,display_name} · effort.level · fast_mode · thinking.enabled ·
//    context_window.{used_percentage,context_window_size,total_input_tokens,current_usage{...}} ·
//    rate_limits.{five_hour,seven_day}.{used_percentage,resets_at} ·
//    cost.{total_cost_usd,total_lines_added,total_lines_removed,total_duration_ms} ·
//    session_id · session_name · transcript_path · cwd · version · vim.mode
//    ⚠ **권한 모드(shift+tab 축)는 없다** — 그건 화면이 유일한 즉시 원천이라 status-line.js 가 계속 담당한다.
//    ⚠ statusLine 슬롯은 1개뿐이라 우리 래퍼가 사용자 스크립트를 **체인**한다(shim.js §statusLine).
//
//  · codex = rollout JSONL(우리가 채팅 때문에 **이미 tail 중인 그 파일**). 새 배관 0.
//    `event_msg:token_count` → info.{total_token_usage,last_token_usage,model_context_window} +
//      rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at} + credits
//    `thread_settings_applied` → thread_settings.{model,reasoning_effort,service_tier,approval_policy,
//      collaboration_mode.mode('default'|'plan')}
//    실측: shift+tab → **106ms** 만에 기록된다.
//    ⚠ rollout 파일은 **첫 턴 전에는 생기지 않는다**(실측) → 그 구간은 화면 폴백.
//
// 저장 키 = **트랜스크립트 파일 경로**. tid 를 몰라도 되는 게 핵심이다(claude 훅이 주는 것은
//  transcript_path 이고, transcript.js 의 byFile 이 이미 file→chatId 를 안다).
//
// 상태는 **누적 캐시**다(delta 아님). 한 번 알면 계속 들고 있으므로 "push 를 놓쳐 영영 빈칸"이
//  구조적으로 불가능해진다 — chat.open/chat.since 응답에 그대로 실어 주면 클라가 스스로 화해한다.

const MAX_ENTRIES = 64;          // 파일 경로별 상태 캐시 상한(LRU)
const status = new Map();        // file(abs) → { ...normalized, at }
// sessionId → file. claude 훅은 **첫 턴 전에도** 온다(transcript_path 는 아직 없는 파일을 가리킨다).
//  그 구간엔 대화 바인딩이 없어 file 로 찾을 길이 없으므로, 훅이 함께 주는 session_id 로도 색인한다
//  (터미널의 sessionId 는 훅 바인딩 레지스트리가 이미 안다 → transcript.lookupBind).
const bySession = new Map();
let emitFn = null;               // transcript.js 주입 — (file, status) => void

/** transcript.js 가 push 이미터를 주입한다(순환 require 회피 — status-line.js 와 같은 관례). */
function setEmitter(fn) { emitFn = typeof fn === 'function' ? fn : null; }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const pct = (v) => {
  const n = num(v);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
};

/**
 * 사용 한도 한 칸 → { id, label, pct, resetsAt } | null.
 *  resetsAt = **epoch 초**(claude 원문 단위 그대로). 표시(남은 시간)는 클라이언트가 계산한다 —
 *  데몬이 "3시간 21분 남음" 문자열을 만들면 그 문자열이 화면에 굳어 시간이 흘러도 안 변한다.
 */
function limit(id, label, used, resetsAt) {
  const p = pct(used);
  if (p == null) return null;
  return { id, label, pct: p, resetsAt: num(resetsAt) };
}

/**
 * claude statusLine stdin JSON → 정규 상태. 순수 함수 — 테스트 정본.
 *  rendered = **사용자 스크립트가 실제로 출력한 줄**(릴레이가 사본을 뜬 것). 이게 "사용자가 설정한
 *  콘텐츠"의 정본이라 채팅의 한 줄 요약은 이걸 그대로 쓴다(사용자 지적 2026-08-04) — 구조화 값은
 *  탭 펼침 상세에서만 쓴다. 스크립트가 없으면 line 이 없고, 그때만 우리가 항목을 골라 조립한다.
 */
function fromClaude(j, rendered) {
  if (!j || typeof j !== 'object') return null;
  const cw = j.context_window || {};
  const rl = j.rate_limits || {};
  const cost = j.cost || {};
  const used = cw.current_usage || null;
  // 컨텍스트 사용 토큰: claude 는 used_percentage 를 직접 주지만 토큰 수는 current_usage 합이다
  //  (input + cache_creation + cache_read — 사용자 statusline.sh 가 쓰는 그 조합. 실측 일치).
  const usedTokens = used
    ? (num(used.input_tokens) || 0) + (num(used.cache_creation_input_tokens) || 0) + (num(used.cache_read_input_tokens) || 0)
    : null;
  const limits = [
    limit('five_hour', '5시간', (rl.five_hour || {}).used_percentage, (rl.five_hour || {}).resets_at),
    limit('seven_day', '7일', (rl.seven_day || {}).used_percentage, (rl.seven_day || {}).resets_at),
  ].filter(Boolean);
  return compact({
    agent: 'claude',
    model: str((j.model || {}).display_name) || str((j.model || {}).id),
    effort: str((j.effort || {}).level),
    fast: j.fast_mode === true ? true : null,
    thinking: (j.thinking || {}).enabled === true ? true : null,
    contextPct: pct(cw.used_percentage),
    contextUsed: usedTokens,
    contextMax: num(cw.context_window_size),
    limits: limits.length ? limits : null,
    costUsd: num(cost.total_cost_usd),
    linesAdded: num(cost.total_lines_added),
    linesRemoved: num(cost.total_lines_removed),
    sessionName: str(j.session_name),
    // 사용자 줄(ANSI 포함) — 한 줄 요약의 정본.
    line: oneLine(rendered),
    source: 'hook',
  });
}

/**
 * 여러 줄일 수 있는 출력 → 미러할 한 줄. 빈 값이면 null.
 *  statusLine 은 멀티라인을 허용하지만 채팅 스트립은 한 줄이므로 첫 비어있지 않은 줄을 쓴다
 *  (사용자 스크립트가 여러 줄을 쓰면 나머지는 상세에서 볼 값들과 겹친다).
 */
function oneLine(s) {
  const t = String(s == null ? '' : s).replace(/\r/g, '');
  for (const ln of t.split('\n')) {
    if (ln.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').trim()) return ln.replace(/\s+$/, '');
  }
  return null;
}

/**
 * codex rollout 의 상태 이벤트 → 정규 상태(부분).
 *  두 종류가 **따로** 도착하므로 각각 부분 상태를 만들고 merge() 로 합친다.
 */
function fromCodexTokenCount(p) {
  const info = (p && p.info) || {};
  const rl = (p && p.rate_limits) || {};
  const max = num(info.model_context_window);
  // codex 의 "Context n% used" 는 **마지막 턴의 입력 토큰 / 컨텍스트 창** 이다(상태줄 실측과 일치).
  //  누적 total_token_usage 는 세션 전체 소비량이라 컨텍스트 점유율이 아니다(수억 토큰이 찍힌다).
  const last = info.last_token_usage || {};
  const usedTokens = num(last.input_tokens);
  const limits = [
    limit('primary', windowLabel((rl.primary || {}).window_minutes) || '한도', (rl.primary || {}).used_percent, (rl.primary || {}).resets_at),
    limit('secondary', windowLabel((rl.secondary || {}).window_minutes) || '보조 한도', (rl.secondary || {}).used_percent, (rl.secondary || {}).resets_at),
  ].filter(Boolean);
  return compact({
    agent: 'codex',
    contextUsed: usedTokens,
    contextMax: max,
    contextPct: usedTokens != null && max ? pct((usedTokens / max) * 100) : null,
    limits: limits.length ? limits : null,
    source: 'file',
  });
}

/** window_minutes → 사람이 읽는 라벨('5시간'/'7일'). 모르면 null. */
function windowLabel(minutes) {
  const m = num(minutes);
  if (m == null || m <= 0) return null;
  if (m % 1440 === 0) return `${m / 1440}일`;
  if (m % 60 === 0) return `${m / 60}시간`;
  return `${m}분`;
}

/**
 * codex `turn_context` → 부분 상태. **매 턴 기록되는** 줄이라 이쪽이 더 믿을 만한 원천이다.
 *  ★ 2026-08-03 실측 정정: `thread_settings_applied` 는 **설정이 바뀔 때만** 적힌다 — 새 세션의
 *   rollout 14줄에는 하나도 없었다(모델·계획모드가 영영 비어 보이던 원인). turn_context 에는
 *   model·effort·approval_policy·collaboration_mode 가 전부 들어 있고 매 턴 갱신된다.
 *  ⚠ 이 줄은 `{type:'turn_context', payload:{...}}` 로 **payload 안에 type 이 없다**(다른 줄과 모양이 다르다).
 */
function fromCodexTurnContext(p) {
  return compact({
    agent: 'codex',
    // ⚠ turn_context 에는 service_tier 가 없다 → fast 는 여기서 만들지 않는다(모름 유지).
    //  thread_settings_applied 가 오면 그때 채워진다. 모르면 그 칸은 아예 안 그린다.
    model: str(p.model),
    effort: str(p.effort) || str(p.reasoning_effort),
    planMode: (p.collaboration_mode || {}).mode === 'plan' ? true
      : (p.collaboration_mode || {}).mode === 'default' ? false : null,
    approvalPolicy: str(p.approval_policy),
    source: 'file',
  });
}

function fromCodexThreadSettings(p) {
  const ts = (p && p.thread_settings) || {};
  return compact({
    agent: 'codex',
    model: str(ts.model),
    effort: str(ts.reasoning_effort),
    // 실측: service_tier==='priority' 일 때 상태줄이 `fast` / `Fast on` 을 그린다.
    fast: ts.service_tier === 'priority' ? true : (ts.service_tier ? false : null),
    // collaboration_mode.mode = shift+tab 축('default'|'plan') — 알약의 **파일 기반 원천**이다.
    planMode: (ts.collaboration_mode || {}).mode === 'plan' ? true
      : (ts.collaboration_mode || {}).mode === 'default' ? false : null,
    approvalPolicy: str(ts.approval_policy),
    source: 'file',
  });
}

// ── codex: 사용자가 고른 항목대로 한 줄 만들기 ────────────────────────────────
// codex 에는 사용자 스크립트가 없다. 대신 `~/.codex/config.toml` 의 `[tui] status_line` 에
//  **항목 목록이 그대로 적혀 있다**(사용자 실측: ["model-with-reasoning","context-used","fast-mode",
//  "approval-mode","context-window-size","used-tokens"]). 그 순서대로 우리 구조화 값으로 조립하면
//  화면과 같은 내용이 된다 — 우리가 항목을 고르지 않는다(사용자 지적 2026-08-04).
//  ⚠ 화면을 긁지 않는다: 설정 파일 + 공식 이벤트 값만 쓴다.
const CODEX_DEFAULT_ITEMS = ['model-with-reasoning', 'context-used'];
let itemsCache = null;   // { at, items } — 설정 파일은 자주 안 바뀐다(짧은 캐시로 디스크 절약)
const ITEMS_TTL_MS = 20000;

/** `[tui] status_line = [...]` → 항목 id 배열. 못 읽으면 기본값. */
function codexStatusItems(readFile) {
  const now = Date.now();
  // readFile 주입은 테스트/특수 경로 — 캐시를 쓰지도, 남기지도 않는다(실파일 캐시와 섞이면 안 된다).
  if (!readFile && itemsCache && now - itemsCache.at < ITEMS_TTL_MS) return itemsCache.items;
  let items = CODEX_DEFAULT_ITEMS;
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const txt = (readFile || ((f) => fs.readFileSync(f, 'utf8')))(path.join(os.homedir(), '.codex', 'config.toml'));
    // `[tui]` 절 안의 status_line 만 본다(다른 절에 같은 이름이 있어도 오독하지 않게).
    const tui = /\[tui\][\s\S]*?(?=\n\[|$)/.exec(String(txt || ''));
    const m = tui && /status_line\s*=\s*\[([^\]]*)\]/.exec(tui[0]);
    if (m) {
      const got = [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] || x[2]);
      if (got.length) items = got;
    }
  } catch (_) { /* 설정 없음/읽기 실패 — 기본값 */ }
  if (!readFile) itemsCache = { at: now, items };
  return items;
}

/** 항목 id + 상태 → 표시 조각 | null(값 모름 = 그 칸을 아예 안 만든다). */
function codexItemText(id, st) {
  switch (id) {
    case 'model': return st.model || null;
    // 실측 표기: `gpt-5.6-sol low fast` — 고속 모드면 꼬리에 붙는다(fast-mode 항목과 별개로).
    case 'model-with-reasoning': return st.model
      ? [st.model, st.effort || null, st.fast ? 'fast' : null].filter(Boolean).join(' ') : null;
    case 'reasoning': return st.effort || null;
    case 'context-used': return st.contextPct != null ? `Context ${st.contextPct}% used` : null;
    case 'context-left': return st.contextPct != null ? `Context ${100 - st.contextPct}% left` : null;
    case 'context-window-size': return st.contextMax ? `${fmtK(st.contextMax)} window` : null;
    case 'used-tokens': return st.contextUsed != null ? `${fmtK(st.contextUsed)} used` : null;
    case 'fast-mode': return st.fast === true ? 'Fast on' : st.fast === false ? 'Fast off' : null;
    case 'approval-mode': return st.approvalPolicy ? approvalLabel(st.approvalPolicy) : null;
    case 'plan-mode': return st.planMode ? 'Plan mode' : null;
    default: return null;
  }
}

/** codex 가 화면에 쓰는 승인 정책 표기(실측 라벨). 모르는 값은 원문 그대로. */
function approvalLabel(p) {
  if (p === 'on-request') return 'Approve for me';
  if (p === 'never') return 'Full Access';
  if (p === 'untrusted' || p === 'on-failure') return 'Ask for approval';
  return String(p);
}

/** codex 표기 실측: 258400 → '258K', 8780 → '8.78K'(작은 값은 소수 2자리). */
function fmtK(n) {
  const v = num(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 100000) return Math.round(v / 1000) + 'K';
  if (v >= 1000) return (v / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'K';
  return String(v);
}

/** 상태 → 사용자가 고른 항목대로 조립한 한 줄 | null. */
function codexLine(st, readFile) {
  if (!st) return null;
  const parts = codexStatusItems(readFile).map((id) => codexItemText(id, st)).filter(Boolean);
  return parts.length ? parts.join(' \u00b7 ') : null;
}

/** null/undefined 필드를 떨어뜨린다 — 부분 상태를 merge 할 때 "모름"이 기존 값을 지우지 않게. */
function compact(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] != null) out[k] = o[k];
  return out;
}

/** 이전 상태 + 부분 상태 → 합친 상태. 부분에 없는 필드는 **유지**된다(모름 ≠ 지움). */
function merge(prev, patch) {
  if (!patch || !Object.keys(patch).length) return prev || null;
  return { ...(prev || {}), ...patch };
}

/** rollout 라인 1개(파싱된 객체) → 부분 상태 | null. 순수 함수. */
function fromCodexLine(o) {
  const p = (o && o.payload) || null;
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'token_count') return fromCodexTokenCount(p);
  if (p.type === 'thread_settings_applied') return fromCodexThreadSettings(p);
  // turn_context 만 payload 에 type 이 없다 — 바깥 type 으로 판별한다(실측 모양).
  if (o.type === 'turn_context' && !p.type) return fromCodexTurnContext(p);
  return null;
}

// codex rollout 은 초대형이다(사용자 실파일 2.4GB) → **문자열 선검사**로 JSON.parse 를 아낀다.
const CODEX_HINT = /"(token_count|thread_settings_applied|turn_context)"/;

/**
 * codex 원시 라인들에서 상태를 흡수한다. transcript.js 의 tail/스냅샷이 부른다.
 *  lines = Buffer|string 배열(파서가 쓰던 그 목록 그대로).
 */
function noteCodexLines(file, lines) {
  if (!file || !Array.isArray(lines) || !lines.length) return false;
  let patch = null;
  for (const ln of lines) {
    const s = typeof ln === 'string' ? ln : (ln && ln.buf ? ln.buf.toString('utf8') : String(ln || ''));
    if (!CODEX_HINT.test(s)) continue;
    let o;
    try { o = JSON.parse(s); } catch (_) { continue; }
    const part = fromCodexLine(o);
    if (part) patch = { ...(patch || {}), ...part };
  }
  return patch ? set(file, patch) : false;
}

/** claude 훅 페이로드 흡수 — cpt-server 의 status.report 가 부른다. */
function noteClaudeHook(json, rendered) {
  const file = str(json && json.transcript_path);
  const norm = fromClaude(json, rendered);
  if (!file || !norm) return null;
  const sid = str(json && json.session_id);
  if (sid) bySession.set(sid, file);
  set(file, norm);
  return file;
}

/** sessionId → 상태 | null. 대화가 아직 없는 터미널(첫 턴 전)의 유일한 조회 경로다. */
function getBySession(sessionId) {
  const f = sessionId ? bySession.get(String(sessionId)) : null;
  return f ? get(f) : null;
}

/** 상태 갱신 + 변화 시 emit. 같은 값이면 조용히 넘어간다(프레임 절약). */
function set(file, patch) {
  const prev = status.get(file) || null;
  const next = merge(prev, patch);
  if (!next) return false;
  // codex 는 사용자 스크립트가 없으므로 여기서 **설정된 항목대로** 한 줄을 만든다(claude 는 릴레이가 준다).
  if (next.agent === 'codex') {
    const line = codexLine(next);
    if (line) next.line = line; else delete next.line;
  }
  if (prev && sameStatus(prev, next)) { prev.at = Date.now(); return false; }
  next.at = Date.now();
  status.set(file, next);
  evict();
  if (emitFn) { try { emitFn(file, view(next)); } catch (_) { /* noop */ } }
  return true;
}

/** at(갱신시각)을 뺀 동등 비교 — 값이 그대로면 push 하지 않는다. */
function sameStatus(a, b) {
  const strip = (o) => { const { at, ...rest } = o; return JSON.stringify(rest); };
  return strip(a) === strip(b);
}

function evict() {
  if (status.size <= MAX_ENTRIES) return;
  let oldest = null;
  for (const [k, v] of status) if (!oldest || v.at < oldest[1].at) oldest = [k, v];
  if (oldest) status.delete(oldest[0]);
}

/** 와이어로 나가는 모양(내부 필드 제거). */
function view(s) {
  if (!s) return null;
  const { at, ...rest } = s;
  return { ...rest, at };
}

/** 파일 경로 → 지금 아는 상태 | null. chat.open/chat.since 가 응답에 싣는다. */
function get(file) { return file ? view(status.get(file) || null) : null; }

function clear() { status.clear(); bySession.clear(); itemsCache = null; }

module.exports = {
  setEmitter, noteCodexLines, noteClaudeHook, get, getBySession, set, clear,
  // 순수 함수(테스트 정본)
  fromClaude, fromCodexLine, fromCodexTokenCount, fromCodexThreadSettings, fromCodexTurnContext, merge, windowLabel,
  codexStatusItems, codexLine, _oneLine: oneLine,
  _status: status, _bySession: bySession,
};
