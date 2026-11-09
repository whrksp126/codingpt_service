'use strict';
// tmux 서버 실행 방식 — **앱(데몬) 아래에서 포크한다**(Orca 방식). launchd 실행(0.1.415~0.1.421)은 폐기.
//
// 경위: 0.1.415 에서 ⌘Q 뒤 Dock 의 "백그라운드에서 실행 중" 을 없애려고 tmux 서버를 launchd 작업으로 띄웠다.
//  그러자 tmux 아래 claude/codex 가 CodingPT 의 TCC 허가(다운로드·데스크탑 등)를 못 물려받아
//  "Operation not permitted" — 드롭한 스크린샷을 못 읽고 [Image #N] 변환이 깨졌다(2026-11-10 실측).
//  Orca(1.4.171 실측: ⌘Q 뒤 데몬이 앱 코얼리션에 남아 exited-with-subordinates)·Antigravity 도 Dock 표시를
//  감수하고 작업을 살려 둔다 → 사용자 결정(2026-11-10): Orca 를 따른다. Dock 표시는 "아직 일하는 중" 신호로 둔다.
//
// 이 파일에 남은 일 = **옛 launchd 서버에서 앱 아래 서버로 옮겨 오기**(migrateFromLaunchd, 데몬 기동 시 1회).
//  프로세스는 서버 사이를 못 옮긴다. 그래서 대화를 옮긴다:
//   1) 터미널마다 돌던 claude 의 세션 ID(~/.claude/sessions/<pid>.json — claude 가 tmux 위치와 함께 직접 쓴다)·
//      codex 세션 ID(훅 바인딩 chat-bind.json)·실행 옵션을 적어 둔다(마이그레이션 파일 — 중간에 죽어도 이어 간다).
//   2) 에이전트가 일하는 중이면 기다린다(최대 WAIT_MS). 그래도 바쁘면 이번엔 안 옮기고 다음 기동으로 미룬다.
//   3) launchd 작업을 내린다(서버·셸 종료) → 매니페스트 복원이 같은 tid 로 앱 아래 서버에 되살린다.
//   4) 각 터미널에 `claude --resume <id>` / `codex resume <id>` 를 넣어 대화를 그대로 잇는다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const LABEL_PREFIX = 'com.ghmate.codingpt.tmux.';
const WAIT_MS = 120000;
const PLAN_FILE = () => path.join(os.homedir(), '.codingpt', 'tmux-migrate.json');

function sh(cmd, args, env, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

/** 예전 호출부 호환 — 이제 서버는 첫 new-session 이 데몬(앱) 아래에서 포크한다. */
function ensureServer() { return Promise.resolve(false); }

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// claude 실행 옵션 중 이어 붙일 때도 유지할 것(값 있는 것 / 플래그). 위치 인자(첫 프롬프트)는 버린다 — 다시 보내면 안 된다.
const CLAUDE_VAL = new Set(['--model', '--permission-mode', '--add-dir', '--agent', '--effort', '--fallback-model', '--mcp-config', '--append-system-prompt']);
const CLAUDE_FLAG = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--ide', '--strict-mcp-config']);
function claudeResumeCmd(argv, sessionId) {
  const keep = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (CLAUDE_FLAG.has(a)) keep.push(a);
    else if (CLAUDE_VAL.has(key)) {
      if (eq > 0) keep.push(a);
      else if (i + 1 < argv.length) { keep.push(a, argv[i + 1]); i++; }
    }
  }
  return ['claude', ...keep.map(shq), '--resume', shq(sessionId)].join(' ');
}

// ps 의 args 는 공백으로 이어져 있어 정확한 argv 를 못 준다 → 실행 파일 뒤 옵션은 공백 분할로 충분(유지 대상은 공백 없는 값).
function argvOf(pid) {
  return sh('/bin/ps', ['-o', 'args=', '-p', String(pid)]).then((r) => (r.ok ? r.out.trim().split(/\s+/) : []));
}

/** 서버의 터미널별 에이전트 → 이어 붙일 명령. */
async function collectPlan(runTmux) {
  const plan = [];
  const panes = new Map();   // session → pane_pid
  try {
    const out = await runTmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}']);
    for (const l of String(out).split('\n')) { const [s, p] = l.split('\t'); if (s && p && !panes.has(s)) panes.set(s, Number(p)); }
  } catch (_) { return plan; }
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const done = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch (_) { /* claude 없음 */ }
  for (const f of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    const pid = Number(d && d.pid);
    const session = String((d && d.tmux) || '').split(':')[0];
    if (!pid || !d.sessionId || !panes.has(session) || done.has(session) || !isAlive(pid)) continue;
    done.add(session);
    plan.push({ session, agent: 'claude', pid, sessionId: d.sessionId, busy: d.status === 'busy', cmd: claudeResumeCmd(await argvOf(pid), d.sessionId) });
  }
  // codex — 세션 파일이 없어 훅 바인딩(cwdRel|tid → sessionId)과 실제 프로세스(pane 자손에 codex)를 맞춘다.
  let binds = {};
  try { binds = (JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codingpt', 'chat-bind.json'), 'utf8')).binds) || {}; } catch (_) { /* 없음 */ }
  const ps = await sh('/bin/ps', ['-axo', 'pid=,ppid=,args=']);
  const kids = new Map(); const args = new Map();
  for (const l of ps.out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); if (!m) continue;
    const pid = Number(m[1]); args.set(pid, m[3]);
    if (!kids.has(Number(m[2]))) kids.set(Number(m[2]), []);
    kids.get(Number(m[2])).push(pid);
  }
  const hasCodex = (root) => {
    const st = [root];
    while (st.length) { const p = st.pop(); if (p !== root && /(^|\/)codex(\s|$)/.test(args.get(p) || '')) return true; st.push(...(kids.get(p) || [])); }
    return false;
  };
  for (const [session, ppid] of panes) {
    if (done.has(session)) continue;
    const tid = (/--t-(\d+)$/.exec(session) || [])[1];
    if (!tid || !hasCodex(ppid)) continue;
    const b = Object.entries(binds).find(([k, v]) => k.endsWith('|' + tid) && v && v.agent === 'codex' && v.sessionId);
    if (b) plan.push({ session, agent: 'codex', sessionId: b[1].sessionId, busy: false, cmd: 'codex resume ' + shq(b[1].sessionId) });
  }
  return plan;
}

function savePlan(plan) { try { fs.writeFileSync(PLAN_FILE(), JSON.stringify({ v: 1, at: Date.now(), plan }, null, 2), { mode: 0o600 }); } catch (_) { /* noop */ } }
function loadPlan() { try { return JSON.parse(fs.readFileSync(PLAN_FILE(), 'utf8')).plan || []; } catch (_) { return null; } }

/** 되살린 터미널에 이어 붙이기 명령을 넣는다(셸 시작 전에 친 글자는 tty 가 들고 있다가 프롬프트에 들어간다). */
async function resumeAgents(runTmux, plan) {
  let n = 0;
  for (const p of plan) {
    // 셸이 프롬프트를 그릴 때까지(최대 6초) — rc 가 화면을 지우거나 입력을 비우는 셸에서도 안전하게.
    for (let i = 0; i < 30; i++) {
      try {
        const scr = String(await runTmux(['capture-pane', '-p', '-t', `=${p.session}:0`]));
        if (scr.trim()) break;
      } catch (_) { break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      await runTmux(['send-keys', '-t', `=${p.session}:0`, '-l', p.cmd]);
      await runTmux(['send-keys', '-t', `=${p.session}:0`, 'Enter']);
      n++;
    } catch (_) { /* 그 터미널은 복원 실패 — 빈 셸 */ }
  }
  try { fs.unlinkSync(PLAN_FILE()); } catch (_) { /* noop */ }
  return n;
}

/**
 * 데몬 기동 시 1회(매니페스트 복원 **전**). 옛 launchd 서버가 있으면 대화를 적어 두고 내린다.
 *  반환: null(할 일 없음) | { plan } — 호출자가 복원(restoreIfNeeded) 뒤 finishMigration(plan) 을 부른다.
 * @param {{runTmux:Function, syncManifest:Function, env?:object, log?:Function}} o
 */
async function migrateFromLaunchd(o) {
  if (process.platform !== 'darwin' || process.env.CODINGPT_TMUX_SOCKET) return null;
  const log = o.log || (() => {});
  const socket = o.socket || 'codingpt';
  const label = LABEL_PREFIX + socket.replace(/[^A-Za-z0-9_.-]/g, '_');
  const target = `gui/${process.getuid()}/${label}`;
  const plistFile = path.join(os.homedir(), '.codingpt', 'launchd', label + '.plist');
  // 지난번 이전이 내리기까지 하고 이어 붙이기 전에 끊겼다 → 남은 계획만 실행한다.
  const pending = loadPlan();
  const loaded = (await sh('/bin/launchctl', ['print', target])).ok;
  if (!loaded) {
    try { fs.unlinkSync(plistFile); } catch (_) { /* noop */ }
    return pending && pending.length ? { plan: pending } : null;
  }
  let plan = await collectPlan(o.runTmux);
  const t0 = Date.now();
  while (plan.some((p) => p.busy) && Date.now() - t0 < WAIT_MS) {
    log(`[tmux-migrate] 일하는 에이전트 ${plan.filter((p) => p.busy).length}개 — 끝나길 기다림`);
    await new Promise((r) => setTimeout(r, 5000));
    plan = await collectPlan(o.runTmux);
  }
  if (plan.some((p) => p.busy)) { log('[tmux-migrate] 에이전트가 계속 일하는 중 — 이번 기동은 건너뜀(다음 기동에 옮김)'); return null; }
  try { await o.syncManifest(); } catch (_) { /* 기존 기록 사용 */ }
  savePlan(plan);
  const r = await sh('/bin/launchctl', ['bootout', target], o.env, 15000);
  if (!r.ok) { log('[tmux-migrate] launchd 작업 내리기 실패: ' + r.err.trim()); try { fs.unlinkSync(PLAN_FILE()); } catch (_) {} return null; }
  try { fs.unlinkSync(plistFile); } catch (_) { /* noop */ }
  // 서버가 완전히 사라질 때까지(최대 5초) — 복원은 "서버 없음" 을 보고 움직인다.
  for (let i = 0; i < 50; i++) {
    try { await o.runTmux(['list-sessions']); } catch (_) { break; }
    await new Promise((res) => setTimeout(res, 100));
  }
  log(`[tmux-migrate] launchd tmux 내림 — 이어 붙일 대화 ${plan.length}개`);
  return { plan };
}

async function finishMigration(runTmux, plan) {
  if (!plan || !plan.length) { try { fs.unlinkSync(PLAN_FILE()); } catch (_) {} return 0; }
  await new Promise((r) => setTimeout(r, 800));   // 셸 기동 여유(앞서 친 글자도 tty 가 들고 있지만 rc 의 clear 를 피한다)
  return resumeAgents(runTmux, plan);
}

module.exports = { ensureServer, migrateFromLaunchd, finishMigration, collectPlan, claudeResumeCmd, LABEL_PREFIX, PLAN_FILE };
