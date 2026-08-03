// agent-status — 에이전트 상태를 **공식 채널**에서 받는 경로(2026-08-03 재설계).
//
// 왜 바꿨나(실측 근거, 이 파일이 그 결론을 고정한다):
//  · 종전 원천 = 터미널 화면 3초 capture-pane + 정규식. 유휴 터미널은 내용이 안 바뀌어 **60초에
//    push 0건**이었고(사용자 실터미널 3개 관측), 한 번 놓치면 채팅이 영영 빈칸이었다.
//  · claude 는 `statusLine` 훅으로 **구조화 JSON 을 직접** 준다. 격리 claude 2.1.220 실측:
//    shift+tab 을 누르면 즉시 발화하고, 릴레이를 거쳐 데몬까지 **394ms**(claude 자체 300ms 디바운스 포함).
//  · codex 는 rollout JSONL(우리가 이미 tail 중)에 전부 적는다. shift+tab → **106ms** 만에 기록.
//
// 아래 픽스처는 전부 **실캡처 원문**이다(claude = 격리 프로브 stdin, codex = 사용자 실세션 rollout).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-as-'));
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const A = require('../agent-status');

// ── claude statusLine 훅 페이로드(실측 원문) ─────────────────────────────────
const CLAUDE = {
  session_id: '8bab66b6-c0f3-485e-912d-aca1b8cdf942',
  transcript_path: '/Users/x/.claude/projects/-p/8bab66b6.jsonl',
  cwd: '/p', effort: { level: 'high' },
  session_name: '2 더하기 2 계산',
  model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' },
  version: '2.1.220',
  cost: { total_cost_usd: 0.13749799999999998, total_lines_added: 820, total_lines_removed: 190 },
  context_window: {
    total_input_tokens: 33278, context_window_size: 1000000,
    current_usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 12648, cache_read_input_tokens: 20628 },
    used_percentage: 3, remaining_percentage: 97,
  },
  fast_mode: false, thinking: { enabled: true },
  rate_limits: {
    five_hour: { used_percentage: 8, resets_at: 1785762600 },
    seven_day: { used_percentage: 2, resets_at: 1786302000 },
  },
  vim: { mode: 'INSERT' },
};

test('claude 훅 → 정규 상태(우리가 화면에서 긁던 것보다 많고 정확하다)', () => {
  const s = A.fromClaude(CLAUDE);
  assert.strictEqual(s.agent, 'claude');
  assert.strictEqual(s.model, 'Opus 5 (1M context)');
  assert.strictEqual(s.contextPct, 3);
  assert.strictEqual(s.contextMax, 1000000);
  // 컨텍스트 토큰 = input + cache_creation + cache_read (사용자 statusline.sh 와 같은 조합)
  assert.strictEqual(s.contextUsed, 2 + 12648 + 20628);
  assert.deepStrictEqual(s.limits.map((l) => [l.id, l.pct, l.resetsAt]),
    [['five_hour', 8, 1785762600], ['seven_day', 2, 1786302000]]);
  assert.strictEqual(s.costUsd, 0.13749799999999998);
  assert.strictEqual(s.source, 'hook');
});

test('★ 모름은 0 이 아니다 — 값이 없으면 필드를 만들지 않는다', () => {
  // 세션 시작 직후 실측: current_usage/used_percentage 가 null, rate_limits 자체가 없다.
  const s = A.fromClaude({ ...CLAUDE, context_window: { context_window_size: 1000000, current_usage: null, used_percentage: null }, rate_limits: undefined });
  assert.ok(!('contextPct' in s), '0% 로 단정하지 않는다');
  assert.ok(!('contextUsed' in s));
  assert.ok(!('limits' in s));
  assert.strictEqual(s.contextMax, 1000000, '아는 값은 남는다');
});

test('vim.mode 는 권한 모드가 아니다(훅에 권한 모드는 없다)', () => {
  const s = A.fromClaude(CLAUDE);
  assert.ok(!('mode' in s) && !('planMode' in s),
    'claude 권한 모드는 화면이 유일한 즉시 원천이라 여기서 만들지 않는다');
});

// ── codex rollout(사용자 실세션 원문) ────────────────────────────────────────
const TOKEN_COUNT = {
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 342636675, total_tokens: 343405740 },
      last_token_usage: { input_tokens: 8780, output_tokens: 31, total_tokens: 8811 },
      model_context_window: 258400,
    },
    rate_limits: {
      primary: { used_percent: 12, window_minutes: 10080, resets_at: 1786357362 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
    },
  },
};
const THREAD_SETTINGS = {
  payload: {
    type: 'thread_settings_applied',
    thread_settings: {
      model: 'gpt-5.6-sol', model_provider_id: 'openai', service_tier: 'priority',
      approval_policy: 'on-request', reasoning_effort: 'low',
      collaboration_mode: { mode: 'plan', settings: { model: 'gpt-5.6-sol' } },
    },
  },
};

test('codex token_count → 컨텍스트·한도(누적이 아니라 마지막 턴 입력이 점유율이다)', () => {
  const s = A.fromCodexLine(TOKEN_COUNT);
  assert.strictEqual(s.contextUsed, 8780, '누적 3억 토큰이 아니라 마지막 턴 입력');
  assert.strictEqual(s.contextMax, 258400);
  assert.strictEqual(s.contextPct, 3, '화면의 "Context 3% used" 와 일치');
  assert.deepStrictEqual(s.limits, [{ id: 'primary', label: '7일', pct: 12, resetsAt: 1786357362 }]);
});

test('★ codex thread_settings 의 collaboration_mode 가 곧 shift+tab 축이다', () => {
  const s = A.fromCodexLine(THREAD_SETTINGS);
  assert.strictEqual(s.planMode, true);
  assert.strictEqual(s.model, 'gpt-5.6-sol');
  assert.strictEqual(s.effort, 'low');
  assert.strictEqual(s.approvalPolicy, 'on-request');
  assert.strictEqual(A.fromCodexLine({ payload: { type: 'thread_settings_applied', thread_settings: { collaboration_mode: { mode: 'default' } } } }).planMode, false);
});

test('window_minutes → 라벨', () => {
  assert.strictEqual(A.windowLabel(300), '5시간');
  assert.strictEqual(A.windowLabel(10080), '7일');
  assert.strictEqual(A.windowLabel(0), null);
});

test('무관한 rollout 라인은 무시한다', () => {
  assert.strictEqual(A.fromCodexLine({ payload: { type: 'agent_message' } }), null);
  assert.strictEqual(A.fromCodexLine({}), null);
});

// ── 누적·병합·emit ────────────────────────────────────────────────────────────
test('★ 두 종류가 따로 와도 합쳐진다(모름이 기존 값을 지우지 않는다)', () => {
  A.clear();
  const F = '/x/rollout.jsonl';
  A.noteCodexLines(F, [JSON.stringify(TOKEN_COUNT)]);
  A.noteCodexLines(F, [JSON.stringify(THREAD_SETTINGS)]);
  const s = A.get(F);
  assert.strictEqual(s.contextPct, 3, 'token_count 가 준 값이 살아 있다');
  assert.strictEqual(s.planMode, true, 'thread_settings 가 준 값도 함께');
  assert.strictEqual(s.model, 'gpt-5.6-sol');
});

test('★ 상태는 누적 캐시다 — 한 번 알면 계속 준다(push 를 놓쳐도 pull 로 복구)', () => {
  A.clear();
  const F = '/x/r2.jsonl';
  A.noteCodexLines(F, [JSON.stringify(TOKEN_COUNT)]);
  assert.ok(A.get(F));
  // 상태 이벤트가 없는 라인이 아무리 흘러도 기존 값은 사라지지 않는다.
  A.noteCodexLines(F, ['{"type":"response_item","payload":{"type":"message"}}']);
  assert.strictEqual(A.get(F).contextPct, 3);
});

test('값이 그대로면 emit 하지 않는다(프레임 절약)', () => {
  A.clear();
  const seen = [];
  A.setEmitter((file, st) => seen.push([file, st.contextPct]));
  const F = '/x/r3.jsonl';
  A.noteCodexLines(F, [JSON.stringify(TOKEN_COUNT)]);
  A.noteCodexLines(F, [JSON.stringify(TOKEN_COUNT)]);
  assert.strictEqual(seen.length, 1);
  A.setEmitter(null);
});

test('claude 훅은 transcript_path 로 저장된다(tid 를 몰라도 된다)', () => {
  A.clear();
  const f = A.noteClaudeHook(CLAUDE);
  assert.strictEqual(f, CLAUDE.transcript_path);
  assert.strictEqual(A.get(f).model, 'Opus 5 (1M context)');
  assert.strictEqual(A.noteClaudeHook({ model: { id: 'x' } }), null, 'transcript_path 없으면 저장하지 않는다');
});

// ── 대용량 방어 ───────────────────────────────────────────────────────────────
test('상태 이벤트가 아닌 라인은 JSON.parse 조차 하지 않는다(rollout 은 GB 급이다)', () => {
  // 사용자 실파일이 2.4GB 다 — 전 라인 파싱은 불가능하다. 문자열 선검사가 그 방어다.
  A.clear();
  const junk = Array.from({ length: 500 }, (_, i) => `{"type":"response_item","payload":{"type":"message","n":${i}}}`);
  junk.push('{"broken json');
  assert.strictEqual(A.noteCodexLines('/x/r4.jsonl', junk), false, '변화 없음 + 예외 없음');
});

// ── 배선 핀 — 상태 갱신이 화면 재확인 트리거로 이어져야 한다 ────────────────────
test('★ transcript 가 agent-status 갱신을 pokeChat 으로 잇는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'transcript.js'), 'utf8');
  assert.match(src, /agent-status'\)\.setEmitter/);
  assert.match(src, /kind: 'agent_status', status: st/);
  assert.match(src, /require\('\.\/status-line'\)\.pokeChat\(chatId\)/,
    '배선이 빠지면 "훅은 오는데 알약은 3초 늦는" 조용한 퇴행이 된다');
});

// ── turn_context (2026-08-03 실측 정정) ────────────────────────────────────────
// ★ `thread_settings_applied` 는 **설정이 바뀔 때만** 적힌다 — 새 codex 세션의 rollout 14줄에는
//  하나도 없었다(모델·계획모드가 영영 비어 보이던 원인). `turn_context` 는 **매 턴** 기록되고
//  model·effort·approval_policy·collaboration_mode 를 전부 담는다 → 이쪽이 주 원천이다.
//  ⚠ 이 줄만 `{type:'turn_context', payload:{...}}` 로 payload 안에 type 이 없다.
const TURN_CONTEXT = {
  type: 'turn_context',
  payload: {
    turn_id: '019fc808', cwd: '/Users/x/other/project/tokin',
    approval_policy: 'on-request', model: 'gpt-5.6-sol', effort: 'low',
    collaboration_mode: { mode: 'default', settings: { model: 'gpt-5.6-sol' } },
  },
};

test('★ turn_context 에서 모델·추론강도·승인정책·계획모드를 얻는다', () => {
  const s = A.fromCodexLine(TURN_CONTEXT);
  assert.strictEqual(s.model, 'gpt-5.6-sol');
  assert.strictEqual(s.effort, 'low');
  assert.strictEqual(s.approvalPolicy, 'on-request');
  assert.strictEqual(s.planMode, false);
});

test('새 세션(설정 변경 이벤트가 없는)에서도 모델이 채워진다', () => {
  A.clear();
  const F = '/x/fresh.jsonl';
  A.noteCodexLines(F, [JSON.stringify(TURN_CONTEXT), JSON.stringify(TOKEN_COUNT)]);
  const s = A.get(F);
  assert.strictEqual(s.model, 'gpt-5.6-sol', 'thread_settings_applied 없이도');
  assert.strictEqual(s.contextPct, 3);
});

// ── 첫 턴 전 조회(sessionId 색인) ─────────────────────────────────────────────
// claude 훅은 **대화 파일이 생기기 전에도** 온다(transcript_path 는 아직 없는 파일을 가리킨다).
//  그 구간엔 file→chatId 매핑이 없어 조회가 막혔다 → 훅이 함께 주는 session_id 로도 색인한다.
test('★ 첫 턴 전에도 sessionId 로 상태를 찾을 수 있다', () => {
  A.clear();
  A.noteClaudeHook({ ...CLAUDE, session_id: 'sess-1', transcript_path: '/x/not-yet.jsonl' });
  const s = A.getBySession('sess-1');
  assert.ok(s && s.model === 'Opus 5 (1M context)');
  assert.strictEqual(A.getBySession('모르는세션'), null);
  assert.strictEqual(A.getBySession(null), null);
});

test('배선 핀 — 대화 없는 응답 경로도 상태를 싣는다', () => {
  const ts = fs.readFileSync(path.join(__dirname, '..', 'transcript.js'), 'utf8');
  assert.match(ts, /function agentStatusForTerm/);
  assert.match(ts, /agentStatusForTerm\(fsLib\.relOf\(absCwd\), tidNum, adapter\.name\)/,
    'noSession 응답에 상태가 빠지면 새 터미널이 첫 메시지 전까지 옛 모양으로 보인다');
  const cs = fs.readFileSync(path.join(__dirname, '..', 'cpt-server.js'), 'utf8');
  assert.match(cs, /agentStatusForTerm\(cwdRel, win/, 'chat.screen(폴링 경로)도 같이');
});

// ── 사용자가 설정한 콘텐츠를 따른다(2026-08-04 사용자 지적) ─────────────────────
// 종전엔 우리가 항목을 골랐다: claude 사용자 스크립트에 없는 '7일'을 넣고, codex 화면에 있는
//  모델·추론강도·승인정책을 빼먹었다. 표시 내용의 정본은 **사용자 설정**이다.
//   · claude = statusline 스크립트의 **출력 그 자체**(릴레이가 사본을 뜬다 — 해석 불가능하므로)
//   · codex  = `~/.codex/config.toml` 의 `[tui] status_line` 항목 목록(기계가 읽을 수 있다)
const RENDERED = '\x1b[1m\x1b[36m◆ Opus 5 (1M context)\x1b[0m  \x1b[32m███░ 3%\x1b[0m \x1b[90m34k/1.0M\x1b[0m  5h 3%';

test('★ claude 한 줄 요약 = 사용자 스크립트 출력 그대로(ANSI 포함)', () => {
  const s = A.fromClaude(CLAUDE, RENDERED);
  assert.strictEqual(s.line, RENDERED, '재조립하지 않는다');
  assert.strictEqual(s.contextPct, 3, '구조화 값은 상세용으로 그대로 남는다');
});

test('스크립트가 없으면 line 이 없다(그때만 우리 칩 폴백)', () => {
  assert.ok(!('line' in A.fromClaude(CLAUDE)));
  assert.ok(!('line' in A.fromClaude(CLAUDE, '   \n')), '공백뿐이면 줄이 아니다');
});

test('멀티라인 출력은 첫 줄만 미러한다(스트립은 한 줄)', () => {
  assert.strictEqual(A._oneLine('\n\n첫 줄\n둘째 줄\n'), '첫 줄');
  assert.strictEqual(A._oneLine(''), null);
});

test('★ codex 항목 목록을 설정에서 읽는다([tui] 절만)', () => {
  const toml = [
    '[history]', 'status_line = ["절대-읽으면-안-되는-항목"]', '',
    '[tui]', 'status_line = ["model-with-reasoning", "context-used", "fast-mode"]', 'status_line_use_colors = true',
  ].join('\n');
  A.clear();
  assert.deepStrictEqual(A.codexStatusItems(() => toml),
    ['model-with-reasoning', 'context-used', 'fast-mode']);
});

test('★ codex 한 줄 = 설정된 항목·순서 그대로(실측 표기와 글자까지 일치)', () => {
  const st = {
    agent: 'codex', model: 'gpt-5.6-sol', effort: 'low', fast: true, approvalPolicy: 'on-request',
    contextPct: 2, contextUsed: 8780, contextMax: 258400,
  };
  const items = ['model-with-reasoning', 'context-used', 'fast-mode', 'approval-mode', 'context-window-size', 'used-tokens'];
  const line = A.codexLine(st, () => `[tui]\nstatus_line = ${JSON.stringify(items)}\n`);
  // 사용자 실제 TUI 화면(2026-08-04 스크린샷)과 동일해야 한다.
  assert.strictEqual(line,
    'gpt-5.6-sol low fast · Context 2% used · Fast on · Approve for me · 258K window · 8.78K used');
});

test('모르는 값의 칸은 아예 안 만든다(빈 칸으로 자리 차지 금지)', () => {
  const st = { agent: 'codex', contextPct: 7 };
  const line = A.codexLine(st, () => '[tui]\nstatus_line = ["model-with-reasoning","context-used","fast-mode"]\n');
  assert.strictEqual(line, 'Context 7% used');
});

test('설정을 못 읽으면 최소 기본 항목으로 만든다', () => {
  const st = { agent: 'codex', model: 'gpt-5.6-sol', effort: 'low', contextPct: 7 };
  const line = A.codexLine(st, () => { throw new Error('없음'); });
  assert.strictEqual(line, 'gpt-5.6-sol low · Context 7% used');
});
