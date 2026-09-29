'use strict';

// 터미널 매니페스트 — **재부팅(tmux 서버 소멸) 뒤 터미널을 되살리기 위한 기록**. docs/terminal-v3-design.md §6.
//
// 왜 필요한가(2026-09-16 사용자 신고 "PC 재시작하면 터미널이 안 보인다 — cmux 는 다 그대로인데"):
//  tmux 세션은 데몬·앱 재시작은 넘어 살지만 **OS 재부팅은 못 넘긴다.** 그러면 모든 기기의 레이아웃
//  (tid 를 참조하는 탭)이 실체 없는 탭이 되는데, 데몬은 "터미널 0개" 를 정식 상태로 보고 attach 에서
//  재생성을 거부한다(죽은 pane 의 자동 재접속이 닫은 터미널을 부활시키는 걸 막기 위한 규칙 — 그건
//  그대로 옳다). 결과: 사용자는 재부팅마다 빈 워크스페이스(또는 재접속 루프)를 받았다.
//  cmux 는 자기 상태 파일에서 레이아웃+터미널(cwd)을 되살린다 — 여기서도 같은 걸 **데몬**이 한다.
//  tid 를 그대로 되살리므로 PC·폰·태블릿의 저장된 레이아웃이 전부 수정 없이 다시 맞물린다
//  (레이아웃은 기기마다 tid 로 터미널을 가리키고, 실체는 여기 하나뿐이다).
//
// 진실의 우선순위: **tmux 서버가 살아 있으면 tmux 가 정본**이고 이 파일은 그 사본이다(sync 가 덮어쓴다).
//  서버가 없을 때만 해석이 갈린다 —
//   · 데몬 **기동 시** 서버 부재 + 매니페스트 있음 = 재부팅/크래시 → 되살린다(restoreIfNeeded).
//   · 데몬 **수명 중** 서버 부재 = 사용자가 마지막 터미널까지 닫음(exit 등) → 매니페스트를 비운다.
//  terminal.close 는 즉시 forget 한다(닫은 터미널이 재부팅 뒤 부활하지 않게). 이 둘로 "닫은 건
//  안 살아나고, 잃은 건 살아난다" 가 성립한다. 남는 구멍은 "마지막 셸에서 exit 친 직후 sync 틱 전에
//  재부팅" 뿐이며, 그때 터미널 하나가 빈 셸로 돌아오는 정도다.
//
// 되살리는 것 = 세션(tid·워크스페이스 env)·시작 폴더(마지막 pane_current_path)·수동 이름. 셸 안의
//  프로세스·스크롤백은 재부팅으로 이미 사라진 것이라 되살리지 않는다(cmux 도 마찬가지).
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const FILE = () => path.join(runtime.stateDir(), 'terminals.json');
const TERM_RE = /^(.+)--t-(\d+)$/;

// 데몬 수명 안에서 "서버가 살아 있는 걸 본 적이 있는가" — 기동 직후의 서버 부재(재부팅)와
//  수명 중 서버 부재(전부 닫힘)를 가르는 유일한 근거.
let seenAlive = false;

const pty = () => require('./pty');
const backend = () => require('./term-backend');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    const list = Array.isArray(j && j.terminals) ? j.terminals : [];
    return list.filter((t) => t && typeof t.session === 'string' && TERM_RE.test(t.session) && typeof t.cwd === 'string');
  } catch (_) { return []; }
}

function save(list) {
  try {
    fs.mkdirSync(runtime.stateDir(), { recursive: true });
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), terminals: list }, null, 2));
    fs.renameSync(tmp, FILE());
  } catch (_) { /* 디스크 문제 — 다음 sync 가 다시 쓴다 */ }
}

/** 생성 직후 기록(sync 를 기다리지 않는다 — 만들자마자 재부팅해도 살아나게). */
function record({ session, cwd, pathDir, name, manualName }) {
  if (!session || !cwd) return;
  const list = load().filter((t) => t.session !== session);
  list.push({ session, cwd, path: pathDir || cwd, name: name || '', manualName: !!manualName, at: Date.now() });
  save(list);
}

/** 명시적 닫힘 — 재부팅 뒤 부활 금지. */
function forget(session) {
  const list = load();
  const next = list.filter((t) => t.session !== session);
  if (next.length !== list.length) save(next);
}

/** tmux 서버 생존 여부 — true/false, 판정 불가(다른 오류)면 null. */
async function serverAlive() {
  try { await pty().runTmux(['list-sessions', '-F', '#{session_name}']); return true; } catch (e) {
    const m = String((e && e.message) || e);
    if (/no server running|error connecting|No such file/i.test(m)) return false;
    return null;
  }
}

/**
 * 살아 있는 tmux 를 정본으로 매니페스트를 다시 쓴다(주기 호출). 서버가 없으면 —
 *  기동 후 한 번이라도 살아 있었을 때만 — "전부 닫힘" 으로 보고 비운다.
 */
async function sync() {
  if (backend().isHostBackend()) return;
  const alive = await serverAlive();
  if (alive === null) return;
  if (alive === false) { if (seenAlive) save([]); return; }
  seenAlive = true;
  let out;
  try {
    out = await pty().runTmux(['list-windows', '-a', '-F', '#{session_name}\t#{window_name}\t#{pane_current_path}\t#{automatic-rename}']);
  } catch (_) { return; }
  const prev = new Map(load().map((t) => [t.session, t]));
  const list = [];
  const seen = new Set();
  for (const line of String(out).split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const [session, name, pathDir, autoRename] = line.split('\t');
    if (!session || seen.has(session) || !TERM_RE.test(session)) continue;   // 세션당 window 0 하나
    seen.add(session);
    // 워크스페이스 루트(env 주입의 기준) — 세션 env CPT_WS 에서 역산. 이전 기록이 있으면 재사용(호출 절약).
    let cwd = prev.get(session) && prev.get(session).cwd;
    if (!cwd) cwd = await workspaceRootOf(session);
    if (!cwd) continue;                                                      // 근거 없는 세션은 되살릴 수 없다
    list.push({ session, cwd, path: pathDir || cwd, name: name || '', manualName: autoRename === '0', at: Date.now() });
  }
  save(list);
}

async function workspaceRootOf(session) {
  try {
    const env = String(await pty().runTmux(['show-environment', '-t', '=' + session, 'CPT_WS'])).trim();
    const m = /^CPT_WS=(.*)$/.exec(env);
    if (!m) return null;
    const rel = m[1];
    if (!rel) return runtime.root();
    const abs = require('./fs').safeResolve(rel);
    return fs.existsSync(abs) ? abs : null;
  } catch (_) { return null; }
}

/**
 * 데몬 기동 시 1회 — 서버가 없고 매니페스트가 있으면 전부 되살린다. 반환: 되살린 개수.
 *  서버가 살아 있으면(데몬만 재시작) 아무것도 안 한다 — tmux 가 정본이고 sync 가 곧 따라 쓴다.
 */
async function restoreIfNeeded() {
  if (backend().isHostBackend()) return 0;
  const alive = await serverAlive();
  if (alive !== false) { if (alive) seenAlive = true; return 0; }
  const list = load();
  if (!list.length) return 0;
  const p = pty();
  let n = 0;
  for (const t of list) {
    const m = TERM_RE.exec(t.session);
    if (!m) continue;
    const tid = parseInt(m[2], 10);
    const cwd = fs.existsSync(t.cwd) ? t.cwd : null;
    if (!cwd) continue;                                                      // 워크스페이스 폴더가 사라졌다
    const start = t.path && fs.existsSync(t.path) ? t.path : cwd;
    try {
      await backend().create({ name: t.session, cwd: start, env: p.poolEnvMap(cwd, tid, t.session) });
    } catch (e) {
      if (/duplicate session/i.test(String((e && e.message) || ''))) { n++; continue; }   // 이미 있음(경쟁 생성)
      continue;
    }
    await p.injectPoolEnv(t.session, cwd).catch(() => {});
    await p.ensureAutoRename(t.session).catch(() => {});
    if (t.manualName && t.name) await p.runTmux(['rename-window', '-t', `=${t.session}:0`, t.name]).catch(() => {});
    n++;
  }
  seenAlive = n > 0;
  return n;
}

module.exports = { load, save, record, forget, sync, restoreIfNeeded, serverAlive, FILE };
