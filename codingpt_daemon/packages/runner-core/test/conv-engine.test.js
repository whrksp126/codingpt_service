'use strict';
// 채팅 v2 claude 어댑터(conv-engine-claude.js)의 stdout 파서 — 실제 CLI(2.1.284) 캡처를 그대로 먹인다.
//  픽스처: test/fixtures/conv/p-*.ndjson (탐침으로 받은 stdout 원본에서 init 의 큰 목록·개인 경로만 줄인 것).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-convengine-')));
const runtime = require('../runtime');
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: path.join(ROOT, '.claude') });
const engine = require('../conv-engine-claude');

const FIX = path.join(__dirname, 'fixtures', 'conv');
function replay(name, opts) {
  const events = [];
  const parser = engine.createParser((ev) => events.push(ev), { coalesceMs: 0, ...(opts || {}) });
  for (const line of fs.readFileSync(path.join(FIX, name + '.ndjson'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.type === 'control_request' || o.type === 'control_response') continue; // 프로세스 쪽이 가로채는 줄
    parser.feed(o);
  }
  parser.flush();
  return events;
}
const of = (events, type) => events.filter((e) => e.type === type);
const msgsOf = (events) => of(events, 'msgs').flatMap((e) => e.msgs);

test('init 은 턴마다 온다 — 두 턴 캡처에서 두 번, 두 번째는 바뀐 모드를 싣는다', () => {
  const ev = replay('p-mode');
  const inits = of(ev, 'init');
  assert.strictEqual(inits.length, 2);
  assert.strictEqual(inits[0].mode, 'default');
  assert.strictEqual(inits[1].mode, 'acceptEdits');
  assert.ok(inits[0].terminalCommands.includes('doctor'));
  assert.deepStrictEqual(of(ev, 'mode').map((e) => e.mode), ['acceptEdits']);
  assert.strictEqual(of(ev, 'result').length, 2);
});

test('도달 확인 — isReplay 줄은 ack 가 되고 메시지로는 나가지 않는다', () => {
  const ev = replay('p-allow');
  const acks = of(ev, 'ack');
  assert.strictEqual(acks.length, 1);
  assert.match(acks[0].text, /a\.txt/);
  assert.ok(acks[0].uuid);
  assert.ok(!msgsOf(ev).some((m) => m.role === 'user' && m.kind === 'text'));
});

test('델타 key = message id + 블록 인덱스, 완성 메시지의 key 와 일치한다', () => {
  const ev = replay('p-deny');
  const deltas = of(ev, 'delta');
  const msgs = msgsOf(ev);
  assert.ok(deltas.length > 0);
  for (const key of new Set(deltas.map((d) => d.key))) {
    assert.match(key, /^msg_[A-Za-z0-9]+:\d+$/);
    assert.ok(msgs.some((m) => m.key === key), `완성 메시지가 없는 초안 key: ${key}`);
  }
  // 두 번째 응답은 생각(0) + 텍스트(1) — 같은 message id 의 두 줄이 서로 다른 인덱스를 얻는다.
  const thinking = msgs.find((m) => m.kind === 'thinking');
  const text = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
  assert.ok(thinking && text);
  const [idA, a] = thinking.key.split(':');
  const [idB, b] = text.key.split(':');
  assert.strictEqual(idA, idB);
  assert.deepStrictEqual([a, b], ['0', '1']);
});

test('델타 off — 같은 key 안에서 끊김 없이 이어지고 합치면 완성 본문이다', () => {
  for (const name of ['p-allow', 'p-ask', 'p-deny']) {
    const ev = replay(name);
    const acc = new Map();
    const done = new Set();
    for (const e of ev) {
      if (e.type === 'delta') {
        assert.ok(!done.has(e.key), '완성된 뒤에 온 조각');
        const cur = acc.get(e.key) || '';
        assert.strictEqual(e.off, cur.length, `${name} ${e.key} off`);
        acc.set(e.key, cur + e.text);
      } else if (e.type === 'msgs') {
        for (const m of e.msgs) {
          if (!acc.has(m.key)) continue;
          done.add(m.key);
          if (m.kind === 'text') assert.strictEqual(acc.get(m.key), m.text, `${name} ${m.key} 본문`);
        }
      }
    }
    assert.ok(acc.size > 0, name);
  }
});

test('생각 블록 — 본문이 비어 와도 시작을 알리는 빈 조각이 먼저 나간다', () => {
  const ev = replay('p-interrupt');
  const first = of(ev, 'delta').find((d) => d.kind === 'thinking');
  assert.ok(first);
  assert.strictEqual(first.off, 0);
  assert.strictEqual(first.text, '');
});

test('도구 = tool_use id, 결과 = r:+id — 서로 짝지을 수 있다', () => {
  const ev = replay('p-allow');
  const msgs = msgsOf(ev);
  const use = msgs.find((m) => m.kind === 'tool_use');
  const res = msgs.find((m) => m.kind === 'tool_result');
  assert.match(use.key, /^toolu_/);
  assert.strictEqual(use.tool.name, 'Write');
  assert.strictEqual(res.key, 'r:' + use.key);
  assert.strictEqual(res.result.ok, true);
  assert.ok(!('seq' in use), 'v1 seq 는 떼어 낸다(저장소가 매긴다)');
});

test('거부된 도구 — 결과가 실패로 표시된다', () => {
  const res = msgsOf(replay('p-deny')).find((m) => m.kind === 'tool_result');
  assert.strictEqual(res.result.ok, false);
});

test('질문 — AskUserQuestion 은 question 메시지가 된다', () => {
  const q = msgsOf(replay('p-ask')).find((m) => m.kind === 'question');
  assert.ok(q);
  assert.strictEqual(q.questions.length, 1);
  assert.deepStrictEqual(q.questions[0].options.map((o) => o.label), ['빨강', '파랑']);
});

test('중단 — result 에 result 필드가 없어도 끝난 턴으로 읽고, 중단 표식 줄은 접는다', () => {
  const ev = replay('p-interrupt');
  const r = of(ev, 'result')[0];
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.text, '');
  const mark = msgsOf(ev).find((m) => m.role === 'user' && /interrupted/.test(m.text));
  assert.ok(mark);
  assert.strictEqual(mark.kind, 'interrupt');
  assert.strictEqual(mark.hidden, true);
  assert.match(mark.key, /^u:/);
});

test('result — 비용·사용량·컨텍스트 크기를 싣는다', () => {
  const r = of(replay('p-allow'), 'result')[0];
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.interrupted, false);
  assert.ok(r.costUsd > 0);
  assert.ok(r.usage.output > 0);
  assert.strictEqual(r.contextMax, 1000000);
  assert.ok(r.contextTokens > 0);
  assert.ok(r.durationMs > 0);
});

test('사용량 — 컨텍스트는 마지막 API 호출 하나(합계인 result.usage 가 아님), 창 크기는 modelUsage.contextWindow', () => {
  const ev = replay('p-mode');
  const results = of(ev, 'result');
  // 실측: 턴마다 마지막 호출 = input 2 + cache_creation + cache_read + 최종 output(message_delta)
  assert.strictEqual(results[0].contextTokens, 2 + 285 + 26658 + 5);
  assert.strictEqual(results[1].contextTokens, 2 + 284 + 27300 + 5);
  for (const r of results) {
    assert.strictEqual(r.contextMax, 1000000);
    assert.strictEqual(r.model, 'claude-fable-5-1');
    assert.ok(r.contextTokens < 81243, 'result.usage(턴 합계)를 컨텍스트로 쓰지 않는다');
  }
  assert.strictEqual(results[1].costUsd, 0.38621399999999995, '비용은 세션 누적 그대로');
  // 턴 중간에도 컨텍스트가 바뀔 때마다 usage 이벤트가 나간다(같은 값은 다시 안 낸다)
  const us = of(ev, 'usage');
  assert.ok(us.length >= 4);
  us.forEach((u, i) => { if (i) assert.notStrictEqual(u.contextTokens, us[i - 1].contextTokens); });
  assert.strictEqual(us[0].model, 'claude-fable-5-1');
  assert.strictEqual(us[us.length - 1].contextTokens, results[1].contextTokens);
});

test('사용량 — modelUsage 에서 메인 모델 항목을 고르고, 창 크기가 없으면 null(모델 id 로 추정하지 않는다)', () => {
  const mu = {
    'claude-haiku-x': { inputTokens: 900000, contextWindow: 200000 },
    'claude-main-y': { inputTokens: 10, contextWindow: 1000000 },
  };
  assert.strictEqual(engine.modelUsageOf(mu, 'claude-main-y').entry.contextWindow, 1000000);
  assert.strictEqual(engine.modelUsageOf({ 'a[1m]': { canonicalModel: 'a', contextWindow: 5 } }, 'a').entry.contextWindow, 5);
  assert.strictEqual(engine.modelUsageOf({ only: { contextWindow: 7 } }, null).model, 'only');
  assert.strictEqual(engine.modelUsageOf(mu, null).model, 'claude-haiku-x', '모르면 가장 많이 쓴 항목');
  assert.strictEqual(engine.modelUsageOf(null, 'x'), null);

  const events = [];
  const parser = engine.createParser((e) => events.push(e), { coalesceMs: 0 });
  parser.feed({ type: 'system', subtype: 'init', model: 'm-1', permissionMode: 'default' });
  parser.feed({ type: 'assistant', message: { id: 'msg_1', model: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 1 } }, uuid: 'u1' });
  // 서브에이전트 응답은 메인 컨텍스트가 아니다
  parser.feed({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'msg_2', model: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 99999 } }, uuid: 'u2' });
  parser.feed({ type: 'result', subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.5, modelUsage: { 'm-1': { inputTokens: 5 } } });
  const r = of(events, 'result')[0];
  assert.strictEqual(r.contextTokens, 6);
  assert.strictEqual(r.contextMax, null);
  assert.strictEqual(r.model, 'm-1');
  assert.deepStrictEqual(of(events, 'usage').map((u) => u.contextTokens), [6]);
});

test('사용 한도 — 실측 allowed 는 차단이 아니고, 경고(allowed_*)도 차단이 아니다. rejected·그 밖의 값만 차단', () => {
  const rs = of(replay('p-allow'), 'rate');
  assert.ok(rs.length >= 1);
  for (const r of rs) {
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.status, 'allowed');
    assert.strictEqual(r.kind, 'five_hour');
    assert.ok(r.utilization > 0 && r.utilization < 1, 'unifiedWindows[rateLimitType].utilization');
    assert.strictEqual(r.resetsAt, 1790702400);
  }
  assert.strictEqual(engine.rateOf({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 }).blocked, false);
  assert.strictEqual(engine.rateOf({ status: 'allowed_warning', utilization: 0.8 }).utilization, 0.8);
  assert.strictEqual(engine.rateOf({ status: 'rejected' }).blocked, true);
  assert.strictEqual(engine.rateOf({ status: 'blocked_somehow' }).blocked, true);
});

test('코얼레싱 — 50ms 창 안의 조각은 한 프레임으로 합쳐진다', async () => {
  const events = [];
  const parser = engine.createParser((ev) => events.push(ev), { coalesceMs: 50 });
  const se = (event) => parser.feed({ type: 'stream_event', event, parent_tool_use_id: null });
  se({ type: 'message_start', message: { id: 'msg_A' } });
  se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const t of ['가', '나', '다', '라']) se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
  assert.strictEqual(events.length, 0, '창이 닫히기 전에는 나가지 않는다');
  await new Promise((r) => setTimeout(r, 90));
  assert.deepStrictEqual(events, [{ type: 'delta', key: 'msg_A:0', kind: 'text', off: 0, text: '가나다라' }]);
  se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '마' } });
  // 완성 줄이 오면 남은 조각을 먼저 비운다(초안 → 완성 순서).
  parser.feed({ type: 'assistant', message: { id: 'msg_A', role: 'assistant', content: [{ type: 'text', text: '가나다라마' }] }, parent_tool_use_id: null, uuid: 'u1' });
  assert.deepStrictEqual(events.slice(1).map((e) => e.type), ['delta', 'msgs']);
  assert.strictEqual(events[1].off, 4);
  assert.strictEqual(events[2].msgs[0].key, 'msg_A:0');
  parser.dispose();
});

test('서브에이전트 — parent 를 싣고, 메인 스트림의 블록 인덱스를 흩뜨리지 않는다', () => {
  const events = [];
  const parser = engine.createParser((ev) => events.push(ev), { coalesceMs: 0 });
  const se = (event) => parser.feed({ type: 'stream_event', event, parent_tool_use_id: null });
  se({ type: 'message_start', message: { id: 'msg_M' } });
  se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} } });
  parser.feed({ type: 'assistant', message: { id: 'msg_M', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] }, parent_tool_use_id: null, uuid: 'a' });
  se({ type: 'content_block_stop', index: 0 });
  parser.feed({ type: 'assistant', message: { id: 'msg_S', content: [{ type: 'text', text: '하위 1' }] }, parent_tool_use_id: 'toolu_1', uuid: 'b' });
  parser.feed({ type: 'assistant', message: { id: 'msg_S', content: [{ type: 'text', text: '하위 2' }] }, parent_tool_use_id: 'toolu_1', uuid: 'c' });
  const msgs = msgsOf(events);
  assert.deepStrictEqual(msgs.map((m) => m.key), ['toolu_1', 'msg_S:0', 'msg_S:1']);
  assert.strictEqual(msgs[1].parent, 'toolu_1');
  assert.strictEqual(msgs[1].isSidechain, true);
  assert.ok(!msgs[0].parent);
});

test('본문 상한 — v2 는 64KB, v1 normalize 는 4096 그대로', () => {
  const transcript = require('../transcript');
  const body = 'x'.repeat(70 * 1024);
  const line = { type: 'assistant', message: { id: 'msg_B', content: [{ type: 'text', text: body }] }, uuid: 'u', parent_tool_use_id: null };
  const [m] = engine.toMsgs(line, { blockIdx: 0 });
  assert.strictEqual(m.text.length, 64 * 1024);
  assert.strictEqual(m.truncated, true);
  const [v1] = transcript.normalize(line, 0);
  assert.strictEqual(v1.text.length, 4096);
  const [mid] = engine.toMsgs({ ...line, message: { id: 'msg_C', content: [{ type: 'text', text: 'y'.repeat(5000) }] } }, { blockIdx: 0 });
  assert.strictEqual(mid.truncated, false);
  // v2 호출 뒤에도 v1 의 상한은 돌아와 있어야 한다.
  assert.strictEqual(transcript.normalize(line, 0)[0].text.length, 4096);
});

test('기동 인자 — 새 세션은 --session-id, 이어받기는 --resume, --bare 는 쓰지 않는다', () => {
  const a = engine.argsFor({ sessionId: 'S', resume: false, mode: 'plan', model: 'm1' });
  assert.deepStrictEqual(a.slice(a.indexOf('--permission-prompt-tool'), a.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  assert.deepStrictEqual(a.slice(a.indexOf('--session-id')), ['--session-id', 'S', '--model', 'm1']);
  assert.deepStrictEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  for (const f of ['-p', '--verbose', '--include-partial-messages', '--replay-user-messages']) assert.ok(a.includes(f), f);
  const b = engine.argsFor({ sessionId: 'S', resume: true, mode: 'nonsense' });
  assert.ok(b.includes('--resume') && !b.includes('--session-id'));
  assert.strictEqual(b[b.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!a.includes('--bare') && !b.includes('--bare'));
});

test('환경 — 터미널 좌표·중첩 세션 표식을 넘기지 않고 훅을 끈다', async () => {
  const keep = { ...process.env };
  Object.assign(process.env, { TMUX: '/tmp/x', CPT_WS: 'ws', CPT_TID: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/keep' });
  try {
    const env = await engine.buildEnv();
    for (const k of ['TMUX', 'CPT_WS', 'CPT_TID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) assert.strictEqual(env[k], undefined, k);
    assert.strictEqual(env.CPT_HOOKS_DISABLED, '1');
    assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/keep', '사용자가 고른 설정은 건드리지 않는다');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('/compact 요약("This session is being continued…")은 사람이 한 말이 아니다 — 접는다(2026-10 QA)', () => {
  const sum = engine.toMsgs({ type: 'user', uuid: 'u-sum', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers…' } }, { blockIdx: 0 });
  assert.strictEqual(sum.length, 1);
  assert.strictEqual(sum[0].kind, 'compact');
  assert.strictEqual(sum[0].hidden, true);
  // 같은 줄이 아닌 일반 사용자 말은 그대로 보인다.
  const [plain] = engine.toMsgs({ type: 'user', uuid: 'u-1', message: { role: 'user', content: '안녕' } }, { blockIdx: 0 });
  assert.notStrictEqual(plain.hidden, true);
});
