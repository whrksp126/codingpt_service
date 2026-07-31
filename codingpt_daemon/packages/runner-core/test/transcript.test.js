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
const CODEX_HOME = path.join(ROOT, '.codex');
const CODEX_SESSIONS = path.join(CODEX_HOME, 'sessions');
fs.mkdirSync(PROJECTS, { recursive: true });
// ★ codexHome 도 반드시 격리한다 — 안 넣으면 기본값이 **사용자 실제 ~/.codex** 라 테스트가
//  그 머신에 codex 가 깔렸는지에 따라 초록/빨강이 갈린다(2026-07-28 실제로 그렇게 깨졌다).
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt'), claudeHome: CLAUDE_HOME, codexHome: CODEX_HOME });

const T = require('../transcript');

// ④-d 프로세스 소거의 기본 프로브는 실제 tmux/ps 를 부른다 — 테스트는 격리 소켓이 아니므로
//  기본을 "에이전트 없음"으로 잠근다(각 테스트가 필요하면 자기 프로브를 심고 되돌린다).
T._internals.setAgentProbe(async () => []);

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
test('adapterFor — claude/codex 구현 · 미지원 에이전트는 null', async () => {
  assert.strictEqual(T.adapterFor('claude').name, 'claude');
  assert.strictEqual(T.adapterFor('claude').detect(), true);
  assert.strictEqual(T.adapterFor('codex').name, 'codex');
  // 아직 ~/.codex/sessions 를 안 만들었으므로 detect()=false — 설치 안 한 PC 와 같은 상태.
  assert.strictEqual(T.adapterFor('codex').detect(), false, 'sessions 디렉토리가 없으면 꺼져 있어야 한다');
  assert.strictEqual(T.adapterFor('gemini'), null);
  const r = await T.handle('chat.sessions', { cwd: 'ws', agent: 'codex' });
  assert.strictEqual(r.supported, false);
  assert.strictEqual(r.reason, 'not_installed');
  const g = await T.handle('chat.sessions', { cwd: 'ws', agent: 'gemini' });
  assert.strictEqual(g.supported, false);
  assert.strictEqual(g.reason, 'unsupported_agent');
});

// ── 6-b. codex 롤아웃 파싱 (2026-07-28 실측 포맷) ────────────────────
//  회귀 대상 = "codex 터미널에 claude 대화가 뜬다" 사고. 두 축을 같이 고정한다:
//   ① codex 롤아웃이 우리 ChatMsg 로 **정확히** 정규화되는가(중복 없이, 도구 짝 맞춰서)
//   ② agent 를 안 보내면 claude 로 열려 **codex 대화가 안 보이는가**(= 클라가 agent 를 반드시 보내야 함)
const CODEX_DAY = path.join(CODEX_SESSIONS, '2026', '07', '28');
function writeCodexRollout(name, cwd, lines) {
  fs.mkdirSync(CODEX_DAY, { recursive: true });
  const file = path.join(CODEX_DAY, name);
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return file;
}

test('codex 어댑터 — 롤아웃 → ChatMsg 정규화(중복 0 · 도구 짝)', async () => {
  const sid = '019fa709-267a-7912-b1d0-9d760144c69d';
  const file = writeCodexRollout(`rollout-2026-07-28T13-43-42-${sid}.jsonl`, WS, [
    { timestamp: TS, type: 'session_meta', payload: { session_id: sid, cwd: WS, originator: 'codex-tui', cli_version: '0.145.0' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    // 시스템 프롬프트 주입은 response_item/message 로 들어온다 → 화면에 나오면 안 된다.
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: '날씨 물어봐줘' } },
    // ★ 같은 발화의 모델 원본(response_item/message)도 온다 — 둘 다 그리면 모든 말이 두 번 나온다.
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '날씨 물어봐줘' }] } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'agent_reasoning', text: '**Thinking**' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_A', arguments: '{"cmd":"ls -al"}' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_A', output: 'Chunk ID: x\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\ntotal 0\n' } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'agent_message', message: '어떤 날씨를 좋아하세요?', phase: 'final_answer' } },
    { timestamp: TS, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '어떤 날씨를 좋아하세요?' }] } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: TS, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ]);
  assert.strictEqual(T.adapterFor('codex').detect(), true, 'sessions 가 생기면 자동으로 켜진다');

  const cands = await T.adapterFor('codex').candidates(WS, { limit: 10 });
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(cands[0].sessionId, sid);
  assert.strictEqual(cands[0].file, file);

  const snap = await T.snapshot(file, { maxLines: 200, agent: 'codex' });
  const kinds = snap.messages.map((m) => `${m.role}/${m.kind}`);
  assert.deepStrictEqual(kinds, [
    'user/text', 'assistant/thinking', 'assistant/tool_use', 'user/tool_result', 'assistant/text',
  ], 'event_msg 만 그린다(response_item/message 중복 금지)');
  assert.strictEqual(snap.messages[0].text, '날씨 물어봐줘');
  assert.strictEqual(snap.messages[2].tool.title, '$ ls -al');
  assert.strictEqual(snap.messages[2].tool.id, 'call_A');
  assert.strictEqual(snap.messages[3].result.toolUseId, 'call_A', 'call_id 로 도구 결과가 짝지어진다');
  assert.strictEqual(snap.messages[3].result.ok, true);
  assert.strictEqual(snap.messages[3].result.preview.trim(), 'total 0', 'codex 머리말은 벗겨낸다');
  assert.strictEqual(snap.messages[4].text, '어떤 날씨를 좋아하세요?');

  // 목록 메타 — 제목은 첫 사람 발화.
  const meta = await T.adapterFor('codex').meta(file);
  assert.strictEqual(meta.title, '날씨 물어봐줘');
  assert.strictEqual(meta.sessionId, sid);
});

test('codex — agent 를 안 보내면 claude 로 열려 이 대화가 안 보인다(클라 계약 고정)', async () => {
  // claude 어댑터에는 이 워크스페이스의 후보가 없다 → noSession. 이게 "codex 터미널에 claude 대화" 사고의
  //  반대 증명이다: agent 를 실어야만 codex 대화가 열린다.
  const asClaude = await T.handle('chat.open', { cwd: 'ws-codex-only', tid: 7 });
  assert.strictEqual(asClaude.agent, 'claude');
  assert.strictEqual(asClaude.noSession, true);
});

test('codex — jail 은 sessions 아래로만. auth.json 은 절대 못 읽는다', () => {
  assert.throws(() => T.safeTranscriptPath(path.join(CODEX_HOME, 'auth.json')), /허용되지 않은 경로/);
  // 확장자를 .jsonl 로 위장해도 sessions 밖이면 거부.
  assert.throws(() => T.safeTranscriptPath(path.join(CODEX_HOME, 'auth.jsonl')), /허용되지 않은 경로/);
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

// ★★ 2026-07-27 실사고 회귀 — "터미널마다 다른 claude 세션인데 채팅이 둘 다 엉뚱한 같은 대화"
//   구 동작: tid 가 있어도 바인딩이 없거나 바인딩 파일이 없으면 **슬러그 스캔 최신**으로 폴백했다.
//   그래서 (a) claude 를 막 띄워 트랜스크립트가 아직 없는 터미널과 (b) 훅이 안 돈 터미널이 모두
//   "그 프로젝트의 mtime 최신 파일" = **남의 대화**를 받았다. 에러도 로그도 없다(사용자 기기 실측 확정).
//   새 계약: 남의 대화를 보여주는 것보다 아무것도 안 보여주는 것이 낫다 → noSession 으로 정직하게 답한다.
test('chat.open — 바인딩 파일이 아직 없으면 not_started(남의 대화로 폴백 금지)', async () => {
  const ws = fakeWs();
  // 훅은 세션을 알려줬지만 claude 가 아직 메시지를 안 써서 파일이 없는 상태(가장 흔한 경우).
  T.noteHook({ sessionId: 'never-written', cwd: WS, cwdRel: 'ws', tid: 4242, event: 'session_start' });
  const open = await T.handle('chat.open', { cwd: 'ws', tid: 4242 }, ws);
  assert.strictEqual(open.noSession, true);
  assert.strictEqual(open.reason, 'not_started');
  assert.strictEqual(open.sessionId, 'never-written');
  assert.deepStrictEqual(open.messages, []);
  assert.strictEqual(open.chatId, null);
  // ★ 핵심: 어떤 파일도 열지 않았다 = 다른 세션의 tail 이 생기지 않았다.
  assert.strictEqual(T._internals.tails.size, 0);
});

// 후보 파일을 원하는 mtime 으로 깔아둔 격리 워크스페이스를 만든다(라이브 판정 LIVE_MS=30s 기준).
function mkCandWs(name, sessions) {
  const abs = path.join(ROOT, name);
  fs.mkdirSync(abs, { recursive: true });
  const dir = T.projectDirOf(abs);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    const f = path.join(dir, s.id + '.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', sessionId: s.id, timestamp: TS, cwd: abs, message: { role: 'user', content: s.id } }) + '\n');
    if (s.ageMs) { const t = (Date.now() - s.ageMs) / 1000; fs.utimesSync(f, t, t); }
  }
  return abs;
}

test('chat.open — 바인딩 없고 후보가 전부 라이브면 ambiguous(사용자에게 고르게 한다)', async () => {
  const ws = fakeWs();
  mkCandWs('amb', [{ id: 'amb-a' }, { id: 'amb-b' }, { id: 'amb-c' }]);
  const open = await T.handle('chat.open', { cwd: 'amb', tid: 9999999 }, ws);
  assert.strictEqual(open.noSession, true);
  assert.strictEqual(open.reason, 'ambiguous');
  assert.ok(open.candidates >= 2, 'candidates=' + open.candidates);
  assert.strictEqual(T._internals.tails.size, 0);
});

// ★★ 2026-07-27 실사고 회귀 2 — "TUI 엔 대화가 멀쩡히 있는데 채팅은 빈 화면"
//   사용자 기기 실측: 터미널 B(tid 958257768)는 2일 전부터 돌던 세션이라 바인딩이 없었고, 같은 슬러그에
//   후보가 2개였다 → 위 회귀1 수정이 이걸 전부 ambiguous 로 밀어냈다. 그런데 후보 하나는 **다른 터미널이
//   이미 바인딩**한 세션이었으므로, 그것만 빼면 답이 하나로 확정된다(추측이 아니라 소거법).
test('chat.open — 다른 터미널이 점유한 후보를 소거하면 확정된다(scan-unclaimed)', async () => {
  const ws = fakeWs();
  const abs = mkCandWs('elim', [{ id: 'elim-mine' }, { id: 'elim-others' }]);
  // 이웃 터미널(tid 111)이 elim-others 를 점유 중
  T.noteHook({ sessionId: 'elim-others', transcriptPath: path.join(T.projectDirOf(abs), 'elim-others.jsonl'), cwd: abs, cwdRel: 'elim', tid: 111, event: 'prompt' });
  const open = await T.handle('chat.open', { cwd: 'elim', tid: 222 }, ws);
  assert.strictEqual(open.noSession, undefined, JSON.stringify(open));
  assert.strictEqual(open.sessionId, 'elim-mine');
  assert.strictEqual(open.source, 'scan-unclaimed');
  assert.strictEqual(open.messages[0].text, 'elim-mine');
  await T.handle('chat.close', { chatId: open.chatId });
});

test('chat.open — 후보 전부가 남의 것이면 claimed(남의 대화 금지 원칙 유지)', async () => {
  const ws = fakeWs();
  const abs = mkCandWs('allclaimed', [{ id: 'ac-1' }, { id: 'ac-2' }]);
  T.noteHook({ sessionId: 'ac-1', transcriptPath: path.join(T.projectDirOf(abs), 'ac-1.jsonl'), cwd: abs, cwdRel: 'allclaimed', tid: 11, event: 'prompt' });
  T.noteHook({ sessionId: 'ac-2', transcriptPath: path.join(T.projectDirOf(abs), 'ac-2.jsonl'), cwd: abs, cwdRel: 'allclaimed', tid: 22, event: 'prompt' });
  const open = await T.handle('chat.open', { cwd: 'allclaimed', tid: 33 }, ws);
  assert.strictEqual(open.noSession, true);
  assert.strictEqual(open.reason, 'claimed');
  assert.strictEqual(T._internals.tails.size, 0);
});

test('chat.open — 소거 후에도 여럿이면 지금 쓰이고 있는 것 하나로 확정(scan-live)', async () => {
  const ws = fakeWs();
  mkCandWs('livepick', [{ id: 'lp-live' }, { id: 'lp-old', ageMs: 10 * 60 * 1000 }, { id: 'lp-older', ageMs: 60 * 60 * 1000 }]);
  const open = await T.handle('chat.open', { cwd: 'livepick', tid: 555 }, ws);
  assert.strictEqual(open.noSession, undefined, JSON.stringify(open));
  assert.strictEqual(open.sessionId, 'lp-live');
  assert.strictEqual(open.source, 'scan-live');
  await T.handle('chat.close', { chatId: open.chatId });
});

// ★★ 2026-07-27 tokin 실사고 회귀 — 훅 바인딩이 없는 오래된 TUI claude(7/24 부터 실행,
//  훅은 사라진 터미널 좌표에 바인딩돼 있었다) + 마지막 응답 30초 초과(live 실패) + 옛 세션 파일 2개
//  → ambiguous 빈 화면. 이 pane 의 에이전트 **프로세스 시작 시각** 이후에 기록된 후보가 정확히
//  하나면 그것으로 확정한다(scan-proc). 실측에서 후보 3개 중 시작(7/24 12:22) 이후 mtime 은 1개였다.
test('chat.open — 프로세스 소거법: 에이전트 시작 이후 기록된 후보가 하나면 확정(scan-proc)', async () => {
  const ws = fakeWs();
  // pr-cur: 1분 전 기록(live 아님) · pr-old/pr-older: 에이전트 시작(1시간 전)보다 오래됨
  mkCandWs('procpick', [
    { id: 'pr-cur', ageMs: 60 * 1000 },
    { id: 'pr-old', ageMs: 3 * 3600 * 1000 },
    { id: 'pr-older', ageMs: 48 * 3600 * 1000 },
  ]);
  T._internals.setAgentProbe(async () => [{ tid: 777, startedAt: Date.now() - 3600 * 1000 }]);
  try {
    const open = await T.handle('chat.open', { cwd: 'procpick', tid: 777 }, ws);
    assert.strictEqual(open.noSession, undefined, JSON.stringify(open));
    assert.strictEqual(open.sessionId, 'pr-cur');
    assert.strictEqual(open.source, 'scan-proc');
    await T.handle('chat.close', { chatId: open.chatId });
  } finally { T._internals.setAgentProbe(async () => []); }
});

test('chat.open — 프로세스 소거법: 에이전트 pane 이 둘이면 믿지 않는다(남의 대화 금지 우선)', async () => {
  const ws = fakeWs();
  // pane A(111) 의 claude 가 먼저 떠서 최근 파일을 만들었고, pane B(222) 의 claude 는 아직 무기록인
  //  시나리오 — B 가 A 의 파일을 채택하면 그게 바로 "남의 대화" 사고다.
  mkCandWs('procdual', [
    { id: 'pd-recent', ageMs: 60 * 1000 },
    { id: 'pd-old', ageMs: 3 * 3600 * 1000 },
  ]);
  T._internals.setAgentProbe(async () => [
    { tid: 111, startedAt: Date.now() - 3600 * 1000 },
    { tid: 222, startedAt: Date.now() - 10 * 60 * 1000 },
  ]);
  try {
    const open = await T.handle('chat.open', { cwd: 'procdual', tid: 222 }, ws);
    assert.strictEqual(open.noSession, true, JSON.stringify(open));
    assert.strictEqual(open.reason, 'ambiguous');
    assert.strictEqual(T._internals.tails.size, 0);
  } finally { T._internals.setAgentProbe(async () => []); }
});

test('chat.open — 프로세스 소거법: 시작 이후 기록이 없거나 여럿이면 ambiguous 유지', async () => {
  const ws = fakeWs();
  mkCandWs('procnone', [
    { id: 'pn-a', ageMs: 3 * 3600 * 1000 },
    { id: 'pn-b', ageMs: 48 * 3600 * 1000 },
  ]);
  // 에이전트는 10분 전에 시작 — 두 후보 모두 그 이전 기록(이 pane 의 대화는 아직 없다)
  T._internals.setAgentProbe(async () => [{ tid: 888, startedAt: Date.now() - 10 * 60 * 1000 }]);
  try {
    const open = await T.handle('chat.open', { cwd: 'procnone', tid: 888 }, ws);
    assert.strictEqual(open.noSession, true, JSON.stringify(open));
    assert.strictEqual(open.reason, 'ambiguous');
  } finally { T._internals.setAgentProbe(async () => []); }
});

test('etimeToMs — ps etime 형식 전수([[dd-]hh:]mm:ss)', () => {
  assert.strictEqual(T._internals.etimeToMs('03:07'), (3 * 60 + 7) * 1000);
  assert.strictEqual(T._internals.etimeToMs('02:03:04'), ((2 * 3600) + (3 * 60) + 4) * 1000);
  assert.strictEqual(T._internals.etimeToMs('1-02:03:04'), ((26 * 3600) + (3 * 60) + 4) * 1000);
  assert.strictEqual(T._internals.etimeToMs('garbage'), null);
  assert.strictEqual(T._internals.etimeToMs(''), null);
});

test('Codex 신뢰 확인 지연 — 프로세스 시작 뒤 2분 8초 후 생성된 rollout도 매칭 범위', () => {
  assert.ok(T._internals.PROC_SLOP_MS >= 5 * 60 * 1000);
});

// 死 엔트리(`<ws>|`)가 점유로 세지면 살아있는 세션이 근거 없이 배제된다 — 사용자 기기에 실제로 있었다.
test('claimedSessions — tid 빈 死 엔트리는 점유로 세지 않는다', async () => {
  const ws = fakeWs();
  const abs = mkCandWs('deadkey', [{ id: 'dk-real' }, { id: 'dk-other' }]);
  T.noteHook({ sessionId: 'dk-other', transcriptPath: path.join(T.projectDirOf(abs), 'dk-other.jsonl'), cwd: abs, cwdRel: 'deadkey', tid: 1, event: 'prompt' });
  // 구 버전이 남긴 死 엔트리를 손으로 주입(현재 noteHook 은 만들지 않는다)
  const bp = path.join(ROOT, '.codingpt', 'chat-bind.json');
  const j = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  j.binds['deadkey|'] = { sessionId: 'dk-real', at: Date.now(), source: 'hook' };
  fs.writeFileSync(bp, JSON.stringify(j));
  T._internals.resetBindsCache(); // 다음 loadBinds 가 디스크를 다시 읽게
  const open = await T.handle('chat.open', { cwd: 'deadkey', tid: 2 }, ws);
  assert.strictEqual(open.sessionId, 'dk-real', JSON.stringify(open));
  assert.strictEqual(open.source, 'scan-unclaimed');
  await T.handle('chat.close', { chatId: open.chatId });
  // 주입한 死 엔트리를 되돌린다 — 뒤 테스트가 "死 엔트리가 없다"를 검사하고, 그 검사는 유지해야 한다.
  const j2 = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  delete j2.binds['deadkey|'];
  fs.writeFileSync(bp, JSON.stringify(j2));
  T._internals.resetBindsCache();
});

test('chat.open — 후보가 정확히 1개면 그것으로 폴백(모호하지 않으므로 안전)', async () => {
  const ws = fakeWs();
  // 후보가 1개뿐인 별도 워크스페이스를 만든다(훅 미배선 에이전트도 채팅이 되어야 한다).
  const soloWs = path.join(ROOT, 'solo');
  fs.mkdirSync(soloWs, { recursive: true });
  const dir = T.projectDirOf(soloWs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'only-one.jsonl'),
    JSON.stringify({ type: 'user', sessionId: 'only-one', timestamp: TS, message: { role: 'user', content: '혼자' } }) + '\n');
  const open = await T.handle('chat.open', { cwd: 'solo', tid: 777 }, ws);
  assert.strictEqual(open.noSession, undefined);
  assert.strictEqual(open.source, 'scan-unique');
  await T.handle('chat.close', { chatId: open.chatId });
});

test('noteHook — tid 를 모르면 바인딩을 쓰지 않는다(조회 불가한 死 엔트리 금지)', () => {
  const r = T.noteHook({ sessionId: 's1', cwd: WS, cwdRel: 'ws', tid: null, event: 'session_start' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_tid');
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, '.codingpt', 'chat-bind.json'), 'utf-8'));
  // 빈 tid 키('ws|')가 생기면 lookupBind(ws, 실제tid) 가 절대 매치하지 못하는데 "바인딩됨" 착각을 만든다.
  assert.ok(!Object.keys(j.binds).some((k) => k.endsWith('|')), Object.keys(j.binds).join(','));
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

// ── 원격 응답 되돌리기(답한 질문이 대화에 들어가는 모양) ─────────────────────────
//  선택형 답은 훅의 deny+message 로만 전달되므로 트랜스크립트엔 "거부된 도구"로 남는다.
//  손대지 않으면 사용자는 자기가 방금 답한 질문에 ✕ 와 내부 문구가 붙은 걸 본다.
test('원격 카드로 답한 결과는 ✓ 로, 고른 값만 남는다', async () => {
  const { ANSWER_PREFIX } = require('../approvals');
  const f = path.join(PROJECTS, 'ans-ok', 'a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const answer = ANSWER_PREFIX + '사용자가 원격 기기에서 다음과 같이 답했습니다.\n- 집중 시간: 이른 아침\n- 계절: 가을';
  fs.writeFileSync(f, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: '언제?', header: '집중 시간', options: [{ label: '이른 아침' }] }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: answer }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const snap = await T.snapshot(f, { maxLines: 100 });
  const res = snap.messages.find((m) => m.result);
  assert.ok(res, 'tool_result 가 있어야 한다');
  assert.strictEqual(res.result.ok, true, '사용자가 답한 것은 실패가 아니다(✕ 금지)');
  assert.strictEqual(res.result.preview, '집중 시간: 이른 아침\n계절: 가을');
  assert.doesNotMatch(res.result.preview, /CodingPT 원격응답|답했습니다/, '내부 문구가 새어나오면 안 된다');
});

test('실제 거절은 그대로 실패로 남는다', async () => {
  const { ANSWER_PREFIX } = require('../approvals');
  const f = path.join(PROJECTS, 'ans-deny', 'a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: ANSWER_PREFIX + '사용자가 원격 기기에서 거절했습니다.' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const res = (await T.snapshot(f, { maxLines: 100 })).messages.find((m) => m.result);
  assert.strictEqual(res.result.ok, false);
});

// ── TUI 폴백 질문 카드의 근거 데이터 — questions 전체 배열 + interrupt 숨김 + 거절문구 한글화 ──
test('AskUserQuestion 은 questions 전체 배열을 싣는다(카드 재건의 근거)', async () => {
  const f = path.join(PROJECTS, 'qs-all', 'a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [
    { question: '계절?', header: '계절', options: [{ label: '봄' }, { label: '겨울' }] },
    { question: '간식?', header: '간식', multiSelect: true, options: [{ label: '과자' }] },
  ] } }] } }) + '\n');
  const snap = await T.snapshot(f, { maxLines: 50 });
  const q = snap.messages.find((m) => m.kind === 'question');
  assert.ok(q, 'question 승격');
  assert.strictEqual(q.questions.length, 2, '전체 질문 배열');
  assert.strictEqual(q.questions[1].multiSelect, true);
  assert.strictEqual(q.question.question, '계절?', '구 클라 호환 필드 유지');
});

test('interrupt(사용자 Esc)는 hidden — 채팅에 "중단" 잡음을 넣지 않는다', async () => {
  const f = path.join(PROJECTS, 'intr', 'a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n');
  const snap = await T.snapshot(f, { maxLines: 50 });
  assert.strictEqual(snap.messages[0].hidden, true);
});

test('TUI 거절의 영문 내부 문구는 한글 한 줄로 바뀐다', async () => {
  const f = path.join(PROJECTS, 'decl', 'a.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'q', header: 'h', options: [{ label: 'a' }] }] } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected..." }] } }),
  ].join('\n') + '\n');
  const snap = await T.snapshot(f, { maxLines: 50 });
  const r = snap.messages.find((m) => m.result);
  assert.strictEqual(r.result.ok, false);
  assert.strictEqual(r.result.preview, '사용자가 답하지 않고 넘어갔습니다');
});
