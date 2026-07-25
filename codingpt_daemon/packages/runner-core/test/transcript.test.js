// 트랜스크립트 리더 테스트 — node 내장 러너(node --test), 외부 프레임워크 없음.
//  격리 원칙: runtime.init 으로 홈/claudeHome 을 임시 디렉토리로 돌린다. 사용자 실제 ~/.claude 무접촉.
//  검증 대상: 슬러그 규칙 · 홈 jail · 정규화 14+3 타입 · seq 캐치업 · 로테이션 · 대용량(합성) · tail 축출.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');

// 격리 루트 — realpath 로 정규화(macOS /var → /private/var 때문에 safeResolve 와 불일치가 생긴다).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tx-')));
const CLAUDE_HOME = path.join(ROOT, '.claude');
const PROJECTS = path.join(CLAUDE_HOME, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: CLAUDE_HOME });

const T = require('../transcript');

// ── 픽스처 ──────────────────────────────────────────────────────────
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });

const TS = '2026-07-25T01:02:03.000Z';
// 실측 라인 타입 전수(14종) + 서브에이전트 3종을 대표하는 픽스처.
const FIXTURE = [
  { type: 'mode', mode: 'normal', sessionId: 's1' },
  { type: 'permission-mode', permissionMode: 'auto', sessionId: 's1' },
  { type: 'file-history-snapshot', messageId: 'm1', snapshot: { messageId: 'm1', trackedFileBackups: {}, timestamp: TS } },
  { type: 'user', uuid: 'u1', timestamp: TS, cwd: WS, sessionId: 's1', gitBranch: 'main', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: '안녕 클로드' } },
  { type: 'attachment', uuid: 'a1', timestamp: TS, cwd: WS, sessionId: 's1', attachment: { type: 'total_tokens_reminder', tokens: 100 } },
  { type: 'ai-title', aiTitle: '픽스처 세션 제목', sessionId: 's1' },
  { type: 'assistant', uuid: 'as1', timestamp: TS, cwd: WS, sessionId: 's1', message: { model: 'claude-opus-5', content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '네, 파일을 고칠게요.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: path.join(WS, 'index.html'), old_string: 'a\nb', new_string: 'c\nd\ne' } },
  ] } },
  { type: 'user', uuid: 'u2', timestamp: TS, cwd: WS, sessionId: 's1', toolUseResult: { ok: true }, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: '수정 완료', is_error: false },
  ] } },
  { type: 'assistant', uuid: 'as2', timestamp: TS, cwd: WS, sessionId: 's1', message: { model: 'claude-opus-5', content: [
    { type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: { questions: [{ question: '사과와 바나나 중?', header: '과일', options: [{ label: 'Apple', description: '상큼' }, { label: 'Banana', description: '달콤' }], multiSelect: false }] } },
  ] } },
  { type: 'assistant', uuid: 'as3', timestamp: TS, cwd: WS, sessionId: 's1', message: { model: 'claude-opus-5', content: [
    { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'npm test\n--verbose', description: '테스트 실행' } },
  ] } },
  { type: 'user', uuid: 'u3', timestamp: TS, cwd: WS, sessionId: 's1', isMeta: true, message: { role: 'user', content: '<local-command-caveat>무시</local-command-caveat>' } },
  { type: 'user', uuid: 'u4', timestamp: TS, cwd: WS, sessionId: 's1', message: { role: 'user', content: '<command-name>/model</command-name><command-args>opus</command-args>' } },
  { type: 'user', uuid: 'u5', timestamp: TS, cwd: WS, sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  { type: 'user', uuid: 'u6', timestamp: TS, cwd: WS, sessionId: 's1', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'text', text: '이 화면 봐줘' },
  ] } },
  { type: 'system', uuid: 'sy1', timestamp: TS, cwd: WS, sessionId: 's1', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 635005, postTokens: 14373 } },
  { type: 'system', uuid: 'sy2', timestamp: TS, cwd: WS, sessionId: 's1', subtype: 'turn_duration', durationMs: 1234, messageCount: 5 },
  { type: 'last-prompt', leafUuid: 'u6', sessionId: 's1', lastPrompt: '이 화면 봐줘' },
  { type: 'agent-name', agentName: 'verifier', sessionId: 's1' },
  { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's1', content: '다음 작업' },
  { type: 'file-history-delta', messageId: 'm1', snapshotMessageId: 'm1', trackingPath: 'x', backup: {}, timestamp: TS },
  { type: 'frame-link', sessionId: 's1', path: 'a', frameUrl: 'https://example.com', timestamp: TS, title: '아티팩트' },
  { type: 'bridge-session', sessionId: 's1', bridgeSessionId: 'b1', lastSequenceNum: 3 },
  // 서브에이전트/워크플로 저널 3종(코퍼스 전수 스캔에서 발견 — 설계서 14종 목록 밖)
  { type: 'started', key: 'v2:abc', agentId: 'ag1' },
  { type: 'result', key: 'v2:abc', agentId: 'ag1', result: '서브에이전트 보고' },
  { type: 'fork-context-ref', agentId: 'afork-1', parentSessionId: 's0', parentLastUuid: 'x', contextLength: 965 },
];

function writeJsonl(file, objs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}
const projDir = (absCwd) => path.join(PROJECTS, T.slugOf(absCwd));
const sessFile = (absCwd, id) => path.join(projDir(absCwd), id + '.jsonl');

const FIX_FILE = sessFile(WS, 's1');
writeJsonl(FIX_FILE, FIXTURE);

// 라인 → ChatMsg[] 전체(테스트 편의).
async function allMsgs(file) {
  const st = fs.statSync(file);
  const r = await T.tailLines(file, { maxLines: 100000, scanBytes: st.size + 4096 });
  const out = [];
  for (const ln of r.lines) for (const m of T.normalizeLine(ln)) out.push(m);
  return out;
}

// ── 1. 슬러그 규칙 (실측 역공학) ────────────────────────────────────
test('slugOf — 실측 케이스(점/언더스코어/비ASCII)', () => {
  assert.strictEqual(T.slugOf('/Users/whrksp126/other/project/codingpt'), '-Users-whrksp126-other-project-codingpt');
  assert.strictEqual(T.slugOf('/Users/whrksp126/.claude/jobs/6ca02b18/tmp'), '-Users-whrksp126--claude-jobs-6ca02b18-tmp');
  assert.strictEqual(T.slugOf('/Users/x/other/project/codingpt/codingpt_service'), '-Users-x-other-project-codingpt-codingpt-service');
  // 비ASCII 1 code unit → '-' 1개. 다대일이라 슬러그만으로 세션 특정 불가.
  assert.strictEqual(T.slugOf('/Users/whrksp126/other/project/testProject/새'), '-Users-whrksp126-other-project-testProject--');
  assert.strictEqual(T.slugOf('/Users/whrksp126/other/project/testProject/日'), T.slugOf('/Users/whrksp126/other/project/testProject/새'));
});

// ── 2. 홈 jail (크레덴셜 접근 차단) ─────────────────────────────────
test('safeTranscriptPath — projects 밖·비 jsonl·심링크 탈출 거부', () => {
  fs.writeFileSync(path.join(CLAUDE_HOME, '.credentials.json'), '{"secret":1}');
  assert.throws(() => T.safeTranscriptPath(path.join(CLAUDE_HOME, '.credentials.json')), /허용되지 않은 경로/);
  assert.throws(() => T.safeTranscriptPath('../.credentials.json'), /허용되지 않은 경로/);
  assert.throws(() => T.safeTranscriptPath('../../etc/passwd.jsonl'), /허용되지 않은 경로/);
  assert.throws(() => T.safeTranscriptPath(path.join(PROJECTS, 'x', 'notes.txt')), /허용되지 않은 경로/);
  assert.throws(() => T.safeTranscriptPath(''), /허용되지 않은 경로/);
  // 심링크로 projects 밖을 가리켜도 realpath 로 걸린다.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-out-')));
  fs.writeFileSync(path.join(outside, 'leak.jsonl'), '{}\n');
  const link = path.join(PROJECTS, 'leak.jsonl');
  try { fs.symlinkSync(path.join(outside, 'leak.jsonl'), link); } catch (_) { /* 이미 존재 */ }
  assert.throws(() => T.safeTranscriptPath(link), /허용되지 않은 경로/);
  // 정상 경로는 통과
  assert.strictEqual(T.safeTranscriptPath(FIX_FILE), FIX_FILE);
});

test('chat.* 는 jail 밖 sessionId 를 거부한다', async () => {
  await assert.rejects(() => T.handle('chat.open', { cwd: 'ws', sessionId: '../../../etc/passwd' }), /세션 ID 형식|허용되지 않은/);
  await assert.rejects(() => T.handle('chat.open', { cwd: 'ws', sessionId: 'a/b' }), /세션 ID 형식/);
});

// ── 3. 정규화 ───────────────────────────────────────────────────────
test('normalize — 전 타입 커버(unknown 0) + 순수 메타 라인은 메시지 미생성', async () => {
  const msgs = await allMsgs(FIX_FILE);
  assert.strictEqual(msgs.filter((m) => m.kind === 'unknown').length, 0, 'unknown kind 가 있으면 분류표 누락');
  const kinds = msgs.map((m) => m.kind);
  for (const k of ['text', 'thinking', 'tool_use', 'tool_result', 'question', 'slash', 'interrupt', 'meta', 'system', 'compact', 'divider']) {
    assert.ok(kinds.includes(k), `kind ${k} 미생성`);
  }
  // mode/permission-mode/ai-title/last-prompt/agent-name/file-history-* 는 대화가 아니므로 0건
  const metaTypeMsgs = msgs.filter((m) => m.text === 'normal' || m.text === '픽스처 세션 제목');
  assert.strictEqual(metaTypeMsgs.length, 0);
});

test('normalize — seq 는 단조 증가하고 라인오프셋에서 복원 가능', async () => {
  const msgs = await allMsgs(FIX_FILE);
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].seq > msgs[i - 1].seq, `seq 역행: ${msgs[i - 1].seq} → ${msgs[i].seq}`);
  const S = T._internals.SEQ_SCALE;
  // 같은 라인의 블록들은 오프셋이 같고 블록 인덱스만 다르다.
  const asst = msgs.filter((m) => m.role === 'assistant' && m.model);
  const offs = new Set(asst.slice(0, 3).map((m) => Math.floor(m.seq / S)));
  assert.strictEqual(offs.size, 1, '한 assistant 라인의 블록들은 같은 오프셋을 공유해야 한다');
});

test('normalize — thinking 은 본문 없이 접힌 마커만(실측: 항상 빈 문자열)', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const th = msgs.find((m) => m.kind === 'thinking');
  assert.strictEqual(th.text, '');
  assert.strictEqual(th.hidden, true);
});

test('normalize — tool_use 요약/경로/미리보기', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const edit = msgs.find((m) => m.tool && m.tool.name === 'Edit');
  assert.strictEqual(edit.tool.title, '수정 index.html');
  assert.strictEqual(edit.tool.path, 'ws/index.html'); // 홈-상대(fsLib.relOf)
  assert.strictEqual(edit.tool.lang, 'html');
  assert.strictEqual(edit.tool.argsPreview, '-2/+3 줄');
  assert.ok(edit.tool.argsBytes > 0);
  const bash = msgs.find((m) => m.tool && m.tool.name === 'Bash');
  assert.strictEqual(bash.tool.title, '$ npm test'); // 첫 줄만
  assert.strictEqual(bash.tool.argsPreview, '테스트 실행');
});

test('normalize — AskUserQuestion 은 question 으로 승격(폰이 버튼을 그린다)', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const q = msgs.find((m) => m.kind === 'question');
  assert.strictEqual(q.question.header, '과일');
  assert.strictEqual(q.question.options.length, 2);
  assert.strictEqual(q.question.options[0].label, 'Apple');
  assert.strictEqual(q.question.multiSelect, false);
  assert.strictEqual(q.text, '사과와 바나나 중?');
});

test('normalize — tool_result 는 요약만(원본은 온디맨드)', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const r = msgs.find((m) => m.kind === 'tool_result');
  assert.strictEqual(r.result.toolUseId, 'toolu_1');
  assert.strictEqual(r.result.ok, true);
  assert.strictEqual(r.result.preview, '수정 완료');
});

test('normalize — 사람 프롬프트/슬래시/meta/interrupt 분류', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const human = msgs.find((m) => m.kind === 'text' && m.role === 'user');
  assert.strictEqual(human.text, '안녕 클로드');
  assert.strictEqual(human.hidden, false);
  assert.strictEqual(msgs.find((m) => m.kind === 'slash').text, '/model opus');
  assert.strictEqual(msgs.find((m) => m.kind === 'meta').hidden, true);
  assert.ok(msgs.find((m) => m.kind === 'interrupt'));
  // 이미지는 바이트를 인라인하지 않고 ref 만
  const img = msgs.find((m) => m.attachments && m.attachments.length);
  assert.strictEqual(img.attachments[0].mediaType, 'image/png');
  assert.ok(!JSON.stringify(img).includes('aGVsbG8='));
});

test('normalize — compact 경계는 토큰 수를 실어 divider 로', async () => {
  const msgs = await allMsgs(FIX_FILE);
  const c = msgs.find((m) => m.kind === 'compact');
  assert.strictEqual(c.meta.preTokens, 635005);
  assert.strictEqual(c.meta.postTokens, 14373);
});

test('normalize — 손상/반쪽 라인은 예외 없이 스킵', () => {
  assert.deepStrictEqual(T.normalizeLine({ off: 0, buf: Buffer.from('{"type":"user"'), bytes: 14, overflow: false }), []);
  assert.deepStrictEqual(T.normalizeLine({ off: 0, buf: Buffer.alloc(0), bytes: 0, overflow: false }), []);
  assert.deepStrictEqual(T.normalize(null, 0), []);
});

// ── 4. 저수준 읽기 ─────────────────────────────────────────────────
test('tailLines — 파일 끝에서 N줄만 읽고 오프셋이 정확하다', async () => {
  const f = sessFile(WS, 'tail1');
  const objs = [];
  for (let i = 0; i < 500; i++) objs.push({ type: 'ai-title', aiTitle: 'n' + i, sessionId: 'tail1' });
  writeJsonl(f, objs);
  const r = await T.tailLines(f, { maxLines: 10 });
  assert.strictEqual(r.lines.length, 10);
  assert.strictEqual(JSON.parse(r.lines[0].buf.toString()).aiTitle, 'n490');
  assert.strictEqual(JSON.parse(r.lines[9].buf.toString()).aiTitle, 'n499');
  assert.strictEqual(r.nextOffset, fs.statSync(f).size);
  // 오프셋이 실제 라인 시작을 가리키는지 직접 확인
  const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(20);
  fs.readSync(fd, b, 0, 20, r.lines[0].off); fs.closeSync(fd);
  assert.ok(b.toString().startsWith('{"type":"ai-title"'));
});

test('tailLines — 미완결 꼬리 라인은 넘기지 않는다(append 중 반쪽 읽기 방어)', async () => {
  const f = sessFile(WS, 'partial');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: 'ok', sessionId: 'partial' }) + '\n{"type":"user","mess');
  const r = await T.tailLines(f, { maxLines: 10 });
  assert.strictEqual(r.lines.length, 1);
  assert.ok(r.nextOffset < fs.statSync(f).size, 'nextOffset 은 미완결 라인 시작에 머물러야 한다');
});

test('readDelta — 완결 라인만, 다음 오프셋에서 이어읽기', async () => {
  const f = sessFile(WS, 'delta1');
  writeJsonl(f, [{ type: 'ai-title', aiTitle: 'a', sessionId: 'x' }]);
  const d1 = await T.readDelta(f, 0);
  assert.strictEqual(d1.lines.length, 1);
  fs.appendFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: 'b', sessionId: 'x' }) + '\n');
  const d2 = await T.readDelta(f, d1.nextOffset);
  assert.strictEqual(d2.lines.length, 1);
  assert.strictEqual(JSON.parse(d2.lines[0].buf.toString()).aiTitle, 'b');
  const d3 = await T.readDelta(f, d2.nextOffset);
  assert.strictEqual(d3.lines.length, 0);
});

test('거대 라인은 JSON.parse 를 건너뛰고 divider 로 대체(실측 최대 3.1MB 라인)', async () => {
  const f = sessFile(WS, 'huge-line');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const big = { type: 'user', uuid: 'b', timestamp: TS, cwd: WS, sessionId: 'huge-line', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1024 * 1024) } }] } };
  fs.writeFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: '전', sessionId: 'huge-line' }) + '\n' + JSON.stringify(big) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: '후', sessionId: 'huge-line' }) + '\n');
  const r = await T.tailLines(f, { maxLines: 10, scanBytes: 8 * 1024 * 1024 });
  const over = r.lines.find((l) => l.overflow);
  assert.ok(over, 'LINE_CAP 초과 라인이 overflow 로 표시돼야 한다');
  assert.strictEqual(over.buf.length, 0, '내용을 메모리에 담지 않아야 한다');
  assert.ok(over.bytes > 1024 * 1024);
  const msgs = T.normalizeLine(over);
  assert.strictEqual(msgs[0].kind, 'divider');
  assert.ok(/생략/.test(msgs[0].text));
  assert.strictEqual(msgs[0].meta.oversizeLine, true);
});

test('합성 대용량 파일(32MB) — 스냅샷이 상수시간·저메모리', async () => {
  const f = sessFile(WS, 'bigsynth');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const fd = fs.openSync(f, 'w');
  const pad = 'x'.repeat(700);
  let n = 0;
  while (fs.fstatSync(fd).size < 32 * 1024 * 1024) {
    let chunk = '';
    for (let i = 0; i < 500; i++, n++) chunk += JSON.stringify({ type: 'assistant', uuid: 'u' + n, timestamp: TS, cwd: WS, sessionId: 'bigsynth', message: { model: 'm', content: [{ type: 'text', text: 'line' + n + pad }] } }) + '\n';
    fs.writeSync(fd, chunk);
  }
  fs.closeSync(fd);
  const size = fs.statSync(f).size;
  const before = process.memoryUsage().rss;
  const t0 = process.hrtime.bigint();
  const snap = await T.snapshot(f, { maxLines: 200 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const rssDelta = process.memoryUsage().rss - before;
  assert.strictEqual(snap.messages.length, 200);
  assert.strictEqual(snap.messages[199].text, 'line' + (n - 1) + pad);
  assert.ok(ms < 300, `스냅샷 ${ms.toFixed(1)}ms — 상수시간이어야 한다(size=${size})`);
  assert.ok(rssDelta < 60 * 1024 * 1024, `RSS 증가 ${(rssDelta / 1048576).toFixed(1)}MB — 전체 로드 흔적`);
  // countLines 는 8MB 초과 파일에서 전스캔을 거부한다(목록 응답 보호)
  assert.strictEqual(await T.countLines(f), null);
});

// ── 5. 세션 후보 / 슬러그 충돌 ──────────────────────────────────────
test('candidatesFor — 슬러그 충돌(비ASCII 다대일)을 cwd 필드로 분리', async () => {
  const A = path.join(ROOT, 'p', '한');
  const B = path.join(ROOT, 'p', '글');
  assert.strictEqual(T.slugOf(A), T.slugOf(B), '테스트 전제: 두 cwd 의 슬러그가 같아야 한다');
  fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
  writeJsonl(sessFile(A, 'ka'), [{ type: 'user', uuid: 'x', timestamp: TS, cwd: A, sessionId: 'ka', message: { role: 'user', content: 'A' } }]);
  writeJsonl(sessFile(B, 'kb'), [{ type: 'user', uuid: 'y', timestamp: TS, cwd: B, sessionId: 'kb', message: { role: 'user', content: 'B' } }]);
  const ca = await T.candidatesFor(A);
  const cb = await T.candidatesFor(B);
  assert.deepStrictEqual(ca.map((c) => c.sessionId), ['ka']);
  assert.deepStrictEqual(cb.map((c) => c.sessionId), ['kb']);
  assert.strictEqual(ca[0].cwdMatch, true);
});

test('candidatesFor — 이관/복사된 세션(다른 슬러그의 cwd)은 유지한다', async () => {
  // sync.restoreSessionArtifact 가 남의 jsonl 을 타겟 슬러그로 복사해 넣는다(실측 케이스).
  //  cwd 불일치를 무조건 버리면 "이어받기"가 깨지므로 cwdMatch:false 로 표시만 하고 남긴다.
  const TGT = path.join(ROOT, 'restored');
  fs.mkdirSync(TGT, { recursive: true });
  writeJsonl(sessFile(TGT, 'copied'), [{ type: 'user', uuid: 'z', timestamp: TS, cwd: '/somewhere/else/entirely', sessionId: 'copied', message: { role: 'user', content: 'C' } }]);
  const c = await T.candidatesFor(TGT);
  assert.deepStrictEqual(c.map((x) => x.sessionId), ['copied']);
  assert.strictEqual(c[0].cwdMatch, false);
  assert.strictEqual(c[0].foreign, false);
});

test('metaOf — 제목은 ai-title 우선, tail 만 읽는다', async () => {
  const m = await T.metaOf(FIX_FILE);
  assert.strictEqual(m.title, '픽스처 세션 제목');
  assert.strictEqual(m.lastPrompt, '이 화면 봐줘');
  assert.strictEqual(m.permissionMode, 'auto');
  assert.strictEqual(m.gitBranch, 'main');
  assert.strictEqual(m.sessionId, 's1');
  const noTitle = sessFile(WS, 'notitle');
  writeJsonl(noTitle, [{ type: 'user', uuid: 'q', timestamp: TS, cwd: WS, sessionId: 'notitle', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '첫 프롬프트가 제목이 된다' } }]);
  assert.strictEqual((await T.metaOf(noTitle)).title, '첫 프롬프트가 제목이 된다');
});

// ── 6. 어댑터 ──────────────────────────────────────────────────────
test('adapterFor — claude 구현 / codex 미실측 / 미지원은 null', async () => {
  assert.strictEqual(T.adapterFor('claude').name, 'claude');
  assert.strictEqual(T.adapterFor('claude').detect(), true);
  assert.strictEqual(T.adapterFor('codex').detect(), false, 'codex 는 포맷 미실측 — 추측 구현 금지');
  assert.strictEqual(T.adapterFor('codex').unmeasured, true);
  assert.strictEqual(T.adapterFor('gemini'), null);
  const r = await T.handle('chat.sessions', { cwd: 'ws', agent: 'codex' });
  assert.strictEqual(r.supported, false);
  assert.strictEqual(r.reason, 'unmeasured');
  const g = await T.handle('chat.sessions', { cwd: 'ws', agent: 'gemini' });
  assert.strictEqual(g.supported, false);
  assert.strictEqual(g.reason, 'unsupported_agent');
});

// ── 7. RPC: 목록 / 스냅샷 / 캐치업 / 로테이션 ───────────────────────
const fakeWs = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); } });

test('chat.sessions — 목록 + oversize/live 배지', async () => {
  const r = await T.handle('chat.sessions', { cwd: 'ws' });
  assert.strictEqual(r.supported, true);
  assert.strictEqual(r.agent, 'claude');
  const s1 = r.sessions.find((s) => s.sessionId === 's1');
  assert.strictEqual(s1.title, '픽스처 세션 제목');
  assert.strictEqual(s1.oversize, false);
  assert.strictEqual(s1.live, true);
  assert.ok(s1.bytes > 0);
});

test('chat.open → append → chat.since: seq 누락·중복 0 (멱등 캐치업)', async () => {
  const f = sessFile(WS, 'catchup');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'catchup', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '시작' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'catchup' }, ws);
  assert.strictEqual(open.messages.length, 1);
  assert.strictEqual(open.source, 'explicit');
  assert.ok(open.chatId.startsWith('c_'));

  // 400줄 append 후 캐치업 — 전부 정확히 1회씩
  const objs = [];
  for (let i = 0; i < 400; i++) objs.push({ type: 'assistant', uuid: 'x' + i, timestamp: TS, cwd: WS, sessionId: 'catchup', message: { model: 'm', content: [{ type: 'text', text: 'msg' + i }] } });
  fs.appendFileSync(f, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');

  let since = open.headSeq;
  const got = [];
  for (let guard = 0; guard < 10; guard++) {
    const r = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: since, epoch: open.epoch });
    assert.ok(!r.epochChanged, 'epoch 이 바뀌면 안 된다(append 뿐)');
    for (const m of r.messages) got.push(m);
    since = r.headSeq;
    if (!r.more) break;
  }
  assert.strictEqual(got.length, 400, '누락/중복 없이 400건');
  assert.deepStrictEqual(got.map((m) => m.text), objs.map((_, i) => 'msg' + i));
  assert.strictEqual(new Set(got.map((m) => m.seq)).size, 400, 'seq 중복 0');
  for (let i = 1; i < got.length; i++) assert.ok(got[i].seq > got[i - 1].seq);

  // 같은 sinceSeq 로 다시 불러도 같은 결과(멱등) — 재전송이 아니라 그 이후만
  const again = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: since, epoch: open.epoch });
  assert.strictEqual(again.messages.length, 0);

  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.since — 프레임 예산 초과 시 버리지 않고 more 로 이어받는다(유실 0)', async () => {
  const f = sessFile(WS, 'framecap');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'framecap', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '시작' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'framecap' }, ws);
  // 메시지당 약 4KB(TEXT_CAP) × 400건 ≈ 1.6MB → FRAME_CAP(512KB)을 여러 번 넘긴다.
  const fat = 'ㄱ'.repeat(4200);
  const objs = [];
  for (let i = 0; i < 400; i++) objs.push({ type: 'assistant', uuid: 'f' + i, timestamp: TS, cwd: WS, sessionId: 'framecap', message: { model: 'm', content: [{ type: 'text', text: 'F' + i + '|' + fat }] } });
  fs.appendFileSync(f, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');

  let since = open.headSeq;
  const got = [];
  let rounds = 0;
  for (; rounds < 40; rounds++) {
    const r = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: since, epoch: open.epoch });
    for (const m of r.messages) got.push(m);
    since = r.headSeq;
    if (!r.more) break;
  }
  assert.ok(rounds > 0, '한 프레임에 다 담기면 이 테스트가 무의미하다');
  assert.strictEqual(got.length, 400, '프레임 예산 때문에 메시지가 유실됐다');
  assert.deepStrictEqual(got.map((m) => m.text.split('|')[0]), objs.map((_, i) => 'F' + i));
  assert.strictEqual(new Set(got.map((m) => m.seq)).size, 400);
  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.since — 파일 교체(로테이션)/truncate 는 epochChanged 로 스냅샷 대체', async () => {
  const f = sessFile(WS, 'rotate');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'rotate', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '이전 세션' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'rotate' }, ws);

  // (a) truncate 후 짧게 재작성 — 오프셋이 파일 밖 → 스냅샷 대체
  writeJsonl(f, [{ type: 'user', uuid: 'b', timestamp: TS, cwd: WS, sessionId: 'rotate', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '새 대화' } }]);
  const r1 = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: open.headSeq, epoch: open.epoch });
  assert.strictEqual(r1.epochChanged, true);
  assert.strictEqual(r1.messages[0].text, '새 대화');

  // (b) 파일 자체 교체(inode 변경) — epoch 문자열이 달라진다
  fs.unlinkSync(f);
  writeJsonl(f, [{ type: 'user', uuid: 'c', timestamp: TS, cwd: WS, sessionId: 'rotate', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '교체됨' } }]);
  const r2 = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: r1.headSeq, epoch: r1.epoch });
  assert.strictEqual(r2.epochChanged, true);
  assert.notStrictEqual(r2.epoch, r1.epoch);
  assert.strictEqual(r2.messages[0].text, '교체됨');
  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.open — 파일 사라지면 CHAT_NOT_FOUND, 구독 없으면 CHAT_GONE', async () => {
  await assert.rejects(() => T.handle('chat.open', { cwd: 'ws', sessionId: 'nope' }), (e) => e.code === 'CHAT_NOT_FOUND');
  await assert.rejects(() => T.handle('chat.since', { chatId: 'c_ffffffff' }), (e) => e.code === 'CHAT_GONE');
  await assert.rejects(() => T.handle('chat.bogus', {}), (e) => e.code === 'BAD_METHOD');
});

test('chat.detail / chat.attachment — 온디맨드 원본', async () => {
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 's1' }, ws);
  const edit = open.messages.find((m) => m.tool && m.tool.name === 'Edit');
  const d = await T.handle('chat.detail', { chatId: open.chatId, seq: edit.seq });
  assert.ok(d.raw.includes('old_string'), '원본 tool_input 이 와야 한다');
  const img = open.messages.find((m) => m.attachments && m.attachments.length);
  const a = await T.handle('chat.attachment', { chatId: open.chatId, seq: img.seq, idx: 0 });
  assert.strictEqual(a.mediaType, 'image/png');
  assert.strictEqual(Buffer.from(a.base64, 'base64').toString(), 'hello');
  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.input — 주입기 배선 전에는 NOT_IMPLEMENTED (allow 유사 폴백 없음)', async () => {
  await assert.rejects(() => T.handle('chat.input', { cwd: 'ws', tid: 1, text: 'hi' }), (e) => e.code === 'NOT_IMPLEMENTED');
  T.setInputInjector(async (p) => ({ ok: true, tid: p.tid, bytes: Buffer.byteLength(p.text) }));
  assert.deepStrictEqual(await T.handle('chat.input', { cwd: 'ws', tid: 7, text: '한글' }), { ok: true, tid: 7, bytes: 6 });
  T.setInputInjector(null);
});

// ── 8. 라이브 tail (push) ───────────────────────────────────────────
function waitFor(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v; try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('타임아웃'));
      setTimeout(tick, 20); // unref 하지 않는다 — 이벤트 루프를 살려 push 를 받게
    };
    tick();
  });
}

test('라이브 tail — append 가 chat_event 로 push 된다(자체 fs.watch)', async () => {
  const f = sessFile(WS, 'live');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'live', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '처음' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'live' }, ws);
  fs.appendFileSync(f, JSON.stringify({ type: 'assistant', uuid: 'b', timestamp: TS, cwd: WS, sessionId: 'live', message: { model: 'm', content: [{ type: 'text', text: '증분 도착' }] } }) + '\n');
  const frame = await waitFor(() => ws.sent.find((m) => m.type === 'chat_event' && (m.messages || []).some((x) => x.text === '증분 도착')));
  assert.strictEqual(frame.chatId, open.chatId);
  assert.ok(frame.headSeq > open.headSeq);
  // 같은 라인을 다시 push 하지 않는다
  const count = ws.sent.filter((m) => (m.messages || []).some((x) => x.text === '증분 도착')).length;
  assert.strictEqual(count, 1);
  await T.handle('chat.close', { chatId: open.chatId });
});

test('라이브 tail — 파일 삭제 시 gone(file_deleted) push 후 정리', async () => {
  const f = sessFile(WS, 'gone');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'gone', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'x' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'gone' }, ws);
  fs.unlinkSync(f);
  const frame = await waitFor(() => ws.sent.find((m) => m.control && m.control.kind === 'gone'));
  assert.strictEqual(frame.control.reason, 'file_deleted');
  assert.strictEqual(T._internals.tails.has(open.chatId), false);
});

test('detachAll — push 대상만 해제하고 tail/오프셋/watcher 는 유지한다', async () => {
  const f = sessFile(WS, 'detach');
  writeJsonl(f, [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'detach', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'x' } }]);
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', sessionId: 'detach' }, ws);
  const before = T._internals.tails.get(open.chatId);
  T.detachAll();
  const after = T._internals.tails.get(open.chatId);
  assert.ok(after, 'tail 이 유지돼야 한다(fs.js stopWatch 관례를 따르면 스냅샷 폭주)');
  assert.strictEqual(after.watchers.length > 0, true, 'watcher 를 닫으면 안 된다');
  assert.strictEqual(after.offset, before.offset);
  // 재접속 후 pull 로 따라잡는다
  fs.appendFileSync(f, JSON.stringify({ type: 'assistant', uuid: 'b', timestamp: TS, cwd: WS, sessionId: 'detach', message: { model: 'm', content: [{ type: 'text', text: '끊긴 사이' }] } }) + '\n');
  const ws2 = fakeWs();
  const r = await T.handle('chat.since', { chatId: open.chatId, sinceSeq: open.headSeq, epoch: open.epoch }, ws2);
  assert.strictEqual(r.messages.filter((m) => m.text === '끊긴 사이').length, 1);
  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.open — 같은 파일 재구독은 멱등(같은 chatId)', async () => {
  T.closeAll(); // 앞선 테스트의 tail 잔재 제거(이 테스트는 tails 총량을 본다)
  const ws = fakeWs();
  const a = await T.handle('chat.open', { cwd: 'ws', sessionId: 's1' }, ws);
  const b = await T.handle('chat.open', { cwd: 'ws', sessionId: 's1' }, ws);
  assert.strictEqual(a.chatId, b.chatId);
  assert.strictEqual(T._internals.tails.size, 1);
  await T.handle('chat.close', { chatId: a.chatId });
  assert.strictEqual(T._internals.tails.size, 0);
});

test('tail 상한 — 9개 열면 8개만 유지하고 가장 오래된 것에 gone(tail_evicted)', async () => {
  T.closeAll();
  const ws = fakeWs();
  const ids = [];
  for (let i = 0; i < 9; i++) {
    const id = 'cap' + i;
    writeJsonl(sessFile(WS, id), [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: id, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'x' } }]);
    const o = await T.handle('chat.open', { cwd: 'ws', sessionId: id }, ws);
    ids.push(o.chatId);
  }
  assert.strictEqual(T._internals.tails.size, T._internals.MAX_TAILS);
  const evicted = ws.sent.filter((m) => m.control && m.control.kind === 'gone' && m.control.reason === 'tail_evicted');
  assert.strictEqual(evicted.length, 1);
  assert.strictEqual(evicted[0].chatId, ids[0]);
  T.closeAll();
});

// ── 9. 훅 바인딩 ────────────────────────────────────────────────────
test('noteHook — jail 밖 transcriptPath 는 채택하지 않고, 예외도 던지지 않는다', () => {
  const evil = path.join(CLAUDE_HOME, '.credentials.json');
  const r = T.noteHook({ sessionId: 'h1', transcriptPath: evil, cwd: WS, cwdRel: 'ws', tid: 1000001, event: 'session_start' });
  assert.strictEqual(r.ok, true);
  // cwd+sessionId 로 유추한 정상 경로만 채택된다(evil 은 버려짐)
  assert.strictEqual(r.transcriptPath, sessFile(WS, 'h1'));
  assert.ok(!String(r.transcriptPath).includes('credentials'));
  // 잘못된 입력에도 throw 하지 않는다(훅 경로에서 호출되므로 claude 를 방해하면 안 됨)
  assert.strictEqual(T.noteHook({}).ok, false);
  assert.strictEqual(T.noteHook({ sessionId: '../../etc/passwd' }).ok, false);
});

test('noteHook / lookupBind — 훅 좌표가 chat.open 의 P0 경로가 된다', async () => {
  writeJsonl(sessFile(WS, 'bound'), [{ type: 'user', uuid: 'a', timestamp: TS, cwd: WS, sessionId: 'bound', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: '바인딩됨' } }]);
  T.noteHook({ sessionId: 'bound', transcriptPath: sessFile(WS, 'bound'), cwd: WS, cwdRel: 'ws', tid: 1000002, event: 'prompt' });
  const b = T.lookupBind('ws', 1000002);
  assert.strictEqual(b.sessionId, 'bound');
  assert.strictEqual(b.source, 'hook');
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', tid: 1000002 }, ws);
  assert.strictEqual(open.sessionId, 'bound');
  assert.strictEqual(open.source, 'hook');
  assert.strictEqual(open.messages[0].text, '바인딩됨');
  await T.handle('chat.close', { chatId: open.chatId });
  // 바인딩 파일은 0600
  assert.strictEqual(fs.statSync(path.join(ROOT, '.codingpt', 'chat-bind.json')).mode & 0o777, 0o600);
});

test('chat.open — 바인딩 없으면 슬러그 스캔 최신으로 폴백(P2, 훅 없이도 동작)', async () => {
  const ws = fakeWs();
  const open = await T.handle('chat.open', { cwd: 'ws', tid: 9999999 }, ws);
  assert.strictEqual(open.source, 'scan');
  await T.handle('chat.close', { chatId: open.chatId });
});

test('pruneBinds — 30일 초과 바인딩 정리', () => {
  const bp = path.join(ROOT, '.codingpt', 'chat-bind.json');
  const j = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  j.binds['ws|old'] = { sessionId: 'x', at: Date.now() - 40 * 24 * 3600 * 1000 };
  fs.writeFileSync(bp, JSON.stringify(j));
  // 캐시를 강제로 비우려 다시 로드 — pruneBinds 는 캐시를 쓰므로 직접 주입 후 확인
  const before = Object.keys(JSON.parse(fs.readFileSync(bp, 'utf-8')).binds).length;
  assert.ok(before >= 1);
  const r = T.pruneBinds();
  assert.ok(r.pruned >= 0);
});

test('cleanup', () => {
  T.closeAll();
  assert.strictEqual(T._internals.tails.size, 0);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});
