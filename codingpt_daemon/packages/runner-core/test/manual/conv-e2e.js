#!/usr/bin/env node
/**
 * conv-e2e.js — 채팅 v2 엔진을 **실제 에이전트 CLI** 로 끝에서 끝까지 돌려 보는 수동 스크립트.
 *
 * 자동 테스트 스위트에는 넣지 않는다(파일명이 *.test.js 가 아니다): 사용자 구독 한도를 쓰고, 모델 응답에 따라
 * 흔들릴 수 있다. 데몬은 띄우지 않는다 — conv.js 를 직접 require 하고 push 는 가짜 ws 로 받는다.
 *
 *   node test/manual/conv-e2e.js [--bin /path/to/claude] [--keep]
 *
 * 순서: create → 델타 수신 → 파일 쓰기 승인 → 질문 응답 → 중단 → stop → (데몬 재시작 흉내) open 복원
 *       → send(재기동·이어받기).
 * 작업 폴더·상태 폴더는 임시 폴더에 만든다. 에이전트의 세션 파일은 평소처럼 사용자 홈(~/.claude/projects)에 남는다.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 이 스크립트를 에이전트 세션 안에서 돌릴 수도 있다 — 물려받은 세션 표식을 자식에 넘기지 않게 먼저 지운다.
for (const k of Object.keys(process.env)) if (/^CLAUDE(CODE$|_CODE_|_PID$|_EFFORT$)/.test(k) || /^CPT_/.test(k)) delete process.env[k];
delete process.env.TMUX;

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const BIN = argOf('--bin') || process.env.CODINGPT_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const KEEP = argv.includes('--keep');
process.env.CODINGPT_CLAUDE_BIN = BIN;
process.env.CPT_CONV_DEBUG = '1';
process.env.CODINGPT_TMUX_SOCKET = `convtest-${process.pid}`; // 혹시 tmux 경로를 타더라도 사용자 서버와 격리

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-conv-e2e-')));
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(WS, { recursive: true });

const runtime = require('../../runtime');
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') }); // claudeHome 은 기본(사용자 홈) — CLI 가 거기에 쓴다
const conv = require('../../conv');
const store = require('../../conv-store');

const frames = [];
const notes = [];
const ws = { readyState: 1, send(s) { frames.push({ at: Date.now(), f: JSON.parse(s) }); } };
function wire() {
  conv.configure({
    serverCaps: () => [],
    notify: async (p) => { notes.push(p); },
    deviceId: () => null,
    config: () => ({}),
    terminalOf: () => null,
    installExitHooks: false,
    log: (m) => console.log('   ' + m),
  });
}
wire();

const rpc = (m, p) => conv.handle(m, p || {}, ws);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function step(name, ok, info) {
  results.push({ name, ok: !!ok, info: info || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`);
}
const evs = (id, from = 0) => frames.slice(from).filter((x) => x.f.threadId === id && x.f.events).flatMap((x) => x.f.events);
const deltas = (id, from = 0) => frames.slice(from).filter((x) => x.f.threadId === id && x.f.delta);
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('시간 초과: ' + what);
    await sleep(50);
  }
}
const turnEnd = (id, from) => until(() => evs(id, from).find((e) => e.op === 'turn' && e.phase === 'end'), 120000, '턴 종료');
const pendingReq = (id, from) => evs(id, from).filter((e) => e.op === 'req').reduce((m, e) => m.set(e.req.id, e.req), new Map());
const firstPending = (id, from) => [...pendingReq(id, from).values()].find((r) => r.status === 'pending');
let n = 0;
const cid = () => `e2e-${process.pid}-${++n}`;
const textOf = (id, from) => evs(id, from).filter((e) => e.op === 'msg' && e.msg.role === 'assistant' && e.msg.kind === 'text' && !e.msg.hidden).map((e) => e.msg.text).join('\n');

async function main() {
  console.log(`실행 파일: ${BIN}`);
  console.log(`작업 폴더: ${WS}\n`);
  const caps = await rpc('conv.caps');
  step('conv.caps', caps.enabled && caps.agents[0] && caps.agents[0].available, JSON.stringify(caps.agents));

  // 1) create + 델타 + 파일 쓰기 승인 ─────────────────────────────────────────
  let mark = frames.length;
  const t0 = Date.now();
  const clientId = cid();
  const created = await rpc('conv.create', { cwd: 'ws', clientId, text: 'a.txt 파일에 hello 라고 써줘. 설명 없이.' });
  const id = created.thread.id;
  step('conv.create', !!id && Number.isInteger(created.seq), `thread=${id} 회신까지 ${Date.now() - t0}ms state=${created.thread.state}`);
  const req1 = await until(() => firstPending(id, mark), 90000, '파일 쓰기 승인 요청');
  step('승인 요청 수신', req1.kind === 'permission' && req1.tool === 'Write',
    `tool=${req1.tool} relPath=${req1.relPath} alwaysLabel=${req1.alwaysLabel || '-'} 요청까지 ${Date.now() - t0}ms`);
  const open1 = await rpc('conv.open', { threadId: id });
  step('대기 중 open', open1.thread.state === 'waiting' && open1.pending.length === 1, `state=${open1.thread.state} pending=${open1.pending.length}`);
  await rpc('conv.respond', { threadId: id, reqId: req1.id, decision: 'allow', by: 'e2e' });
  const end1 = await turnEnd(id, mark);
  const d1 = deltas(id, mark);
  const firstDelta = d1[0];
  const firstText = d1.find((x) => x.f.delta.kind === 'text' && x.f.delta.text);
  step('델타 수신', d1.length > 0,
    `조각 ${d1.length}개, 첫 조각까지 ${firstDelta ? firstDelta.at - t0 : '-'}ms(${firstDelta ? firstDelta.f.delta.kind : '-'}), 첫 글자까지 ${firstText ? firstText.at - t0 : '-'}ms`);
  // 델타 off 연속 + 완성 메시지 key 일치
  {
    const acc = new Map(); let okOff = true;
    for (const x of d1) { const d = x.f.delta; const cur = acc.get(d.key) || ''; if (d.off !== cur.length) okOff = false; acc.set(d.key, cur + d.text); }
    const msgs = evs(id, mark).filter((e) => e.op === 'msg').map((e) => e.msg);
    const matched = [...acc.keys()].every((k) => msgs.some((m) => m.key === k));
    const same = [...acc.entries()].every(([k, v]) => { const m = msgs.find((z) => z.key === k); return !m || m.kind !== 'text' || m.text === v; });
    step('델타 off 연속·key 일치·본문 일치', okOff && matched && same, `key ${acc.size}개`);
  }
  const file = path.join(WS, 'a.txt');
  step('파일 쓰기 승인 → 실행', end1.ok && fs.existsSync(file), `turn ok=${end1.ok} a.txt=${fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : '없음'} 비용=$${end1.costUsd}`);
  const mine = evs(id, mark).filter((e) => e.op === 'msg' && e.msg.key === 'u:' + clientId).map((e) => e.msg.status);
  step('도달 확인(queued → sent)', mine.join('>') === 'queued>sent', mine.join('>'));
  const seqs = evs(id, mark).map((e) => e.seq);
  step('seq 연속', seqs.every((s, i) => !i || s === seqs[i - 1] + 1) && seqs[0] === 1, `1..${seqs[seqs.length - 1]}`);
  const again = await rpc('conv.send', { threadId: id, clientId, text: 'a.txt 파일에 hello 라고 써줘. 설명 없이.' });
  step('conv.send 멱등(같은 clientId)', again.seq === created.seq && again.status === 'sent', JSON.stringify(again));

  // 2) 질문 응답 ─────────────────────────────────────────────────────────────
  mark = frames.length;
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'AskUserQuestion 도구로 좋아하는 색(빨강/파랑)을 물어보고, 내 답을 한 문장으로 말해줘.' });
  const q = await until(() => firstPending(id, mark), 90000, '질문');
  step('질문 수신', q.kind === 'question' && Array.isArray(q.questions) && q.questions.length > 0,
    `질문="${q.questions && q.questions[0] && q.questions[0].question}" 선택지=${q.questions && q.questions[0] ? q.questions[0].options.map((o) => o.label).join('/') : ''}`);
  const pick = (q.questions[0].options.find((o) => /파랑/.test(o.label)) || q.questions[0].options[0]).label;
  await rpc('conv.respond', { threadId: id, reqId: q.id, decision: 'answer', answers: [{ questionIndex: 0, labels: [pick] }] });
  const end2 = await turnEnd(id, mark);
  const said = textOf(id, mark);
  step('질문 응답 → 에이전트가 답을 읽음', end2.ok && said.includes(pick), `고른 답=${pick} 에이전트="${said.replace(/\s+/g, ' ').slice(0, 80)}"`);

  // 3) 중단 ─────────────────────────────────────────────────────────────────
  mark = frames.length;
  const pidBefore = conv._internals.live.get(id).engine.pid;
  await rpc('conv.send', { threadId: id, clientId: cid(), text: 'bash 로 sleep 30 을 실행해줘. 백그라운드로 돌리지 말고 끝날 때까지 기다려.' });
  // 승인 요청이 오면 허용하고, 도구가 돌기 시작한 뒤에 중단한다.
  await until(async () => {
    const r = firstPending(id, mark);
    if (r) { await rpc('conv.respond', { threadId: id, reqId: r.id, decision: 'allow' }); return false; }
    return evs(id, mark).some((e) => e.op === 'msg' && e.msg.kind === 'tool_use');
  }, 90000, '도구 실행');
  await sleep(2500);
  const lateReq = firstPending(id, mark);
  if (lateReq) { await rpc('conv.respond', { threadId: id, reqId: lateReq.id, decision: 'allow' }); await sleep(1500); }
  const ti = Date.now();
  const intr = await rpc('conv.interrupt', { threadId: id });
  const end3 = await turnEnd(id, mark);
  step('중단', intr.interrupted && end3.interrupted === true, `interrupt=${JSON.stringify(intr)} turn end interrupted=${end3.interrupted} ok=${end3.ok} 중단→종료 ${Date.now() - ti}ms`);
  const alive = conv._internals.live.get(id);
  step('중단 뒤 프로세스 생존', !!alive && alive.engine.pid === pidBefore && alive.engine.alive(), `pid=${pidBefore} state=${store.getThread(id).state}`);

  // 4) stop ─────────────────────────────────────────────────────────────────
  await rpc('conv.stop', { threadId: id });
  let dead = false;
  try { process.kill(pidBefore, 0); } catch (_) { dead = true; }
  step('conv.stop', dead && store.getThread(id).state === 'stopped' && !conv._internals.live.has(id), `프로세스 종료=${dead} state=${store.getThread(id).state}`);

  // 5) 데몬 재시작 흉내 → open 복원 ───────────────────────────────────────────
  const headBefore = store.headSeq(id);
  const pushedTotal = evs(id).length;
  await conv._internals._reset();
  wire();
  const snap = await rpc('conv.open', { threadId: id });
  const uu = store.since(id, 0).events.map((e) => e.uuid).filter(Boolean);
  step('재시작 뒤 open(디스크 복원)', snap.thread.state === 'stopped' && snap.headSeq >= headBefore && snap.events.length > 0,
    `headSeq=${snap.headSeq}(이전 ${headBefore}) 접힌 이벤트 ${snap.events.length}개 제목="${snap.thread.title}" 가져오기로 늘어난 이벤트=${snap.headSeq - headBefore}`);
  const grown = store.since(id, headBefore).events.filter((e) => e.op === 'msg');
  step('가져오기 중복 없음(uuid)', grown.length === 0 && new Set(uu).size === uu.length,
    `세션 파일의 줄이 전부 아는 uuid 여야 한다. 새로 들어온 메시지=${grown.length}${grown.length ? ' ' + JSON.stringify(grown.map((e) => [e.msg.role, e.msg.kind, String(e.msg.text).slice(0, 40)])) : ''}`);

  // 6) send — 재기동·이어받기 ─────────────────────────────────────────────────
  mark = frames.length;
  const t6 = Date.now();
  await rpc('conv.send', { threadId: id, clientId: cid(), text: '아까 a.txt 에 뭐라고 썼지? 그 단어만 답해.' });
  const end6 = await turnEnd(id, mark);
  const said6 = textOf(id, mark);
  const d6 = deltas(id, mark).find((x) => x.f.delta.kind === 'text' && x.f.delta.text);
  step('재기동·이어받기(--resume)', end6.ok && /hello/i.test(said6),
    `에이전트="${said6.replace(/\s+/g, ' ').slice(0, 60)}" 첫 글자까지 ${d6 ? d6.at - t6 : '-'}ms 캐시읽기=${end6.usage && end6.usage.cacheRead} 캐시쓰기=${end6.usage && end6.usage.cacheCreate}`);

  await conv.shutdown({ graceMs: 3000 });
  const total = frames.filter((x) => x.f.events).reduce((s, x) => s + x.f.events.length, 0);
  console.log(`\n받은 프레임 ${frames.length}개 — 영속 이벤트 ${total}개(재시작 전 ${pushedTotal}개), 델타 ${frames.filter((x) => x.f.delta).length}개, thread 힌트 ${frames.filter((x) => x.f.thread).length}개`);
  console.log(`알림 ${notes.length}건: ${notes.map((x) => x.kind).join(', ')}`);
  console.log(`최종 headSeq=${store.headSeq(id)} 총비용(마지막 턴 보고)=$${end6.costUsd}`);
}

const watchdog = setTimeout(() => { console.log('FAIL  전체 시간 초과(6분)'); conv.shutdownSync(); process.exit(2); }, 6 * 60 * 1000);
watchdog.unref();

main().catch((e) => { step('예외', false, `${e.code || ''} ${e.message}`); })
  .finally(async () => {
    try { await conv.shutdown({ graceMs: 1000 }); } catch (_) { /* noop */ }
    const fail = results.filter((r) => !r.ok).length;
    console.log(`\n결과: ${results.length - fail}/${results.length} 통과`);
    if (!KEEP) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ } } else console.log(`남긴 폴더: ${ROOT}`);
    process.exit(fail ? 1 : 0);
  });
