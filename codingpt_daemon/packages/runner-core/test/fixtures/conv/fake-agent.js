#!/usr/bin/env node
/**
 * fake-agent.js — 구조화 모드(stream-json) 에이전트 CLI 흉내(채팅 v2 테스트 전용).
 *
 * 실제 CLI(2.1.284)의 stdout 순서를 그대로 따른다(test/fixtures/conv/p-*.ndjson 이 실측 원본):
 *   init → status → user(isReplay) → message_start → content_block_start → delta… → assistant(블록 1개당 1줄,
 *   **content_block_stop 앞**) → content_block_stop → message_delta → message_stop → [control_request…] → result
 *
 * 시나리오는 사용자 메시지의 첫 단어가 고른다:
 *   say <글>        평범한 턴(텍스트를 3자씩 델타로)
 *   think <글>      생각 블록(빈 본문) + 텍스트 블록 — 같은 message id, 인덱스 0·1
 *   write <파일>    파일 쓰기 승인 요청(제안 = setMode acceptEdits) → 허용/거부에 따라 결과
 *   rule <명령>     Bash 승인 요청(제안 = addRules)
 *   ask             질문(AskUserQuestion) → 답을 되읽는다
 *   sleep <ms>      도구 실행 중인 긴 턴(중단·턴 중 추가 입력용)
 *   sub             서브에이전트 메시지(parent_tool_use_id) 포함
 *   big <n>         n 자짜리 텍스트
 *   fail            실패로 끝나는 턴(is_error)
 *   die             턴 도중 비정상 종료(exit 3 + stderr)
 *   diereq          승인 요청을 낸 채 비정상 종료
 *
 * 환경변수:
 *   FAKE_ARGS_LOG        기동 인자·환경 일부를 한 줄 JSON 으로 덧붙일 파일
 *   FAKE_START_DELAY_MS  첫 출력까지 뜸 들이는 시간(느린 기동)
 *   FAKE_NO_UUID_ECHO=1  도달 확인에 보낸 uuid 를 되돌리지 않는다(순서 짝짓기 경로)
 *   FAKE_SESSION_DIR     세션 파일을 흉내 내 쓸 폴더(<dir>/<sessionId>.jsonl, stdout 과 같은 uuid)
 *   FAKE_EXIT_AT_START   이 코드로 즉시 종료(기동 직후 죽는 CLI)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const sessionId = argOf('--resume') || argOf('--session-id') || crypto.randomUUID();
let mode = argOf('--permission-mode') || 'default';
const model = argOf('--model') || 'fake-model-1';

if (process.env.FAKE_ARGS_LOG) {
  try {
    fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify({
      pid: process.pid, argv, cwd: process.cwd(),
      env: {
        TMUX: process.env.TMUX || null, CPT_WS: process.env.CPT_WS || null,
        CPT_HOOKS_DISABLED: process.env.CPT_HOOKS_DISABLED || null, CLAUDECODE: process.env.CLAUDECODE || null,
      },
    }) + '\n');
  } catch (_) { /* noop */ }
}
if (process.env.FAKE_EXIT_AT_START) {
  process.stderr.write('No conversation found with session ID: ' + sessionId + '\n');
  process.exit(parseInt(process.env.FAKE_EXIT_AT_START, 10) || 1);
}

const uid = () => crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const persist = (o) => {
  if (!process.env.FAKE_SESSION_DIR) return;
  try {
    fs.mkdirSync(process.env.FAKE_SESSION_DIR, { recursive: true });
    const { session_id, parent_tool_use_id, tool_use_result, isReplay, ...rest } = o;
    const line = { ...rest, sessionId, cwd: process.cwd(), isSidechain: false, ...(tool_use_result !== undefined ? { toolUseResult: tool_use_result } : {}) };
    fs.appendFileSync(path.join(process.env.FAKE_SESSION_DIR, sessionId + '.jsonl'), JSON.stringify(line) + '\n');
  } catch (_) { /* noop */ }
};

let msgSeq = 0;
let toolSeq = 0;
const waiting = new Map();   // request_id → resolve(response)
const queue = [];            // 아직 읽지 않은 사용자 메시지
let turning = false;
let aborted = false;
let wake = null;             // sleep 을 깨우는 함수(중단)

function init() {
  out({
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model, permissionMode: mode,
    slash_commands: ['compact', 'context', 'review', 'doctor', 'color'], terminal_slash_commands: ['doctor', 'color'],
    claude_code_version: '0.0.0-fake', uuid: uid(),
  });
  out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: uid() });
}

function se(event, ptu = null) { out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: ptu, uuid: uid() }); }

// 한 메시지 = 블록 여러 개. 완성 줄은 블록마다 따로, 같은 message.id 로 나간다.
async function message(blocks, { stop = 'end_turn' } = {}) {
  const id = 'msg_fake' + String(++msgSeq).padStart(4, '0');
  const usage = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 20 };
  se({ type: 'message_start', message: { model, id, type: 'message', role: 'assistant', content: [], usage } });
  for (let i = 0; i < blocks.length; i++) {
    if (aborted) return id;
    const b = blocks[i];
    if (b.type === 'text') {
      se({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      const chars = Array.from(b.text);
      for (let k = 0; k < chars.length; k += 3) {
        se({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: chars.slice(k, k + 3).join('') } });
        if (b.pace) await sleep(b.pace);
        if (aborted) return id;
      }
    } else if (b.type === 'thinking') {
      se({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
      se({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } });
      se({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'c2ln' } });
    } else if (b.type === 'tool_use') {
      se({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      se({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    const content = b.type === 'thinking' ? { type: 'thinking', thinking: '', signature: 'c2ln' }
      : (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input });
    const line = {
      type: 'assistant', message: { model, id, type: 'message', role: 'assistant', content: [content], stop_reason: null, usage },
      parent_tool_use_id: null, session_id: sessionId, uuid: uid(), timestamp: new Date().toISOString(),
    };
    out(line);
    persist(line);
    se({ type: 'content_block_stop', index: i });
  }
  se({ type: 'message_delta', delta: { stop_reason: stop }, usage });
  se({ type: 'message_stop' });
  return id;
}

function toolResult(toolUseId, text, isError, extra) {
  const line = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}), tool_use_id: toolUseId }] },
    parent_tool_use_id: null, session_id: sessionId, uuid: uid(), timestamp: new Date().toISOString(),
    tool_use_result: extra === undefined ? text : extra,
  };
  out(line);
  persist(line);
}

function ask(tool, input, toolUseId, more) {
  const request_id = uid();
  out({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: toolUseId, ...more } });
  return new Promise((resolve) => waiting.set(request_id, resolve));
}

function result(text, extra = {}) {
  out({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 12, num_turns: 1, session_id: sessionId,
    total_cost_usd: 0.01, stop_reason: 'end_turn', terminal_reason: 'completed', uuid: uid(),
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 20 },
    modelUsage: { [model]: { contextWindow: 200000, costUSD: 0.01 } },
    ...(text == null ? {} : { result: text }),
    ...extra,
  });
}

async function turn(u) {
  aborted = false;
  init();
  const text = u.text;
  const replay = {
    type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, session_id: sessionId, parent_tool_use_id: null,
    uuid: (!process.env.FAKE_NO_UUID_ECHO && u.uuid) || uid(), timestamp: new Date().toISOString(), isReplay: true,
  };
  out(replay);
  persist(replay);
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  const interrupted = () => {
    const line = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: sessionId, uuid: uid(), timestamp: new Date().toISOString() };
    out(line);
    // 중단된 턴의 result 에는 result 필드가 없다(실측).
    result(null, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', stop_reason: 'tool_use', errors: ['aborted'] });
  };

  switch (cmd) {
    case 'think': {
      await message([{ type: 'thinking' }, { type: 'text', text: arg || '생각 끝' }]);
      result(arg || '생각 끝');
      return;
    }
    case 'write': case 'rule': {
      const id = 'toolu_fake' + (++toolSeq);
      const input = cmd === 'write' ? { file_path: path.join(process.cwd(), arg || 'a.txt'), content: 'hello\n' } : { command: arg || 'ls', description: '목록 보기' };
      const tool = cmd === 'write' ? 'Write' : 'Bash';
      await message([{ type: 'tool_use', id, name: tool, input }], { stop: 'tool_use' });
      const res = await ask(tool, input, id, {
        description: arg,
        permission_suggestions: cmd === 'write'
          ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
          : [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: (arg || 'ls') + ':*' }], behavior: 'allow', destination: 'localSettings' }],
      });
      if (aborted) return interrupted();
      if (res.behavior === 'allow') {
        if (Array.isArray(res.updatedPermissions)) {
          const m = res.updatedPermissions.find((s) => s && s.type === 'setMode');
          if (m) { mode = m.mode; out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: uid() }); }
        }
        if (cmd === 'write') { try { fs.writeFileSync(res.updatedInput.file_path, res.updatedInput.content); } catch (_) { /* noop */ } }
        toolResult(id, cmd === 'write' ? 'File created successfully' : 'a.txt', false, cmd === 'write' ? { type: 'create', filePath: input.file_path, content: 'hello\n', structuredPatch: [] } : undefined);
        await message([{ type: 'text', text: `완료${res.updatedPermissions ? '(항상 허용)' : ''}.` }]);
        result('완료.');
      } else {
        toolResult(id, res.message || 'denied', true, 'Error: ' + (res.message || 'denied'));
        await message([{ type: 'text', text: '거부되어 중단했습니다.' }]);
        result('거부되어 중단했습니다.', { permission_denials: [{ tool_name: tool, tool_use_id: id }] });
      }
      return;
    }
    case 'ask': {
      const id = 'toolu_fake' + (++toolSeq);
      const input = { questions: [{ question: '좋아하는 색은 무엇인가요?', header: '색', multiSelect: false, options: [{ label: '빨강', description: '빨간색' }, { label: '파랑', description: '파란색' }] }] };
      await message([{ type: 'tool_use', id, name: 'AskUserQuestion', input }], { stop: 'tool_use' });
      const res = await ask('AskUserQuestion', input, id, { requires_user_interaction: true });
      if (aborted) return interrupted();
      if (res.behavior !== 'allow') {
        toolResult(id, res.message || 'declined', true);
        await message([{ type: 'text', text: '답을 받지 못했습니다.' }]);
        result('답을 받지 못했습니다.');
        return;
      }
      const a = (res.updatedInput && res.updatedInput.answers) || {};
      const picked = Object.entries(a).map(([q, v]) => `"${q}"="${v}"`).join(', ');
      toolResult(id, `Your questions have been answered: ${picked}.`, false, { questions: input.questions, answers: a });
      await message([{ type: 'text', text: `답: ${Object.values(a).join(', ')}` }]);
      result(`답: ${Object.values(a).join(', ')}`);
      return;
    }
    case 'sleep': {
      const id = 'toolu_fake' + (++toolSeq);
      await message([{ type: 'text', text: '기다립니다.', pace: 0 }, { type: 'tool_use', id, name: 'Bash', input: { command: 'sleep ' + (arg || '1000'), description: '대기' } }], { stop: 'tool_use' });
      await new Promise((resolve) => {
        const t = setTimeout(() => { wake = null; resolve(); }, parseInt(arg, 10) || 1000);
        wake = () => { clearTimeout(t); wake = null; resolve(); };
      });
      if (aborted) return interrupted();
      toolResult(id, '', false);
      await message([{ type: 'text', text: '기다림 끝.' }]);
      result('기다림 끝.');
      return;
    }
    case 'sub': {
      const id = 'toolu_fake' + (++toolSeq);
      await message([{ type: 'tool_use', id, name: 'Agent', input: { description: '조사', prompt: '조사해' } }], { stop: 'tool_use' });
      out({
        type: 'assistant', message: { model, id: 'msg_sub0001', type: 'message', role: 'assistant', content: [{ type: 'text', text: '서브에이전트의 말' }] },
        parent_tool_use_id: id, session_id: sessionId, uuid: uid(), timestamp: new Date().toISOString(),
      });
      toolResult(id, '조사 끝', false);
      await message([{ type: 'text', text: '정리했습니다.' }]);
      result('정리했습니다.');
      return;
    }
    case 'big': {
      const body = 'x'.repeat(parseInt(arg, 10) || 1000);
      const id = 'msg_fake' + String(++msgSeq).padStart(4, '0');
      se({ type: 'message_start', message: { model, id, type: 'message', role: 'assistant', content: [] } });
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: body } });
      const line = { type: 'assistant', message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text: body }] }, parent_tool_use_id: null, session_id: sessionId, uuid: uid(), timestamp: new Date().toISOString() };
      out(line);
      persist(line);
      se({ type: 'content_block_stop', index: 0 });
      se({ type: 'message_stop' });
      result('big');
      return;
    }
    case 'fail':
      result('API Error: 서버가 응답하지 않습니다', { subtype: 'error_during_execution', is_error: true, terminal_reason: 'error' });
      return;
    case 'die':
      await message([{ type: 'text', text: '죽기 직전', pace: 0 }]);
      process.stderr.write('fatal: something broke API_KEY=sk-secret1234567890\n');
      process.exit(3);
      return;
    case 'diereq': {
      const id = 'toolu_fake' + (++toolSeq);
      await message([{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }], { stop: 'tool_use' });
      ask('Bash', { command: 'ls' }, id, {});
      await sleep(80);
      process.stderr.write('fatal: crashed while waiting\n');
      process.exit(4);
      return;
    }
    default: {
      const body = cmd === 'say' ? (arg || '안녕하세요') : `받았습니다: ${text}`;
      await message([{ type: 'text', text: body, pace: parseInt(process.env.FAKE_PACE_MS || '0', 10) }]);
      if (aborted) return interrupted();
      result(body);
    }
  }
}

async function pump() {
  if (turning) return;
  turning = true;
  while (queue.length) {
    const u = queue.shift();
    try { await turn(u); } catch (e) { process.stderr.write('fake-agent: ' + (e && e.stack || e) + '\n'); }
  }
  turning = false;
}

function onLine(line) {
  if (!line.trim()) return;
  let o = null;
  try { o = JSON.parse(line); } catch (_) { return; }
  if (o.type === 'user') {
    const c = o.message && o.message.content;
    const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('') : '');
    queue.push({ text, uuid: o.uuid || null });
    pump();
    return;
  }
  if (o.type === 'control_response') {
    const r = o.response || {};
    const w = waiting.get(r.request_id);
    out(o); // 실제 CLI 도 받은 응답을 stdout 에 되돌린다(실측)
    if (w) { waiting.delete(r.request_id); w(r.response || {}); }
    return;
  }
  if (o.type === 'control_request') {
    const r = o.request || {};
    if (r.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { still_queued: [] } } });
      if (turning) {
        aborted = true;
        if (wake) wake();
        for (const [id, w] of waiting) { waiting.delete(id); out({ type: 'control_cancel_request', request_id: id }); w({ behavior: 'deny', message: 'interrupted' }); }
      }
      return;
    }
    if (r.subtype === 'set_permission_mode') {
      mode = r.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: { mode } } });
      out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId, uuid: uid() });
      return;
    }
    if (r.subtype === 'set_model') {
      out({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'unsupported' } });
      return;
    }
    out({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'unknown subtype' } });
  }
}

async function main() {
  const delay = parseInt(process.env.FAKE_START_DELAY_MS || '0', 10);
  let buf = '';
  let ready = !delay;
  const pending = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (ready) onLine(line); else pending.push(line);
    }
  });
  process.stdin.on('end', () => {
    // stdin 이 닫히면 스스로 끝난다(하던 턴은 버린다 — 실제 CLI 도 입력이 끝나면 내려간다).
    if (process.env.FAKE_IGNORE_EOF) return;
    process.exit(0);
  });
  if (process.env.FAKE_IGNORE_EOF) { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); }
  if (delay) { await sleep(delay); ready = true; for (const l of pending.splice(0)) onLine(l); }
}
main();
