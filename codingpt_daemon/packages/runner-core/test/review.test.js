// 코드 리뷰 세션 — 에이전트를 붙잡는 쪽의 계약.
//
// 이 파일이 고정하는 것:
//  · 대기는 **반드시 끝난다**. 에이전트를 영원히 붙잡으면 그 터미널이 죽은 것처럼 보인다.
//  · 취소는 승인이 아니다. 사용자가 창을 닫았는데 "전부 승인"이 에이전트로 가면 안 본 변경이
//    통과한다 — 이 기능의 가장 나쁜 실패다.
//  · 코멘트에서 제어문자(특히 ESC)를 지운다. 코멘트는 **에이전트의 터미널로 되돌아간다** —
//    ESC 가 섞이면 그 터미널이 오작동한다.
//  · 사라진 리뷰는 "없다"고 분명히 답한다(화면이 유령을 붙들지 않게).
const { test } = require('node:test');
const assert = require('node:assert');

const review = require('../review');

function mk(over) {
  return review.create({
    title: '테스트 리뷰',
    ws: 'proj',
    cwd: '/tmp/proj',
    files: [{ path: 'a.js', diffText: '@@ -1,2 +1,3 @@\n a\n+b\n' }],
    ...over,
  });
}

test('만들고 화면 페이로드로 낸다', () => {
  review._reset();
  const s = mk();
  const p = review.payload(s);
  assert.strictEqual(p.reviewId, s.id);
  assert.strictEqual(p.status, 'pending');
  assert.strictEqual(p.files.length, 1);
  assert.match(p.files[0].diffText, /@@/);
});

test('변경이 없으면 만들지 않는다', () => {
  review._reset();
  assert.throws(() => review.create({ files: [] }), /리뷰할 변경이 없습니다/);
});

test('제출하면 기다리던 쪽이 결과를 받는다', async () => {
  review._reset();
  const s = mk();
  const waiting = review.waitFor(s.id, 5000);
  review.submit(s.id, {
    files: [{
      path: 'a.js',
      verdict: 'approved',
      hunks: [{ index: 0, decision: 'approve' }],
      comments: [{ hunk: 0, side: 'new', line: 2, text: '여기 이름 바꿔줘' }],
    }],
    note: '나머지는 좋아요',
  });
  const r = await waiting;
  assert.strictEqual(r.status, 'submitted');
  assert.strictEqual(r.files[0].verdict, 'approved');
  assert.strictEqual(r.files[0].comments[0].text, '여기 이름 바꿔줘');
  assert.strictEqual(r.note, '나머지는 좋아요');
});

test('★ 취소는 승인이 아니다 — 안 본 것은 안 본 것이다', async () => {
  review._reset();
  const s = mk();
  const waiting = review.waitFor(s.id, 5000);
  review.cancel(s.id, 'closed');
  const r = await waiting;
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.reason, 'closed');
  assert.strictEqual(r.files, undefined);   // 승인 목록이 딸려 가지 않는다
});

test('★ 대기는 반드시 끝난다(타임아웃) — 그리고 세션도 함께 닫힌다', async () => {
  review._reset();
  const s = mk();
  const r = await review.waitFor(s.id, 1000);
  assert.strictEqual(r.status, 'timeout');
  // 유령이 남지 않는다 — 화면이 나중에 물어도 pending 이 아니다.
  assert.strictEqual(review.get(s.id).status, 'timeout');
  assert.strictEqual(review.listPending('proj').length, 0);
});

test('없는 리뷰를 기다리면 즉시 not_found', async () => {
  review._reset();
  assert.deepStrictEqual(await review.waitFor('rv_nope', 5000), { status: 'not_found' });
});

test('이미 끝난 리뷰는 두 번 제출되지 않는다', () => {
  review._reset();
  const s = mk();
  review.submit(s.id, { files: [] });
  assert.throws(() => review.submit(s.id, { files: [] }), /이미 끝난/);
  assert.throws(() => review.submit('rv_nope', { files: [] }), /찾을 수 없습니다/);
});

test('끝난 뒤에 기다리면 그 결과를 그대로 준다(늦게 붙은 쪽도 답을 받는다)', async () => {
  review._reset();
  const s = mk();
  review.submit(s.id, { files: [{ path: 'a.js', verdict: 'rejected', hunks: [{ index: 0, decision: 'reject' }] }] });
  const r = await review.waitFor(s.id, 5000);
  assert.strictEqual(r.status, 'submitted');
  assert.strictEqual(r.files[0].verdict, 'rejected');
});

test('★ 코멘트의 제어문자(ESC)를 지운다 — 에이전트 터미널로 되돌아가는 글이다', () => {
  review._reset();
  const s = mk();
  const esc = String.fromCharCode(27);
  review.submit(s.id, {
    files: [{ path: 'a.js', verdict: 'approved', hunks: [], comments: [{ hunk: 0, text: `앞${esc}[31m빨강${esc}[0m뒤\t줄\n바꿈` }] }],
    note: `노트${esc}[2J`,
  });
  const c = review.get(s.id).result.files[0].comments[0];
  assert.strictEqual(c.text.includes(esc), false);
  assert.strictEqual(c.text, '앞[31m빨강[0m뒤\t줄\n바꿈');   // 탭·줄바꿈은 남는다
  assert.strictEqual(review.get(s.id).result.note.includes(esc), false);
});

test('빈 코멘트는 버린다(화면의 실수 입력이 에이전트에게 가지 않게)', () => {
  review._reset();
  const s = mk();
  review.submit(s.id, {
    files: [{ path: 'a.js', verdict: 'approved', hunks: [], comments: [{ hunk: 0, text: '' }, { hunk: 0, text: '진짜' }] }],
  });
  assert.deepStrictEqual(review.get(s.id).result.files[0].comments.map((c) => c.text), ['진짜']);
});

test('대기 목록은 워크스페이스로 걸러진다(다른 프로젝트 리뷰가 끼지 않게)', () => {
  review._reset();
  mk({ ws: 'proj' });
  mk({ ws: 'other' });
  assert.strictEqual(review.listPending('proj').length, 1);
  assert.strictEqual(review.listPending('other').length, 1);
  assert.strictEqual(review.listPending().length, 2);
});

test('세션이 넘치면 오래된 것부터 취소로 닫는다(기다리던 쪽도 함께 풀린다)', async () => {
  review._reset();
  const first = mk();
  const waiting = review.waitFor(first.id, 5000);
  for (let i = 0; i < review.MAX_SESSIONS; i++) mk();
  const r = await waiting;
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.reason, 'too_many');
});

test('파일 수 상한을 넘기지 않는다', () => {
  review._reset();
  const files = Array.from({ length: review.MAX_FILES + 10 }, (_, i) => ({ path: `f${i}.js`, diffText: '@@ -1 +1 @@\n-a\n+b\n' }));
  const s = review.create({ files });
  assert.strictEqual(s.files.length, review.MAX_FILES);
});
