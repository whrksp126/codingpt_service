/**
 * conv-engine-claude.js — 채팅 v2 의 claude 어댑터(설계 정본 docs/chat-v2-design.md §0.1·§5).
 *
 * 사용자 PC 의 **수정되지 않은** claude CLI 를 구조화 모드로 띄우고, stdout(stream-json)을 에이전트 중립
 * 이벤트로 바꿔 conv.js 에 넘긴다. stdin 으로는 사용자 메시지·승인 응답·제어 요청을 쓴다.
 * 자격증명은 읽지도 옮기지도 않는다(`--bare` 금지 — 구독 로그인이 안 된다).
 *
 * agent.js(2026-07 동면 엔진)와 다른 점: 승인에 MCP 를 쓰지 않는다. `--permission-prompt-tool stdio` 가
 * 승인·질문을 stdout 의 control_request 로 내보내고 stdin 의 control_response 로 받는다.
 *
 * ── 어댑터 인터페이스(codex 등 다음 어댑터가 맞출 모양) ─────────────────────────
 *   id, modes
 *   label()                      표시명(agents.js 카탈로그 — 벤더 제품명 금지)
 *   locate()                     → { bin, version } | null      실행 파일 절대경로(우리 심을 거치지 않는다)
 *   loginState()                 → 'in' | 'out' | null
 *   sessionFile(absCwd, id)      → 세션 파일 경로 | null        가져오기(§4.3) 전용. 라이브 경로는 읽지 않는다
 *   sessions(absCwd, limit)      → [{ id, title, lastAt, mode }] 이 폴더의 세션 목록(외부 대화 표시용)
 *   importLine(o, ctx)           → [{ key, …ConvMsg }]          세션 파일 한 줄 → 메시지
 *   resumeCommand(id)            → 터미널에서 이어 갈 명령(§6.1) — 표시용
 *   resumeArgs(id)               → 그 명령의 인자만(실행 파일 제외) — 클라가 실제로 쓰는 값
 *   start(opts, onEvent)         → handle
 *       opts  = { bin, cwd, sessionId, resume, mode, model, env }
 *       handle = { pid, alive(), send({text, uuid}), respond(rid, decision), interrupt(), setMode(m),
 *                  setModel(m), stop({graceMs}) }
 *   onEvent(ev) — ev.type:
 *       init      { mode, model, commands[], terminalCommands[], version }        턴마다 온다
 *       ack       { uuid, text, ts }                                              보낸 메시지의 도달 확인
 *       delta     { key, kind:'text'|'thinking', off, text }                      50ms 코얼레싱 끝난 조각
 *       msgs      { msgs:[{key,…}], uuid, usage? }                                완성된 메시지(블록 단위)
 *       request   { rid, tool, toolUseId, input, description, suggestions, interactive }
 *       request_gone { rid }
 *       mode      { mode }
 *       rate      { status, kind, resetsAt, utilization, blocked }                rate_limit_event 마다. blocked = 실제 차단
 *       usage     { contextTokens, model }                                        메인 세션 응답마다(값이 바뀔 때만) — 컨텍스트 점유
 *       result    { ok, subtype, interrupted, durationMs, usage, costUsd, contextTokens, contextMax, model, text, authFailed }
 *       exit      { code, signal, stderr, spawnError? }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnCli, killTree } = require('./spawn-util');

const COALESCE_MS = 50;
const TEXT_CAP = 64 * 1024;          // ConvMsg.text 문자 상한(v1 의 4096 이 아니다 — §2.3)
const CONTROL_TIMEOUT_MS = 10000;    // interrupt/set_permission_mode 응답 대기
const STDERR_TAIL = 2000;
const KILL_AFTER_TERM_MS = 2000;
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
// 데몬이 다른 에이전트 세션 안에서 떴을 때 물려받는 "나는 자식 세션" 표식. 그대로 넘기면 CLI 가 자신을
//  중첩 세션으로 오인한다. 사용자가 고른 설정(CLAUDE_CONFIG_DIR 등)은 건드리지 않는다.
const NESTED_ENV = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];
const INTERRUPT_MARK = /^\[Request interrupted by user/;
const AUTH_RE = /authentication_failed|invalid api key|please run \/login|not logged in/i;

const transcript = () => require('./transcript'); // 지연 — 파서만 쓰는 테스트가 tail 기계를 끌어오지 않게
const agents = () => require('./agents');

// ── 메시지 변환 ──────────────────────────────────────────────────────────────
// normalize 는 v1 의 seq(라인 오프셋 파생)를 붙인다 — v2 의 seq 는 conv-store 가 매기므로 떼어 낸다.
//  off=0 으로 부르면 v1 seq 가 곧 (블록 인덱스+1) 이라, 한 줄에 여러 결과가 실린 경우의 순번으로 쓴다.
function normalizeLine(o, textCap) {
  const out = [];
  for (const m of transcript().normalize(o, 0, { textCap })) {
    const { seq, ...rest } = m;
    out.push({ idx: Math.max(0, (seq || 1) - 1), msg: rest });
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('');
}

// stream-json 과 세션 파일은 같은 message.content 구조지만 곁가지 필드 이름이 다르다(snake ↔ camel).
function toLineShape(o) {
  const ptu = o.parent_tool_use_id || null;
  const line = { ...o };
  if (o.tool_use_result !== undefined && o.toolUseResult === undefined) line.toolUseResult = o.tool_use_result;
  if (o.compact_metadata && !o.compactMetadata) {
    const cm = o.compact_metadata;
    line.compactMetadata = { preTokens: cm.pre_tokens || cm.preTokens || 0, postTokens: cm.post_tokens || cm.postTokens || 0, trigger: cm.trigger || null };
  }
  if (ptu) line.isSidechain = true;
  return { line, ptu };
}

/**
 * 한 줄(assistant/user/system) → [{ key, …ConvMsg }]. 라이브(stdout)와 가져오기(세션 파일)가 **같은 함수**를
 * 타야 같은 메시지가 같은 key 를 얻는다. blockIdx = 이 assistant 줄의 블록 인덱스(호출자가 센다).
 */
function toMsgs(o, { blockIdx = 0, textCap = TEXT_CAP, closeDraft = false } = {}) {
  const { line, ptu } = toLineShape(o);
  const uuid = o.uuid || null;
  const out = [];
  const push = (key, m) => out.push({ key, ...m, ...(ptu ? { parent: ptu } : {}) });
  if (o.type === 'assistant') {
    const mid = (o.message && o.message.id) || uuid || 'm';
    const rows = normalizeLine(line, textCap);
    let main = false;
    for (const { idx, msg } of rows) {
      if (msg.role === 'system') { push(`s:${uuid || mid}:${idx}`, msg); continue; } // API 오류 구분선
      main = true;
      if (msg.tool && msg.tool.id) push(String(msg.tool.id), msg);
      else push(`${mid}:${blockIdx + idx}`, msg);
    }
    // 빈 텍스트 블록은 normalize 가 버린다. 델타로 초안이 나간 뒤라면 같은 key 로 닫아 줘야 클라가 초안을 치운다.
    if (!main && closeDraft) {
      push(`${mid}:${blockIdx}`, { ts: o.timestamp || null, role: 'assistant', kind: 'text', text: '', truncated: false, hidden: true });
    }
    return out;
  }
  if (o.type === 'user') {
    for (const { idx, msg } of normalizeLine(line, textCap)) {
      if (msg.kind === 'tool_result' && msg.result && msg.result.toolUseId) { push('r:' + msg.result.toolUseId, msg); continue; }
      const m = { ...msg };
      if (m.kind === 'text' && INTERRUPT_MARK.test(String(m.text || '').trim())) { m.kind = 'interrupt'; m.hidden = true; }
      // /compact 뒤 CLI 가 남기는 "This session is being continued…" 요약은 사람이 한 말이 아니다 — 경계선(compact_boundary)이
      //  이미 "대화 압축" 을 알리므로 요약 본문을 말풍선·구분선으로 또 그리지 않는다(2026-10 QA).
      if (m.kind === 'compact') m.hidden = true;
      push(idx ? `u:${uuid}:${idx}` : `u:${uuid}`, m);
    }
    return out;
  }
  if (o.type === 'system') {
    if (o.subtype !== 'compact_boundary' && o.subtype !== 'api_error') return out;
    for (const { idx, msg } of normalizeLine(line, textCap)) push(`s:${uuid}:${idx}`, msg);
  }
  return out;
}

// 세션 파일에만 있는 곁가지(첨부 메타·큐 조작·훅 요약…)는 대화가 아니다 — 가져오기에서 버린다.
const IMPORT_DROP_KINDS = new Set(['meta', 'unknown', 'system']);

// ── 사용량(§4.5) ─────────────────────────────────────────────────────────────
// API usage 하나 → 그 호출이 차지한 컨텍스트(입력 + 캐시 읽기/생성 + 출력 — 출력도 다음 호출의 입력이 된다).
function contextTokensOf(u) {
  if (!u || typeof u !== 'object') return 0;
  const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0);
  return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
}

/**
 * result.modelUsage({ "<모델 id>": { contextWindow, … } }) 에서 메인 모델의 항목을 고른다 → { model, entry } | null.
 *  서브에이전트가 다른 모델을 쓰면 항목이 여럿이다 — 메인 모델 id(키 또는 canonicalModel)가 맞는 것,
 *  모르면 하나뿐일 때만 그것, 아니면 토큰을 가장 많이 쓴 항목. contextWindow 를 모델 id 로 추정하지 않는다.
 */
function modelUsageOf(modelUsage, model) {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const rows = Object.entries(modelUsage).filter(([, v]) => v && typeof v === 'object');
  if (!rows.length) return null;
  let hit = model ? rows.find(([k, v]) => k === model || v.canonicalModel === model) : null;
  if (!hit && rows.length === 1) hit = rows[0];
  if (!hit) {
    const size = (v) => (v.inputTokens || 0) + (v.cacheReadInputTokens || 0) + (v.cacheCreationInputTokens || 0);
    hit = rows.slice().sort((a, b) => size(b[1]) - size(a[1]))[0];
  }
  return { model: hit[0], entry: hit[1] };
}

/**
 * rate_limit_info → { status, kind, resetsAt, utilization, blocked }.
 *  실측 status 는 턴마다 'allowed' 로 온다. 한도 근접 경고('allowed_warning' 등)는 **차단이 아니다** — 응답은 정상 완료된다.
 *  그래서 blocked = 'rejected' 또는 'allowed' 로 시작하지 않는 값일 때만(실기 검증 2026-09-30: 경고를 한도 도달로 안내했던 오류).
 *  utilization 은 이벤트에 있으면 그 값, 없으면 unifiedWindows[rateLimitType].utilization(실측 0~1).
 */
function rateOf(r) {
  const status = String(r.status);
  const kind = r.rateLimitType ? String(r.rateLimitType) : null;
  const win = kind && r.unifiedWindows && typeof r.unifiedWindows === 'object' ? r.unifiedWindows[kind] : null;
  const util = Number.isFinite(r.utilization) ? r.utilization : (win && Number.isFinite(win.utilization) ? win.utilization : null);
  const resetsAt = Number.isFinite(r.resetsAt) ? r.resetsAt : (win && Number.isFinite(win.resetsAt) ? win.resetsAt : null);
  return { status, kind, resetsAt, utilization: util, blocked: status === 'rejected' || !status.startsWith('allowed') };
}

// ── stdout 파서 ──────────────────────────────────────────────────────────────
/**
 * createParser(emit, opts) → { feed(obj), flush(), noteInterrupt(), dispose() }
 *  프로세스와 분리돼 있다 — 실측 캡처(ndjson)를 그대로 먹여 검증할 수 있게.
 */
function createParser(emit, opts = {}) {
  const textCap = opts.textCap || TEXT_CAP;
  const coalesceMs = opts.coalesceMs == null ? COALESCE_MS : opts.coalesceMs;
  const st = {
    msgId: null,            // 진행 중 메시지(메인 세션) — message_start 가 준다
    blocks: new Map(),      // blockIdx → { key, kind, sent, buf }  열려 있는 text/thinking 블록
    startIdx: null,         // 가장 최근 content_block_start 의 인덱스
    startUsed: true,        // 그 인덱스를 완성 메시지가 이미 가져갔는가
    counters: new Map(),    // message.id → 다음 블록 인덱스(스트림 이벤트가 없을 때의 셈)
    timer: null,
    interrupting: false,
    usage: null,            // 마지막 메인 세션 응답의 usage(컨텍스트 점유 추정)
    model: null,            // 메인 세션 모델(init·assistant 의 message.model) — result.modelUsage 에서 제 항목을 고르는 키
    ctxSent: null,          // 마지막으로 내보낸 usage 이벤트의 contextTokens(같은 값은 다시 안 낸다)
    authFailed: false,
  };

  function flushBlock(b) {
    if (!b || !b.buf) return;
    const text = b.buf;
    b.buf = '';
    emit({ type: 'delta', key: b.key, kind: b.kind, off: b.sent, text });
    b.sent += text.length;
  }
  function flush() {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    for (const b of st.blocks.values()) flushBlock(b);
  }
  function arm() {
    if (st.timer) return;
    if (!coalesceMs) { flush(); return; }
    st.timer = setTimeout(() => { st.timer = null; flush(); }, coalesceMs);
    if (st.timer.unref) st.timer.unref();
  }

  function onStream(o) {
    if (o.parent_tool_use_id) return; // 토큰 델타는 메인 세션만(실측) — 혹시 와도 key 를 만들 근거가 없다
    const ev = o.event || {};
    switch (ev.type) {
      case 'message_start':
        flush();
        st.blocks.clear();
        st.msgId = (ev.message && ev.message.id) || null;
        st.startIdx = null; st.startUsed = true;
        return;
      case 'content_block_start': {
        const idx = ev.index | 0;
        st.startIdx = idx; st.startUsed = false;
        const type = ev.content_block && ev.content_block.type;
        if (!st.msgId || (type !== 'text' && type !== 'thinking')) return;
        const b = { key: `${st.msgId}:${idx}`, kind: type, sent: 0, buf: '' };
        st.blocks.set(idx, b);
        // 생각 본문은 비어 온다(서명만). 시작 사실만이라도 즉시 알려야 "생각 중" 을 띄울 수 있다.
        if (type === 'thinking') emit({ type: 'delta', key: b.key, kind: 'thinking', off: 0, text: '' });
        return;
      }
      case 'content_block_delta': {
        const b = st.blocks.get(ev.index | 0);
        const d = ev.delta || {};
        if (!b) return;
        const piece = d.type === 'text_delta' ? d.text : (d.type === 'thinking_delta' ? d.thinking : '');
        if (!piece) return;
        b.buf += String(piece);
        arm();
        return;
      }
      case 'content_block_stop': {
        const idx = ev.index | 0;
        flushBlock(st.blocks.get(idx));
        st.blocks.delete(idx);
        return;
      }
      case 'message_delta':
        // 완성 assistant 줄의 usage.output_tokens 는 중간값이다(실측) — 최종값은 message_delta 가 준다.
        if (ev.usage && typeof ev.usage === 'object') { st.usage = { ...(st.usage || {}), ...ev.usage }; noteUsage(); }
        return;
      case 'message_stop':
        flush();
        st.blocks.clear();
        return;
      default:
    }
  }

  function noteUsage() {
    const ctx = contextTokensOf(st.usage);
    if (!ctx || ctx === st.ctxSent) return;
    st.ctxSent = ctx;
    emit({ type: 'usage', contextTokens: ctx, model: st.model || null });
  }

  // 완성 메시지는 블록 1개당 1줄, 같은 message.id 로 온다(실측) — 인덱스는 줄에 없으므로 스트림에서 얻는다.
  //  완성 줄은 그 블록의 content_block_stop **앞**에 온다 → "가장 최근에 시작된 블록" 이 곧 이 줄의 블록이다.
  function blockIndexOf(o) {
    const mid = (o.message && o.message.id) || '';
    let idx = st.counters.get(mid) || 0;
    if (!o.parent_tool_use_id && mid && mid === st.msgId && st.startIdx != null && !st.startUsed) {
      idx = st.startIdx;
      st.startUsed = true;
    }
    st.counters.set(mid, idx + 1);
    if (st.counters.size > 64) st.counters.delete(st.counters.keys().next().value);
    return idx;
  }

  function onAssistant(o) {
    const idx = blockIndexOf(o);
    const mine = !o.parent_tool_use_id && o.message && o.message.id === st.msgId;
    const b = mine ? st.blocks.get(idx) : null;
    flushBlock(b);                       // 초안의 남은 조각이 완성본보다 먼저 나가야 한다
    const drafted = !!(b && (b.sent > 0 || b.kind === 'thinking'));
    if (b) st.blocks.delete(idx);
    if (!o.parent_tool_use_id && o.message) {
      if (o.message.model) st.model = String(o.message.model);
      if (o.message.usage) { st.usage = o.message.usage; noteUsage(); }
    }
    if (o.error && AUTH_RE.test(String(o.error))) st.authFailed = true;
    const msgs = toMsgs(o, { blockIdx: idx, textCap, closeDraft: drafted });
    if (msgs.length) emit({ type: 'msgs', msgs, uuid: o.uuid || null });
  }

  function onUser(o) {
    if (o.isReplay) {
      emit({ type: 'ack', uuid: o.uuid || null, text: textOf(o.message && o.message.content), ts: o.timestamp || null });
      return;
    }
    const msgs = toMsgs(o, { textCap });
    if (msgs.length) emit({ type: 'msgs', msgs, uuid: o.uuid || null });
  }

  function onSystem(o) {
    if (o.subtype === 'init') {
      if (o.model) st.model = String(o.model);
      emit({
        type: 'init',
        mode: o.permissionMode || null, model: o.model || null,
        commands: Array.isArray(o.slash_commands) ? o.slash_commands.map(String) : [],
        terminalCommands: Array.isArray(o.terminal_slash_commands) ? o.terminal_slash_commands.map(String) : [],
        version: o.claude_code_version || null,
      });
      return;
    }
    if (o.subtype === 'status') {
      if (o.permissionMode) emit({ type: 'mode', mode: String(o.permissionMode) });
      return;
    }
    const msgs = toMsgs(o, { textCap });
    if (msgs.length) emit({ type: 'msgs', msgs, uuid: o.uuid || null });
  }

  function onResult(o) {
    flush();
    st.blocks.clear();
    const mu = modelUsageOf(o.modelUsage, st.model);
    // 컨텍스트 = 마지막 API 호출 하나의 크기. result.usage 는 턴 전체의 **합계**라 쓰면 안 된다(실측: 호출 3번이면 3배).
    //  스트림을 못 본 경우(방어)에만 result.usage.iterations 의 마지막 호출로 대신한다.
    const its = o.usage && Array.isArray(o.usage.iterations) ? o.usage.iterations : [];
    const ctx = contextTokensOf(st.usage) || contextTokensOf(its[its.length - 1]);
    const aborted = typeof o.terminal_reason === 'string' && /^aborted/.test(o.terminal_reason);
    const text = typeof o.result === 'string' ? o.result : ''; // 중단된 턴의 result 에는 result 필드가 없다(실측)
    emit({
      type: 'result',
      ok: !o.is_error,
      subtype: o.subtype || null,
      interrupted: st.interrupting || aborted,
      durationMs: Number.isFinite(o.duration_ms) ? o.duration_ms : null,
      usage: o.usage ? {
        input: o.usage.input_tokens || 0, output: o.usage.output_tokens || 0,
        cacheRead: o.usage.cache_read_input_tokens || 0, cacheCreate: o.usage.cache_creation_input_tokens || 0,
      } : null,
      costUsd: Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null,
      contextTokens: ctx || null,
      contextMax: mu && Number.isFinite(mu.entry.contextWindow) && mu.entry.contextWindow > 0 ? mu.entry.contextWindow : null,
      model: st.model || (mu && mu.model) || null,
      text,
      authFailed: st.authFailed || (!!o.is_error && AUTH_RE.test(text)),
    });
    st.interrupting = false;
    st.authFailed = false;
  }

  function feed(o) {
    if (!o || typeof o.type !== 'string') return;
    switch (o.type) {
      case 'stream_event': return onStream(o);
      case 'assistant': return onAssistant(o);
      case 'user': return onUser(o);
      case 'system': return onSystem(o);
      case 'result': return onResult(o);
      case 'rate_limit_event': {
        const r = o.rate_limit_info || {};
        if (!r.status) return;
        emit({ type: 'rate', ...rateOf(r) });
        return;
      }
      default: // control_* 는 프로세스 쪽(start)이 먼저 가로챈다
    }
  }

  return {
    feed, flush,
    noteInterrupt() { st.interrupting = true; },
    dispose() { if (st.timer) { clearTimeout(st.timer); st.timer = null; } },
  };
}

// ── 프로세스 ─────────────────────────────────────────────────────────────────
// AI 제목 — 별도 호출 없이 첫 응답에 한 줄만 얹게 한다(conv.js stripTitleMark 가 걷어 낸다).
const TITLE_PROMPT = 'In your FIRST text reply of this conversation only, start that reply with exactly one line: '
  + '<!--cpt-title: SHORT TITLE--> where SHORT TITLE is a concise 3-8 word title for the user\'s request, written in the '
  + 'language the user used. Put nothing before it. Never write this line again in later replies, never explain or mention it.';

function argsFor({ sessionId, resume, mode, model, effort, askTitle }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', MODES.includes(mode) ? mode : 'default',
  ];
  if (sessionId) args.push(resume ? '--resume' : '--session-id', String(sessionId));
  if (model) args.push('--model', String(model));
  if (effort && require('./agent-models').valid(String(effort))) args.push('--effort', String(effort));
  if (askTitle) args.push('--append-system-prompt', TITLE_PROMPT);
  return args;
}

// dispatch.js plannerEnv() 와 같은 기반 — 앱이 띄운 데몬의 PATH(/usr/bin:/bin)로는 CLI 가 다시 찾는
//  바이너리(node·git)가 조용히 실패한다. cpt 좌표는 넘기지 않는다(이 세션은 어느 터미널에도 속하지 않는다).
async function buildEnv() {
  let base = null;
  try { base = await require('./task-git').baseTools(); } catch (_) { base = null; }
  const env = { ...((base && base.env) || process.env) };
  delete env.TMUX;
  for (const k of Object.keys(env)) if (/^CPT_/.test(k)) delete env[k];
  for (const k of NESTED_ENV) delete env[k];
  env.CPT_HOOKS_DISABLED = '1';
  return env;
}

function start(opts, onEvent) {
  const emit = (ev) => { try { onEvent(ev); } catch (e) { console.error('[conv] 이벤트 처리 실패:', e && e.message); } };
  const parser = createParser(emit, { textCap: opts.textCap, coalesceMs: opts.coalesceMs });
  const controls = new Map(); // request_id → { resolve, reject, timer }  우리가 보낸 제어 요청
  let ctlSeq = 0;
  let stderr = '';
  let exited = false;
  let stopping = null;

  const proc = spawnCli(opts.bin, argsFor(opts), {
    cwd: opts.cwd, env: opts.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });

  // ENOENT 같은 기동 실패는 'error' 로만 온다('close' 가 뒤따르지 않을 수 있다).
  const spawned = new Promise((resolve, reject) => {
    proc.once('spawn', () => resolve());
    proc.once('error', (e) => reject(e));
  });
  spawned.catch(() => { /* 호출자가 ready 로 받는다 — 미처리 거부 방지 */ });

  function write(obj) {
    if (exited || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch (_) { return false; }
  }

  function finish(code, signal, extra) {
    if (exited) return;
    exited = true;
    parser.flush();
    parser.dispose();
    for (const [, c] of controls) { clearTimeout(c.timer); c.reject(Object.assign(new Error('프로세스가 종료됐습니다'), { code: 'PROCESS_EXIT' })); }
    controls.clear();
    emit({ type: 'exit', code: code == null ? null : code, signal: signal || null, stderr: stderr.trim(), expected: !!stopping, ...(extra || {}) });
  }

  function onLine(line) {
    if (!line.trim()) return;
    let o = null;
    try { o = JSON.parse(line); } catch (_) { return; }
    if (!o || typeof o.type !== 'string') return;
    if (o.type === 'control_response') {
      const r = o.response || {};
      const c = controls.get(r.request_id);
      if (!c) return; // 우리가 stdin 에 쓴 승인 응답의 메아리(실측: CLI 가 stdout 에 되돌린다)
      controls.delete(r.request_id);
      clearTimeout(c.timer);
      if (r.subtype === 'error') c.reject(Object.assign(new Error(String(r.error || '제어 요청이 거부됐습니다')), { code: 'CONTROL_FAILED' }));
      else c.resolve(r.response || {});
      return;
    }
    if (o.type === 'control_request') {
      const r = o.request || {};
      if (r.subtype === 'can_use_tool') {
        parser.flush(); // 요청 카드보다 앞선 말이 먼저 보이게
        emit({
          type: 'request', rid: String(o.request_id),
          tool: String(r.tool_name || ''), toolUseId: r.tool_use_id || null,
          input: r.input && typeof r.input === 'object' ? r.input : {},
          description: typeof r.description === 'string' ? r.description : '',
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
          interactive: !!r.requires_user_interaction,
        });
        return;
      }
      // 모르는 요청을 무응답으로 두면 CLI 가 그 자리에서 매달린다 — 못 한다고 분명히 답한다.
      write({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: `지원하지 않는 요청입니다: ${r.subtype}` } });
      return;
    }
    if (o.type === 'control_cancel_request') { emit({ type: 'request_gone', rid: String(o.request_id) }); return; }
    parser.feed(o);
  }

  let buf = '';
  proc.stdout.setEncoding('utf8'); // 청크 경계에 걸린 멀티바이트(한글)를 디코더가 이어 붙인다
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onLine(line); } catch (e) { console.error('[conv] stdout 줄 처리 실패:', e && e.message); }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_TAIL); });
  proc.stdin.on('error', () => { /* EPIPE — 종료는 close 가 알린다 */ });
  proc.on('error', (e) => finish(null, null, { spawnError: e && e.code === 'ENOENT' ? 'ENOENT' : String((e && (e.code || e.message)) || 'error') }));
  // 'exit' 이 아니라 'close' — stdout 을 끝까지 읽은 뒤여야 마지막 result 를 놓치지 않는다.
  proc.on('close', (code, signal) => finish(code, signal));

  function control(request, timeoutMs = CONTROL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = `cpt_${++ctlSeq}_${crypto.randomBytes(3).toString('hex')}`;
      const timer = setTimeout(() => {
        controls.delete(id);
        reject(Object.assign(new Error('에이전트가 제어 요청에 응답하지 않습니다'), { code: 'CONTROL_TIMEOUT' }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      controls.set(id, { resolve, reject, timer });
      if (!write({ type: 'control_request', request_id: id, request })) {
        controls.delete(id);
        clearTimeout(timer);
        reject(Object.assign(new Error('프로세스가 종료됐습니다'), { code: 'PROCESS_EXIT' }));
      }
    });
  }

  function kill(sig) {
    if (exited || !proc.pid) return;
    if (process.platform === 'win32') killTree(proc.pid, sig); // cmd.exe 경유 스폰은 직계만 죽이면 CLI 가 남는다
    else { try { proc.kill(sig); } catch (_) { /* 이미 죽음 */ } }
  }

  return {
    get pid() { return proc.pid || null; },
    ready: spawned,
    alive: () => !exited,
    send({ text, uuid }) {
      return write({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
        ...(uuid ? { uuid } : {}),
      });
    },
    // decision = { behavior:'allow', updatedInput, updatedPermissions? } | { behavior:'deny', message }
    respond(rid, decision) {
      return write({ type: 'control_response', response: { subtype: 'success', request_id: rid, response: decision } });
    },
    interrupt() { parser.noteInterrupt(); return control({ subtype: 'interrupt' }); },
    setMode(mode) { return control({ subtype: 'set_permission_mode', mode }); },
    setModel(model) { return control({ subtype: 'set_model', model }); },
    // 2026-10-02 실측: apply_flag_settings{effortLevel} → success. 이후 턴부터 적용.
    setEffort(effort) { return control({ subtype: 'apply_flag_settings', settings: { effortLevel: String(effort) } }); },
    /** stdin 을 닫아 스스로 끝나게 하고, graceMs 뒤에도 살아 있으면 SIGTERM, 그래도 남으면 SIGKILL. */
    stop({ graceMs = 3000 } = {}) {
      if (exited) return Promise.resolve();
      if (stopping) return stopping;
      stopping = new Promise((resolve) => {
        const done = () => { clearTimeout(t1); clearTimeout(t2); resolve(); };
        proc.once('close', done);
        proc.once('error', done);
        try { proc.stdin.end(); } catch (_) { /* noop */ }
        const t1 = setTimeout(() => kill('SIGTERM'), graceMs);
        const t2 = setTimeout(() => kill('SIGKILL'), graceMs + KILL_AFTER_TERM_MS);
        if (exited) done();
      });
      return stopping;
    },
    /** 종료 경로 전용(동기) — 기다릴 수 없을 때 신호만 보낸다. */
    killNow() { stopping = stopping || Promise.resolve(); kill('SIGTERM'); },
  };
}

// ── 어댑터 ───────────────────────────────────────────────────────────────────
function label() {
  try { const hit = agents().CATALOG.find((a) => a.id === 'claude'); return (hit && hit.name) || 'Claude'; } catch (_) { return 'Claude'; }
}

async function locate() {
  // CODINGPT_CLAUDE_BIN — agent.js 와 같은 주입점(테스트의 가짜 CLI, 비표준 설치 위치).
  const forced = process.env.CODINGPT_CLAUDE_BIN;
  if (forced) return { bin: forced, version: null };
  let bin = null;
  try { bin = await agents().resolveBin('claude'); } catch (_) { bin = null; }
  if (!bin) return null;
  let version = null;
  try { version = agents()._internals.probeVersion(bin) || null; } catch (_) { version = null; }
  return { bin, version };
}

async function loginState() {
  if (process.env.CODINGPT_CLAUDE_BIN) return null; // 주입된 실행 파일은 판정하지 않는다(실행해 보고 안다)
  try { return await agents().loginStatus('claude'); } catch (_) { return null; }
}

// 세션 파일 — CLI 는 자기가 본 cwd 로 폴더 이름을 짓는다. 심링크 경로로 열었을 수도 있어 둘 다 본다.
function sessionFile(absCwd, sessionId) {
  const t = transcript();
  const tries = [absCwd];
  try { const real = fs.realpathSync(absCwd); if (real !== absCwd) tries.push(real); } catch (_) { /* 없는 폴더 */ }
  for (const cwd of tries) {
    const guess = path.join(t.projectDirOf(cwd), String(sessionId) + '.jsonl');
    try {
      const safe = t.safeTranscriptPath(guess, t.projectsRoot());
      if (fs.existsSync(safe)) return safe;
    } catch (_) { /* jail 밖·폴더 없음 */ }
  }
  return null;
}

/** 세션 파일 한 줄 → 메시지. ctx.blockIdx(message.id) 가 블록 인덱스를 이어 센다. */
function importLine(o, ctx) {
  if (!o || typeof o !== 'object') return [];
  if (o.type !== 'assistant' && o.type !== 'user' && o.type !== 'system') return [];
  let blockIdx = 0;
  if (o.type === 'assistant') blockIdx = ctx.blockIdx((o.message && o.message.id) || o.uuid || 'm');
  return toMsgs(o, { blockIdx, textCap: ctx.textCap || TEXT_CAP })
    .filter((m) => !(m.hidden && IMPORT_DROP_KINDS.has(m.kind)));
}

/** 이 폴더에서 진행된 세션 목록(최신순) — 우리 색인에 없는 대화를 목록에 보여 줄 때 쓴다. */
async function sessions(absCwd, limit) {
  const t = transcript();
  const out = [];
  for (const c of await t.candidatesFor(absCwd, { limit })) {
    let meta = null;
    try { meta = await t.metaOf(c.file); } catch (_) { meta = null; }
    out.push({ id: c.sessionId, title: (meta && meta.title) || '', lastAt: Math.floor(c.mtimeMs), mode: (meta && meta.permissionMode) || null });
  }
  return out;
}

// 터미널에서 이어 갈 때의 인자 — 클라는 실행 파일을 뺀 이 인자만 기존 에이전트 실행 경로에 넘긴다(§4.4).
function resumeArgs(sessionId) { return ['--resume', String(sessionId)]; }

function resumeCommand(sessionId) {
  let bin = 'claude';
  try { bin = agents().launchCommand('claude') || 'claude'; } catch (_) { bin = 'claude'; }
  return [bin, ...resumeArgs(sessionId)].join(' ');
}

module.exports = {
  id: 'claude',
  modes: MODES.slice(),
  // 모델 별칭 — CLI 가 --model/set_model 로 받는 공식 별칭(최신 버전으로 풀린다). 2026-09-30 실측: 턴 사이 set_model haiku
  //  → control success, 다음 init·assistant 가 claude-haiku-4-5 로 바뀜. 목록이 비면 클라는 모델 선택을 숨긴다.
  models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }],
  label, locate, loginState, sessionFile, sessions, importLine, resumeCommand, resumeArgs, start, buildEnv,
  createParser, argsFor, toMsgs, contextTokensOf, modelUsageOf, rateOf,
  TEXT_CAP, COALESCE_MS,
};
