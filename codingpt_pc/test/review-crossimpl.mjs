// review-crossimpl.mjs — 코드 리뷰의 **PC ↔ 앱 ↔ 데몬** 계약 고정.
//
// 이 기능의 핵심 위험:
//  ① **덩어리를 다르게 세는 것.** 화면은 "몇 번째 덩어리를 승인했다"를 그대로 에이전트에게 돌려준다.
//    PC 와 폰이 같은 diff 에서 덩어리를 다르게 세면 **엉뚱한 곳을 승인한 결과**가 간다.
//    → 두 파서를 실제로 돌려 같은 diff 코퍼스에서 같은 결과가 나오는지 본다.
//  ② **취소가 승인으로 둔갑하는 것.** 사용자가 창을 닫았는데 "전부 승인"이 가면 안 본 변경이 통과한다.
//  ③ **제출·취소를 에이전트에게 광고하지 않는 것.** CAPABILITIES 는 광고 목록이지 차단 게이트가
//    아니다(실측: 소켓으로 직접 부르면 핸들러까지 닿는다 — `agents.wire` 도 같다). 그래도 광고하지
//    않는 이유는 footgun 을 문서화하지 않기 위해서다. 실제로 이게 방어가 되는 근거는 따로 있다:
//    `cpt review` 는 **에이전트가 스스로 부르는 도구**라(사용자 확정: 강제 관문 아님) 자기 리뷰를
//    승인해 봐야 얻는 게 없다 — 리뷰를 아예 안 부르면 그만이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const DAEMON = path.resolve('../codingpt_daemon/packages/runner-core');
const CLI = path.resolve('../codingpt_daemon/packages/cpt-cli/bin/cpt.js');
const BACK = path.resolve('../codingpt_back');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let seq = 0;
function probe(modPath, body) {
  const script = `const m = await import(${JSON.stringify('file://' + modPath)});\n${body}`;
  const tmp = path.join(os.tmpdir(), `rvprobe-${process.pid}-${seq++}.mjs`);
  fs.writeFileSync(tmp, script);
  try {
    return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', tmp], { encoding: 'utf8' }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}

// ── 1. 파서 실행 대조 ────────────────────────────────────────────────────────
// 실제 git 이 내는 모양들: 여러 덩어리 / 파일 생성 / 끝줄 없음 / 빈 문맥줄 / CRLF 잔재.
const DIFFS = [
  // 흔한 형태(헤더 포함, 덩어리 2개)
  'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,4 +1,5 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n module.exports = {};\n@@ -20,3 +21,4 @@ function far() {\n   return 1;\n+  // new\n }\n',
  // 새 파일(/dev/null)
  'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n',
  // 끝줄 없음 메타
  '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n',
  // 빈 문맥 줄(공백 하나) — 버리면 줄 번호가 어긋난다
  '--- a/y\n+++ b/y\n@@ -1,3 +1,3 @@\n \n-a\n+b\n',
  // 삭제만
  '--- a/z\n+++ b/z\n@@ -5,3 +5,1 @@\n keep\n-gone1\n-gone2\n',
  // 덩어리 헤더에 함수명이 붙는 형태
  '--- a/w\n+++ b/w\n@@ -10,2 +10,3 @@ class Foo:\n     pass\n+    x = 1\n',
  // 빈 문자열/쓰레기
  '',
  'not a diff at all\njust text\n',
];

const BODY = `
  const dumps = ${JSON.stringify(DIFFS)}.map((d) => m.parseHunks(d).map((h) => ({
    i: h.index, hdr: h.header, os: h.oldStart, ns: h.newStart, a: h.adds, d: h.dels,
    lines: h.lines.map((l) => [l.type, l.text, l.oldNo, l.newNo]),
  })));
  const files = [{ path: 'a.js', hunks: 2 }, { path: 'b.md', hunks: 1 }];
  const decisions = { 'a.js#0': 'approve', 'a.js#1': 'reject', 'b.md#0': 'approve' };
  const partial = { 'a.js#0': 'approve' };
  const comments = [{ path: 'a.js', hunk: 0, side: 'new', line: 2, text: '여기 상수로' }];
  console.log(JSON.stringify({
    dumps,
    summaries: ${JSON.stringify(DIFFS)}.map((d) => m.summarize(d)),
    verdicts: [
      m.fileVerdict(files[0], decisions), m.fileVerdict(files[1], decisions),
      m.fileVerdict(files[0], partial), m.fileVerdict(files[0], {}),
      m.fileVerdict({ path: 'empty', hunks: 0 }, {}),
    ],
    decided: [m.allDecided(files, decisions), m.allDecided(files, partial)],
    left: [m.undecidedCount(files, decisions), m.undecidedCount(files, partial), m.undecidedCount(files, {})],
    submission: m.buildSubmission(files, decisions, comments, '  전체적으로 좋아요  '),
    emptyNote: m.buildSubmission(files, decisions, comments, '   ').note,
    commentable: [['add','del','ctx','meta'].map((t) => m.isCommentable({ type: t }))],
    anchors: [
      m.anchorOf({ type: 'add', newNo: 7, oldNo: null }),
      m.anchorOf({ type: 'del', newNo: null, oldNo: 3 }),
      m.anchorOf({ type: 'ctx', newNo: 1, oldNo: 1 }),
    ],
  }));
`;
const pcOut = probe(path.join(PC, 'diff-parse.js'), BODY);
const appOut = probe(path.join(APP, 'workspace/ide/diffParse.ts'), BODY);

const dumpDiff = DIFFS.map((d, i) => [i, JSON.stringify(pcOut.dumps[i]), JSON.stringify(appOut.dumps[i])])
  .filter(([, a, b]) => a !== b);
ok(dumpDiff.length === 0, `diff ${DIFFS.length}종의 덩어리·줄·줄번호가 **완전히** 일치`,
  dumpDiff.map(([i]) => `#${i}`).join(','));
ok(JSON.stringify(pcOut.summaries) === JSON.stringify(appOut.summaries), '요약(+/−/덩어리 수) 일치');
ok(JSON.stringify(pcOut.verdicts) === JSON.stringify(appOut.verdicts), '파일 판정 일치');
ok(JSON.stringify(pcOut.decided) === JSON.stringify(appOut.decided), '"전부 정했나" 판정 일치');
ok(JSON.stringify(pcOut.left) === JSON.stringify(appOut.left), '남은 개수 일치');
ok(JSON.stringify(pcOut.submission) === JSON.stringify(appOut.submission), '제출 페이로드 일치');
ok(JSON.stringify(pcOut.anchors) === JSON.stringify(appOut.anchors), '코멘트 좌표 일치');
ok(JSON.stringify(pcOut.commentable) === JSON.stringify(appOut.commentable), '코멘트 가능 줄 판정 일치');

// 둘이 똑같이 틀린 경우를 잡는다 — 판정 자체가 말이 되는가.
const d0 = pcOut.dumps[0];
ok(d0.length === 2 && d0[0].i === 0 && d0[1].i === 1, '덩어리 번호는 파일 안에서 0부터 순서대로');
ok(d0[0].a === 2 && d0[0].d === 1, '추가/삭제 줄 수를 맞게 센다', JSON.stringify([d0[0].a, d0[0].d]));
// `-const b = 2;` 는 옛 2행, `+const b = 3;` 는 새 2행 — 두 번호가 서로를 침범하면 안 된다.
const del = d0[0].lines.find((l) => l[0] === 'del');
const add = d0[0].lines.find((l) => l[0] === 'add');
ok(del[2] === 2 && del[3] === null, '삭제 줄은 옛 번호만 갖는다', JSON.stringify(del));
ok(add[3] === 2 && add[2] === null, '추가 줄은 새 번호만 갖는다', JSON.stringify(add));
ok(pcOut.dumps[2][0].lines.some((l) => l[0] === 'meta'),
  '`\\ No newline` 은 변경 줄이 아니라 메타다');
ok(pcOut.dumps[2][0].a === 1 && pcOut.dumps[2][0].d === 1, '메타 줄을 변경 줄로 세지 않는다');
ok(pcOut.dumps[3][0].lines[0][0] === 'ctx' && pcOut.dumps[3][0].lines[0][1] === '',
  '빈 문맥 줄을 버리지 않는다(버리면 줄 번호가 어긋난다)');
ok(pcOut.dumps[6].length === 0 && pcOut.dumps[7].length === 0, 'diff 가 아니면 덩어리 0개(우연한 파싱 금지)');
// ★ 끝 개행이 만드는 빈 원소를 줄로 세면 문맥 줄이 하나 더 생겨 **그 뒤 줄 번호가 전부 1씩 밀린다**
//   → 코멘트 좌표가 어긋나 에이전트가 엉뚱한 줄을 고친다. 실제 `git diff` 출력으로 잡힌 결함이라,
//   인위적 샘플만 보던 이 테스트도 함께 뚫렸었다(두 구현이 똑같이 틀렸다).
{
  const withNl = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
  const noNl = withNl.slice(0, -1);
  const q = (d) => `console.log(JSON.stringify([
    m.parseHunks(${JSON.stringify(d)})[0].lines.length,
    m.parseHunks(${JSON.stringify(d)})[0].lines.map((l) => l.newNo),
  ]))`;
  const a1 = probe(path.join(PC, 'diff-parse.js'), q(withNl));
  const a2 = probe(path.join(APP, 'workspace/ide/diffParse.ts'), q(withNl));
  const b1 = probe(path.join(PC, 'diff-parse.js'), q(noNl));
  ok(JSON.stringify(a1) === JSON.stringify(a2), '끝 개행 처리 일치');
  ok(a1[0] === 4 && b1[0] === 4, '★ 끝 개행이 유령 문맥 줄을 만들지 않는다', JSON.stringify([a1[0], b1[0]]));
  ok(JSON.stringify(a1[1]) === JSON.stringify([1, null, 2, 3]),
    '★ 줄 번호가 밀리지 않는다(코멘트 좌표가 통째로 어긋나는 결함)', JSON.stringify(a1[1]));
}
ok(pcOut.verdicts[0] === 'rejected', '하나라도 거절이면 파일은 rejected');
ok(pcOut.verdicts[1] === 'approved', '전부 승인이면 approved');
ok(pcOut.verdicts[2] === 'partial' && pcOut.verdicts[3] === 'partial', '안 정한 게 있으면 partial');
ok(pcOut.commentable[0].join(',') === 'true,true,false,false',
  '코멘트는 **바뀐 줄에만** 단다(문맥 줄 코멘트는 에이전트가 고칠 곳을 못 찾는다)');
ok(pcOut.emptyNote === undefined, '공백뿐인 메모는 보내지 않는다');
ok(pcOut.submission.note === '전체적으로 좋아요', '메모는 앞뒤 공백을 턴다');

// ── 2. 취소가 승인으로 둔갑하지 않는다(데몬 계약) ────────────────────────────
const reviewJs = strip(read(path.join(DAEMON, 'review.js')));
ok(/status: 'cancelled'/.test(reviewJs), '데몬이 취소를 별도 상태로 끝낸다');
ok(!/cancel[\s\S]{0,200}approve/i.test(reviewJs), '취소 경로에 승인이 섞이지 않는다');
ok(/status: 'timeout'/.test(reviewJs), '대기는 반드시 끝난다(타임아웃 상태 존재)');
// 무한루프 재발 방지 — finish 는 세션을 지우지 않으므로 prune 은 delete 까지 해야 한다.
ok(/finish\(oldest\.id[\s\S]{0,120}sessions\.delete\(oldest\.id\)/.test(reviewJs),
  '★ prune 이 취소 후 세션을 실제로 지운다(안 지우면 무한루프 — 실측으로 잡힌 결함)');

// ── 3. 에이전트가 자기 리뷰를 스스로 승인할 수 없다 ──────────────────────────
const server = read(path.join(DAEMON, 'cpt-server.js'));
const capsBlock = server.slice(server.indexOf('const CAPABILITIES'), server.indexOf('const CAPABILITIES') + 3000);
ok(/'ui\.review'/.test(capsBlock), '요청(ui.review)은 에이전트에게 공개한다');
ok(!/'review\.(submit|cancel|get|pending)'/.test(capsBlock),
  '제출·취소는 에이전트에게 광고하지 않는다(CAPABILITIES 는 광고 목록 — 차단 게이트가 아니다)');
ok(/cmd\.startsWith\('review\.'\)/.test(server), '화면이 부르는 review.* RPC 는 따로 열려 있다');

// ── 4. 3플랫폼 배선이 전부 있다 ──────────────────────────────────────────────
ok(/case 'review'/.test(read(path.join(APP, 'workspace/UiCommandBridge.tsx'))), '앱이 review 명령을 받는다');
ok(/'review',/.test(read(path.join(APP, 'workspace/uiCommandNames.ts'))),
  '앱이 review 를 **신고**한다(신고 없으면 서버가 이 화면을 안 고른다 — 조용한 유실)');
ok(/review: async/.test(read(path.join(PC, 'ui-channel.js'))), 'PC 가 review 명령을 받는다');
ok(/openReview/.test(read(path.join(PC, 'ide.js'))), 'PC IDE 가 리뷰를 연다');
ok(/openReview/.test(read(path.join(APP, 'workspace/IdeBody.tsx'))), '앱 IDE 가 리뷰를 연다');
ok(/review_local/.test(read(path.resolve('src-tauri/src/cptsock.rs'))), 'PC 는 이 PC 리뷰를 소켓으로 바로 제출한다');
ok(/review\/submit/.test(read(path.join(BACK, 'routes/daemonRoutes.js'))), 'back 이 제출 경로를 중계한다');
ok(/reviewSubmit/.test(read(path.join(APP, 'services/daemonService.ts'))), '앱이 제출 경로를 갖는다');
ok(/case 'review':/.test(read(CLI)), 'cpt CLI 에 review 명령이 있다');

// ── ★ back 이 릴레이하는 RPC 는 **데몬 control.js 에 라우트가 있어야 한다** ──────────
//  실측으로 잡힌 결함: review.* 를 유닉스 소켓 디스패치(cpt-server)에만 달아 둬서, 폰의 [보내기]가
//  back → 데몬 control WS 로 들어온 뒤 "알 수 없는 메서드"로 조용히 실패했다. "back 라우트가 있다"와
//  "앱에 함수가 있다"만 보면 이 구멍을 못 본다 — 데몬 입구를 함께 본다.
const control = strip(read(path.join(DAEMON, 'control.js')));
const backCtl = strip(read(path.join(BACK, 'controllers/daemonController.js')));
const relayed = [...new Set((backCtl.match(/callRpc\(req\.user\.id,\s*'([a-zA-Z]+)\./g) || [])
  .map((m) => (/'([a-zA-Z]+)\./.exec(m) || [])[1]))].filter(Boolean);
// 라우팅은 접두사(`startsWith('qc.')`)일 수도 정확 일치(`method === 'net.ports'`)일 수도 있다 —
//  둘 다 인정한다(접두사만 보면 net.ports 를 오탐한다).
const missing = relayed.filter((fam) => !new RegExp(
  `startsWith\\('${fam}\\.'\\)|method === '${fam}\\.`).test(control));
ok(missing.length === 0,
  `back 이 릴레이하는 RPC 계열 ${relayed.length}종이 전부 데몬 control.js 에 라우트가 있다`,
  '라우트 없음: ' + missing.join(', '));
ok(relayed.includes('review'), '리뷰가 그 검사 대상에 실제로 포함돼 있다', relayed.join(','));
ok(/handleReviewRpc/.test(control) && /handleReviewRpc/.test(read(path.join(DAEMON, 'cpt-server.js'))),
  '소켓 입구와 릴레이 입구가 **같은 함수**를 탄다');

// ── 5. 문구 사전 ─────────────────────────────────────────────────────────────
const pcText = await import(path.join(PC, 'text/review.js'));
const appSrc = read(path.join(APP, 'text/review.ts'));
const appBody = appSrc.slice(appSrc.indexOf('export const REVIEW_TEXT'));
const appDict = (await import('data:text/javascript,' + encodeURIComponent(
  appBody.replace('export const REVIEW_TEXT: Dict<ReviewText> =', 'export const REVIEW_TEXT =')
    .replace(/\(n: number\)/g, '(n)')))).REVIEW_TEXT;

for (const lang of ['ko', 'en']) {
  const a = appDict[lang], p = pcText.REVIEW_TEXT[lang];
  const aK = Object.keys(a).sort(), pK = Object.keys(p).sort();
  ok(JSON.stringify(aK) === JSON.stringify(pK), `키 집합 일치(${lang}) — ${pK.length}개`,
    `app-only=${aK.filter((k) => !pK.includes(k))} pc-only=${pK.filter((k) => !aK.includes(k))}`);
  const strs = pK.filter((k) => typeof p[k] === 'string');
  const diff = strs.filter((k) => a[k] !== p[k]);
  ok(diff.length === 0, `문구 ${strs.length}개 글자까지 일치(${lang})`, diff.join(', '));
  // 개수가 들어가는 문구는 함수여야 한다(어순이 언어마다 다르다 — text/index 규율).
  ok(typeof p.remaining === 'function' && typeof a.remaining === 'function', `개수 문구는 함수 값(${lang})`);
  ok(p.remaining(3) === a.remaining(3) && p.commentCount(0) === a.commentCount(0),
    `함수 문구 결과도 일치(${lang})`, `${p.remaining(3)} vs ${a.remaining(3)}`);
}

console.log(`\n${fail === 0 ? 'ALL CONFORMANT' : 'NOT CONFORMANT'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
