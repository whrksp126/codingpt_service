// 이슈 자동 저장(issues-autosave.js) — 순수 모델 검증. 가짜 타이머·가짜 RPC 로 돈다.
//  지키는 것: 빈 초안은 만들지 않는다 · 멈추면 한 번만 저장 · 요청은 한 번에 하나(늦은 응답이 새 입력을 못 덮는다) ·
//  실패하면 입력을 쥐고 다시 보낸다 · 다른 기기 변경은 고치는 중이 아닌 칸만 · 워크스페이스 선택지에 같은 프로젝트가 한 번만.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'js');
//  폰 앱의 같은 모델(issuesAutosave.ts)도 **같은 검증**으로 돌린다 — 두 구현이 갈라지면 여기서 걸린다.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../codingpt_app/src/workspace/issues/issuesAutosave.ts');
const IMPLS = [['pc', await import('file://' + path.join(PC, 'issues-autosave.js'))], ['app', await import('file://' + APP)]];
let fail = 0; let n = 0; let A = null; let impl = '';
const ok = (c, name, extra) => { n += 1; if (!c) { fail += 1; console.error('FAIL', `[${impl}]`, name, extra == null ? '' : extra); } };
const tick = () => new Promise((r) => setImmediate(r));

function rig(opts = {}) {
  const timers = []; const calls = []; const waits = []; const statuses = [];
  let seq = 0; let failNext = 0; let rev = opts.rev || 100;
  const call = (kind, a, b) => new Promise((res, rej) => {
    calls.push([kind, a, b]);
    const done = () => { if (failNext > 0) { failNext -= 1; rej(Object.assign(new Error('x'), { code: 'DAEMON_OFFLINE' })); } else res(kind === 'create' ? { id: 'iss_' + (++seq), rev: ++rev } : { rev: ++rev }); };
    if (opts.manual) waits.push(done); else done();
  });
  const s = A.createAutosaver({
    id: opts.id || null, fields: opts.fields || {}, rev: opts.rev0 || 0, keys: opts.keys,
    create: (f) => call('create', f), update: (id, p) => call('update', id, p),
    onStatus: (x) => statuses.push(x), onCreated: (id) => calls.push(['created', id]),
    setTimer: (fn, ms) => { const h = { fn, ms, on: true }; timers.push(h); return h; }, clearTimer: (h) => { h.on = false; },
  });
  const fire = async () => { const h = timers.filter((x) => x.on).pop(); if (!h) return null; h.on = false; h.fn(); await tick(); await tick(); return h.ms; };
  const armed = () => timers.filter((x) => x.on);
  return { s, calls, waits, statuses, fire, armed, failNext: (k) => { failNext = k; } };
}

for (const [implName, mod] of IMPLS) {
A = mod; impl = implName;
// 1) 빈 초안은 만들지 않는다
{
  const r = rig({ fields: { status: 'todo', cwd: 'a' } });
  r.s.set({ status: 'in_progress', priority: 'high' });
  ok(!r.armed().length && r.s.status() === 'idle', '속성만 바꾼 새 이슈는 저장 예약이 없다');
  r.s.set({ title: '   ', body: ' \n ' });
  const f = await r.s.flush();
  ok(f.id === null && f.ok && !r.calls.length, '공백뿐인 초안은 나가도 만들지 않는다', JSON.stringify(r.calls));
}
// 2) 첫 뜻 있는 입력에서 만들고, 그 뒤는 바뀐 칸만
{
  const r = rig({ fields: { cwd: 'a' } });
  r.s.set({ body: '본' }); r.s.set({ body: '본문' }); r.s.set({ body: '본문만' });
  ok(r.armed().length === 1 && r.armed()[0].ms === A.SAVE_DELAY_MS && r.s.status() === 'dirty', '연달아 쳐도 예약은 하나(디바운스)');
  await r.fire();
  ok(r.calls[0][0] === 'create' && r.calls[0][1].body === '본문만' && r.calls[0][1].title === '' && r.calls[0][1].cwd === 'a', '제목 없이 본문만으로 만든다', JSON.stringify(r.calls[0]));
  ok(r.s.id() === 'iss_1' && r.calls[1][0] === 'created' && r.s.status() === 'saved', '만든 뒤 id · saved');
  r.s.set({ title: ' 제목 ' });
  await r.fire();
  ok(JSON.stringify(r.calls[2]) === '["update","iss_1",{"title":"제목"}]', '바뀐 칸만 보낸다(앞뒤 공백 뗀 제목)', JSON.stringify(r.calls[2]));
  r.s.set({ title: '제목  ' });
  ok(!r.armed().length && r.s.status() === 'saved', '같은 값이면 저장하지 않는다');
  r.s.set({ labels: 'a,b , ' }); await r.fire();
  ok(r.calls[3][2].labels === 'a, b', '라벨은 정리해서 보낸다');
}
// 3) 보내는 중에 더 적은 글 — 겹쳐 보내지 않고, 옛 응답이 새 글을 덮지 않는다
{
  const r = rig({ id: 'x', fields: { title: 'T', body: 'a' }, manual: true });
  r.s.set({ body: 'ab' }); await r.fire();
  ok(r.calls.length === 1 && r.s.status() === 'saving', '보내는 중');
  r.s.set({ body: 'abc' }); r.s.set({ title: 'T2' });
  ok(r.calls.length === 1 && !r.armed().length, '보내는 중에는 겹쳐 보내지도, 예약하지도 않는다');
  r.waits.shift()(); await tick(); await tick();
  ok(r.s.fields().body === 'abc' && r.s.status() === 'dirty' && r.armed().length === 1, '옛 응답 뒤에도 새 글이 남아 다시 예약된다');
  const p = r.fire(); await tick(); r.waits.shift()(); await p; await tick();
  ok(JSON.stringify(r.calls[1][2]) === '{"title":"T2","body":"abc"}' && r.s.status() === 'saved', '두 번째 요청이 나머지를 한 번에 보낸다', JSON.stringify(r.calls[1]));
}
// 4) 실패 — 입력을 쥐고 간격을 두고 다시
{
  const r = rig({ id: 'x', fields: { title: 'T' } });
  r.failNext(2);
  r.s.set({ title: 'T1' }); await r.fire();
  ok(r.s.status() === 'error' && r.armed()[0].ms === A.RETRY_MS[0] && r.s.fields().title === 'T1', '실패하면 error · 첫 재시도 예약 · 입력은 그대로');
  ok((await r.fire()) === A.RETRY_MS[0] && r.s.status() === 'error' && r.armed()[0].ms === A.RETRY_MS[1], '또 실패하면 간격이 벌어진다');
  await r.fire();
  ok(r.s.status() === 'saved' && r.calls.length === 3 && r.calls[2][2].title === 'T1', '세 번째에 저장된다');
  r.failNext(1);
  r.s.set({ title: 'T2' });
  const f = await r.s.flush();
  ok(!f.ok && r.s.status() === 'error' && r.armed().length === 1, 'flush 가 실패하면 ok=false 이고 재시도가 남는다');
  r.s.set({ title: 'T3' });
  ok(r.armed()[0].ms === A.SAVE_DELAY_MS, '실패 뒤 다시 치면 곧 다시 보낸다');
  ok((await r.s.flush()).ok && r.calls[r.calls.length - 1][2].title === 'T3', '다시 flush 하면 최신 글이 간다');
}
// 5) 새 이슈 만들기 실패 → 입력 유지 → 재시도에 성공
{
  const r = rig({});
  r.failNext(1);
  r.s.set({ title: '오프라인에서 적음' }); await r.fire();
  ok(r.s.id() === null && r.s.status() === 'error' && r.s.fields().title === '오프라인에서 적음', '만들기 실패 — 초안은 그대로');
  await r.fire();
  ok(r.s.id() === 'iss_1' && r.calls.filter((c) => c[0] === 'create').length === 2, '재시도로 만들어진다(한 번만 만들어진다)');
}
// 6) flush · ensureCreated · dispose
{
  const r = rig({});
  ok((await r.s.ensureCreated()) === 'iss_1' && r.calls[0][0] === 'create', '첨부용 — 적은 것이 없어도 만든다');
  r.s.set({ body: 'x' });
  const f = await r.s.flush();
  ok(f.ok && !r.armed().length && r.calls[2][0] === 'update', 'flush 는 기다리지 않고 곧바로 보낸다');
  r.s.set({ body: 'xy' }); r.s.dispose();
  ok(!r.armed().length, 'dispose 는 예약을 거둔다');
  const r2 = rig({ fields: { title: 'a' }, manual: true });
  r2.s.set({ title: 'ab' });
  const p1 = r2.s.flush(); const p2 = r2.s.flush(); await tick();
  ok(r2.calls.length === 1, '겹친 flush 도 만들기는 한 번');
  r2.waits.shift()(); await p1; await p2;
  ok(r2.calls.filter((c) => c[0] === 'create').length === 1 && r2.s.id() === 'iss_1', '이슈가 둘 생기지 않는다');
}
// 7) 다른 기기 변경 — 고치는 중이 아닌 칸만
{
  const r = rig({ id: 'x', fields: { title: 'T', body: 'B', status: 'todo' }, rev0: 10 });
  ok(r.s.mergeRemote({ title: '옛', body: 'B', status: 'todo', updatedAt: 9 }).length === 0 && r.s.fields().title === 'T', '내 사본보다 오래된 목록(늦게 온 pull)은 버린다');
  r.s.set({ body: 'B 내가 고침' });
  const ch = r.s.mergeRemote({ title: 'T remote', body: 'B remote', status: 'done', updatedAt: 20 }, ['title']);
  ok(JSON.stringify(ch) === '["status"]' && r.s.fields().title === 'T' && r.s.fields().body === 'B 내가 고침' && r.s.fields().status === 'done', '커서가 있는 칸·내가 고친 칸은 두고 나머지만 따라간다', JSON.stringify(ch));
  ok(JSON.stringify(r.s.mergeRemote(null, [])) === '["title"]' && r.s.fields().title === 'T remote', '칸에서 나오면 미뤄 둔 변경을 따라간다');
  await r.s.flush();
  ok(JSON.stringify(r.calls[0][2]) === '{"body":"B 내가 고침"}', '내가 고친 칸만 저장한다(따라간 칸을 되돌려 쓰지 않는다)', JSON.stringify(r.calls[0]));
  ok(r.s.mergeRemote({ title: 'T remote', body: 'B remote', status: 'done', updatedAt: 20 }).length === 0 && r.s.fields().body === 'B 내가 고침', '내 저장 뒤에 온 옛 사본이 방금 쓴 글을 되감지 않는다');
}
// 8) 표시 제목 · 선택지
{
  ok(A.displayTitle({ title: ' 가 ' }, 'U') === '가' && A.displayTitle({ title: '', body: '\n## **로그인** 고치기\n둘째' }, 'U') === '로그인 고치기', '제목 → 본문 첫 줄(기호는 뗀다)');
  ok(A.displayTitle({ title: '', body: '![a](att:1)\n- [ ] 할 일 [링크](http://x)' }, 'U') === '할 일 링크' && A.displayTitle({ body: ' \n' }, '제목 없음') === '제목 없음', '그림 줄은 건너뛰고, 아무것도 없으면 "제목 없음"');
  const W = [{ cwd: 'other/project/codingpt', name: 'codingpt' }, { cwd: 'other/project/heyvoca', name: 'heyvoca' }, { cwd: '.codingpt/vm/linux/ws/codingpt', name: 'codingpt' },
    { cwd: '.codingpt/vm/macos/ws/codingpt', name: 'codingpt' }, { cwd: '.codingpt/worktrees/codingpt/a-1', name: 'codingpt' }, { cwd: 'other/project/codingpt', name: 'codingpt' }];
  ok(JSON.stringify(A.workspaceOptions(W).map((x) => x.label)) === '["codingpt","heyvoca"]', 'VM 자리·작업 폴더·같은 폴더는 빼고 프로젝트마다 한 줄', JSON.stringify(A.workspaceOptions(W)));
  ok(JSON.stringify(A.workspaceOptions([...W, { cwd: 'work/codingpt', name: 'codingpt' }]).map((x) => x.label)) === '["codingpt — other/project","heyvoca","codingpt — work"]', '다른 폴더인데 이름이 같으면 윗폴더로 가른다');
  const k = A.workspaceOptions(W, '.codingpt/vm/macos/ws/codingpt');
  ok(k.length === 3 && k[2].label === 'codingpt · macOS (VM)' && A.workspaceOptions(W, 'gone/x')[2].label === 'x', '이슈에 이미 적힌 폴더는 목록에 없어도 남긴다');
  ok(A.vmOsOfCwd('/Users/a/.codingpt/vm/linux/ws/x') === 'linux' && !A.isSeatOrWorktree('other/vm/x'), 'VM 자리 판정');
}
}
if (fail) { console.error(`issues-autosave: ${fail}/${n} 실패`); process.exit(1); }
console.log(`issues-autosave: ${n}개 통과`);
