/**
 * term-backend 의 darwin/linux 구현 — tmux 서브커맨드 조립(웨이브2, 설계 계약 1).
 *
 * 웨이브2 재배선으로 pty.js/cpt-server.js/status-line.js/agent-watch.js/question-revive.js 가
 * 흩어 갖고 있던 tmux 서브커맨드 조립이 여기로 모였다. **동작 완전 불변**이 규율이다:
 * 각 op 는 종전 호출부가 만들던 것과 같은 인자를 조립하고, 실행은 전부 pty.js 의
 * runTmux(단일 저수준 실행기 — TMUX 해제·UTF-8 강제·-L 전용 소켓)를 경유한다.
 *
 * ⚠ pty 참조는 반드시 **호출 시점 지연 참조**(pty() 함수) — 테스트들이 ptyLib.runTmux 를
 *   몽키패치/require 캐시 스텁하는 관례가 정본이라, 구조분해로 굳히면 스텁이 무력화돼
 *   격리가 깨진다(실 tmux -L codingpt 를 건드리는 사고).
 *
 * 타겟 규칙(이 파일 전체): 세션은 '=' 정확 일치(접두사 매칭 금지), pane 조작은 window 0
 * (`=<name>:0`) — 전용 세션 모델(터미널 1개 = 세션 1개 = window 0 하나)의 기존 관례 그대로.
 */
'use strict';
const nodePty = require('node-pty');

// 지연 참조 — 순환 require(pty → term-backend → 여기)와 테스트 몽키패치 둘 다 이걸로 성립한다.
const pty = () => require('./pty');
const t0 = (name) => `=${String(name)}:0`;

// listTerminals(pty.js)가 쓰던 5필드 포맷 그대로 — 제목은 마지막 필드(탭이 섞여도 뒤를 되붙인다).
const LIST_FMT = '#{session_name}\t#{session_created}\t#{window_name}\t#{pane_current_command}\t#{pane_title}';
// info: display-message 소비자(에이전트 실행 준비 판정·컴포저 커서·자동 개명 이름) 전수 커버.
//  window_name/pane_title 은 탭을 품을 수 있어 맨 뒤에 둔다(title = 나머지 전부).
const INFO_FMT = '#{pane_current_command}\t#{window_width}\t#{window_height}\t#{cursor_x}\t#{cursor_y}\t#{pane_pid}\t#{window_name}\t#{pane_title}';

/** new-session -d 등가 — env 는 -e KEY=VAL 로 초기 셸에 직접 주입(웨이브1 주의점 3: setEnv 는
 *  이미 뜬 셸에 안 먹는다). cols/rows 는 tmux 에선 window-size latest 가 담당하므로 무시. */
async function create({ name, cwd, env } = {}) {
  const p = pty();
  const envArgs = [];
  for (const [k, v] of Object.entries(env || {})) envArgs.push('-e', `${k}=${v}`);
  await p.runTmux([...(p.CONF_ARGS || []), 'new-session', '-d', '-s', String(name), '-c', cwd, ...envArgs]);
  return { name: String(name) };
}

/** 세션 목록(세션당 첫 window) — term-host meta 와 같은 키({name,createdAt,windowName,command,title}).
 *  createdAt 은 ms(win32 host 와 단위 통일 — tmux session_created 는 초라 ×1000). */
async function list() {
  const out = await pty().runTmux(['list-windows', '-a', '-F', LIST_FMT]);
  const rows = [];
  const seen = new Set();
  for (const l of String(out).split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const parts = l.split('\t');
    const [name, created, windowName, command] = parts;
    if (!name || seen.has(name)) continue; // 세션당 첫 window 만(listTerminals 기존 규칙)
    seen.add(name);
    rows.push({
      name,
      createdAt: (parseInt(created, 10) || 0) * 1000,
      windowName: windowName || '',
      command: (command || '').trim(),
      title: parts.slice(4).join('\t'),
    });
  }
  return rows;
}

/** 모든 세션 이름(뷰/풀/레거시 포함) — liveWorkspaceNs(cpt-server 게이트)가 쓰던 list-sessions 그대로.
 *  list() 와 분리한 이유: list-windows 는 세션당 window 를 돌지만 여기는 이름만 필요하고,
 *  기존 테스트 스텁이 'list-sessions' 서브커맨드를 계약으로 고정하고 있다. */
async function listSessionNames() {
  const out = await pty().runTmux(['list-sessions', '-F', '#{session_name}']);
  return String(out).split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean);
}

/** has-session 등가 — 존재 여부 boolean(에러를 던지지 않는다). */
async function has(name) {
  try { await pty().runTmux(['has-session', '-t', '=' + String(name)]); return true; }
  catch (_) { return false; }
}

/** kill-session 등가(멱등) — 서버 없음/세션 없음은 성공 취급(terminal.close 의 기존 규칙). */
async function kill(name) {
  try { await pty().runTmux(['kill-session', '-t', '=' + String(name)]); }
  catch (e) {
    const msg = String((e && e.message) || '');
    if (!/no server running|can't find session|session not found/i.test(msg)) throw e;
  }
  return {};
}

/** kill-server 등가 — 전용 소켓(-L codingpt)의 tmux 서버 전멸. 프로덕션 darwin 호출부는 없다. */
async function killServer() {
  try { await pty().runTmux(['kill-server']); } catch (_) { /* 서버 없음 = 이미 목표 상태 */ }
  return {};
}

/** send-keys 등가 — data(원시 바이트)=-l --, keys 배열, literal=-l, count=-N. 기존 호출부 조립 그대로. */
function sendKeys(name, { data, keys, literal, count } = {}) {
  const args = ['send-keys', '-t', t0(name)];
  if (count != null) args.push('-N', String(count));
  if (data != null) {
    const s = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return pty().runTmux([...args, '-l', '--', s]);
  }
  const list_ = (Array.isArray(keys) ? keys : [keys]).map(String);
  if (literal) args.push('-l', '--');
  return pty().runTmux([...args, ...list_]);
}

/** capture-pane 등가 — escapes=-e, join=-J, lines=-S -N. 반환은 stdout 원문(바이트 불변). */
async function capture(name, { escapes, lines, join } = {}) {
  const args = ['capture-pane', '-p'];
  if (escapes) args.push('-e');
  if (join) args.push('-J');
  args.push('-t', t0(name));
  const n = Math.max(0, lines | 0);
  if (n) args.push('-S', `-${n}`);
  return pty().runTmux(args);
}

/** darwin 은 no-op — 크기는 attach 클라이언트 + window-size latest 가 결정한다(수동 resize-window
 *  클레임은 기기 간 크기 뺏기 전쟁의 근원이라 전면 폐지된 상태 — 되살리지 말 것). */
async function resize() {
  return {};
}

/** set-environment 등가(값 null = -u 해제). 이미 뜬 셸엔 안 먹는다 — 초기 env 는 create 로. */
function setEnv(name, k, v) {
  if (v == null) return pty().runTmux(['set-environment', '-u', '-t', '=' + String(name), String(k)]);
  return pty().runTmux(['set-environment', '-t', '=' + String(name), String(k), String(v)]);
}

/** show-environment <k> 등가 — 값 또는 null(미설정/-u 마커). 세션 부재는 그대로 throw(호출부 catch). */
async function getEnv(name, k) {
  const key = String(k);
  let out;
  try {
    out = await pty().runTmux(['show-environment', '-t', '=' + String(name), key]);
  } catch (e) {
    if (/unknown variable/i.test(String((e && e.message) || ''))) return null;
    throw e;
  }
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(key + '=')) return line.slice(key.length + 1);
    if (line === '-' + key) return null;
  }
  return null;
}

/** rename-window 등가 — 빈 값이면 automatic-rename 복귀(term-host 계약과 동일 의미론). */
function rename(name, title) {
  if (title == null || title === '') {
    return pty().runTmux(['set-window-option', '-t', t0(name), 'automatic-rename', 'on']);
  }
  return pty().runTmux(['rename-window', '-t', t0(name), String(title)]);
}

/** respawn-pane -k 등가 — 프로세스 강제 교체(cwd 덮어쓰기 가능). */
function respawn(name, { cwd } = {}) {
  return pty().runTmux(['respawn-pane', '-k', '-t', t0(name), ...(cwd ? ['-c', cwd] : [])]);
}

/** display-message 등가 묶음 — {command, cols, rows, cursor{x,y}, panePid, windowName, title}. */
async function info(name) {
  const out = await pty().runTmux(['display-message', '-p', '-t', t0(name), INFO_FMT]);
  const parts = String(out).replace(/\r?\n$/, '').split('\t');
  if (parts.length < 6) throw new Error('display-message 응답을 해석할 수 없습니다');
  return {
    name: String(name),
    command: (parts[0] || '').trim(),
    cols: parseInt(parts[1], 10) || 0,
    rows: parseInt(parts[2], 10) || 0,
    cursor: { x: parseInt(parts[3], 10) || 0, y: parseInt(parts[4], 10) || 0 },
    panePid: parseInt(parts[5], 10) || 0,
    windowName: parts[6] || '',
    title: parts.slice(7).join('\t'),
  };
}

/**
 * attach — tmux 클라이언트를 node-pty 로 스폰(종전 attachPty/swap 의 spawnArgs 그대로).
 *  · 기본: `attach-session -t =<name>` (+ setLatest 면 `; set -g window-size latest`)
 *  · sharedCreate: 레거시 공유 세션 경로 — `new-session -A -s <name> -c <cwd>` (+CONF_ARGS)
 * 반환 핸들은 term-backend 파이프 attach 와 동일 계약({write,sendKeys,resize,close}).
 * 스폰 실패는 그대로 throw — 호출부(pty.attachPty)가 쿨다운(마스터 fd 누수 방어)을 집행한다.
 */
async function attach(name, o = {}) {
  const p = pty();
  const tmux = p.findTmux();
  if (!tmux) throw new Error('tmux 가 설치되어 있지 않습니다 (brew install tmux)');
  const args = ['-L', p.TMUX_SOCKET, '-u'];
  if (o.sharedCreate) args.push(...(p.CONF_ARGS || []), 'new-session', '-A', '-s', String(name), '-c', o.cwd);
  else {
    args.push('attach-session');
    if (o.ignoreSize) args.push('-f', 'ignore-size');
    args.push('-t', '=' + String(name));
  }
  if (o.setLatest) args.push(';', 'set', '-g', 'window-size', 'latest');
  const child = nodePty.spawn(tmux, args, {
    name: 'xterm-256color',
    cols: o.cols || 80,
    rows: o.rows || 24,
    cwd: o.cwd,
    env: p.tmuxEnv(),
  });
  child.onData((d) => {
    if (typeof o.onData === 'function') { try { o.onData(d); } catch (_) { /* noop */ } }
  });
  child.onExit(({ exitCode }) => {
    if (typeof o.onExit === 'function') { try { o.onExit(exitCode | 0); } catch (_) { /* noop */ } }
    if (typeof o.onClose === 'function') { try { o.onClose(); } catch (_) { /* noop */ } }
  });
  return {
    write(data) { try { child.write(typeof data === 'string' ? data : data.toString('utf8')); } catch (_) { /* noop */ } },
    sendKeys(spec) { sendKeys(name, spec || {}).catch(() => { /* noop */ }); },
    resize(cols, rows) { try { child.resize(cols, rows); } catch (_) { /* noop */ } },
    close() { try { child.kill(); } catch (_) { /* noop */ } },
  };
}

module.exports = {
  create, list, listSessionNames, has, kill, killServer,
  sendKeys, capture, resize, setEnv, getEnv, rename, respawn, info, attach,
  LIST_FMT, INFO_FMT,
};
