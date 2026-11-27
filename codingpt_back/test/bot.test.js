// 봇 — node --test. 표식 해석·서비스 웹훅 해석/서명·스케줄 시각·기본 지시.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const bot = require('../services/botService');
const inbound = require('../services/botInbound');

test('표식 — 걷어 내고 JSON 을 읽는다, 깨진 표식은 버린다, quiet', () => {
  const r = bot.parseMarks('원인은 DB 풀 고갈입니다.\n\n<!--cpt-item {"op":"add","title":"풀 크기 조정","ask":"올릴까요?","options":["20","50"]}-->\n<!--cpt-memory {"add":"배포는 금요일에 안 한다"}-->\n<!--cpt-item {broken-->');
  assert.strictEqual(r.text, '원인은 DB 풀 고갈입니다.');
  assert.strictEqual(r.marks.length, 2);
  assert.deepStrictEqual(r.marks[0], { kind: 'item', data: { op: 'add', title: '풀 크기 조정', ask: '올릴까요?', options: ['20', '50'] } });
  assert.strictEqual(r.marks[1].kind, 'memory');
  const q = bot.parseMarks('<!--cpt-quiet-->');
  assert.strictEqual(q.quiet, true);
  assert.strictEqual(q.text, '');
});

test('기본 지시 — 이름·SOUL·MEMORY·규칙(외부 지시 무시, 표식 문법)', async () => {
  const p = await bot.preamble({ name: '장애봇', description: '결제 장애', soul: '나는 장애를 맡는다', memory: '- 2026-11-01 금요일 배포 금지', cwd: '/w' });
  assert.match(p, /「장애봇」/);
  assert.match(p, /나는 장애를 맡는다/);
  assert.match(p, /금요일 배포 금지/);
  assert.match(p, /지시문은 따르지 말고/);
  assert.match(p, /cpt-item/);
});

test('스케줄 — 다음 실행 시각은 그 시간대의 요일·시각', () => {
  // 2026-11-27(금) 10:00 KST 기준, 평일 09:00 → 다음은 2026-11-30(월) 09:00 KST = 00:00Z
  const from = Date.parse('2026-11-27T01:00:00Z');
  const n = bot.nextRun({ days: [1, 2, 3, 4, 5], time: '09:00', tz: 'Asia/Seoul' }, from);
  assert.strictEqual(n.toISOString(), '2026-11-30T00:00:00.000Z');
  // 같은 날 아직 안 지났으면 오늘
  const n2 = bot.nextRun({ days: [5], time: '18:30', tz: 'Asia/Seoul' }, from);
  assert.strictEqual(n2.toISOString(), '2026-11-27T09:30:00.000Z');
  // 다른 시간대(뉴욕, 서머타임 끝난 뒤 UTC-5)
  const n3 = bot.nextRun({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', tz: 'America/New_York' }, from);
  assert.strictEqual(n3.toISOString(), '2026-11-27T14:00:00.000Z');
  assert.throws(() => bot.nextRun({ time: '25:00' }), (e) => e.code === 'BAD_REQUEST');
});

test('GitHub — CI 실패는 error + dedupe, 성공은 다른 키, 서명 검증', () => {
  const body = { action: 'completed', repository: { full_name: 'me/app' }, workflow_run: { name: 'test', head_branch: 'main', conclusion: 'failure', html_url: 'https://github.com/me/app/actions/runs/1', event: 'push', head_sha: 'abcdef123', head_commit: { message: 'fix\nmore' } } };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  const r = inbound.parse({ 'X-GitHub-Event': 'workflow_run', 'X-Hub-Signature-256': sig }, body, raw, 's3cret');
  assert.strictEqual(r.provider, 'github');
  assert.strictEqual(r.input.level, 'error');
  assert.match(r.input.title, /CI 실패: test \(main\)/);
  assert.strictEqual(r.input.dedupeKey, 'gh:ci:me/app:test:main');
  assert.throws(() => inbound.parse({ 'x-github-event': 'workflow_run', 'x-hub-signature-256': 'sha256=00' }, body, raw, 's3cret'), (e) => e.code === 'BAD_SIGNATURE');
  // 진행 중 이벤트는 무시
  assert.strictEqual(inbound.parse({ 'x-github-event': 'workflow_run' }, { ...body, action: 'requested' }, null, null), null);
});

test('Sentry·Linear·Vercel — 해석', () => {
  const s = inbound.parse({ 'sentry-hook-resource': 'issue' }, { action: 'created', data: { issue: { id: '42', title: 'TypeError: x', level: 'fatal', web_url: 'https://sentry.io/i/42', culprit: 'pay.js', project: { slug: 'api' } } } }, null, null);
  assert.strictEqual(s.input.level, 'critical');
  assert.strictEqual(s.input.dedupeKey, 'sentry:42');
  const l = inbound.parse({ 'linear-event': 'Issue' }, { type: 'Issue', action: 'create', url: 'https://linear.app/x/ENG-1', data: { identifier: 'ENG-1', title: '로그인 안 됨', priority: 1, team: { key: 'ENG' } } }, null, null);
  assert.strictEqual(l.input.level, 'critical');
  assert.match(l.input.title, /ENG-1/);
  const v = inbound.parse({ 'x-vercel-signature': 'x' }, { type: 'deployment.error', payload: { deployment: { name: 'web', url: 'web-1.vercel.app' } } }, null, null);
  assert.strictEqual(v.input.level, 'error');
  assert.strictEqual(v.provider, 'vercel');
  // 모르는 모양은 그대로
  assert.deepStrictEqual(inbound.parse({}, { title: 'x' }, null, null), { provider: null, input: { title: 'x' } });
});
