/**
 * term-backend — 터미널 세션 백엔드의 **유일 진입점**(Windows 포팅 설계 계약 1).
 *
 * 웨이브2에서 pty.js/cpt-server.js/status-line.js/agent-watch.js/question-revive.js 의 tmux
 * 호출부는 전부 이 모듈을 경유하게 재배선된다. 시그니처는 term-host op 목록과 1:1.
 *
 *  · win32: @codingpt/term-host 파이프 클라이언트. 호스트 미기동이면 detached 스폰 후 재시도
 *    (스폰 경쟁은 무해 — 파이프 점유가 단일 인스턴스 락이라 진 쪽은 스스로 종료한다).
 *  · darwin/linux: **아직 스텁** — 웨이브2에서 기존 runTmux(pty.js) 경로로 위임 예정.
 *    지금은 인터페이스만 정의하고 호출 시 명시적 에러를 던진다(조용한 오동작 금지).
 *    단, CPT_TERMHOST_SOCK 이 설정돼 있으면 비-win32 에서도 파이프 클라이언트로 동작한다
 *    — mac 에서 term-host 를 실제 pty 로 띄워 e2e 테스트하는 개발 경로(설계 계약 1 폴백).
 *
 * 프로토콜(NDJSON): 요청 `{id, op, ...}` → 응답 `{id, ok, ...}`. attach 는 응답 후 스트림 전환
 *  ({t:'o'|'i'|'r'|'k'|'x'} 프레임, d=base64). 상세는 term-host/lib/server.js 헤더가 정본.
 */
'use strict';
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const runtime = require('./runtime');

// ── 경로/엔트리 해석 ───────────────────────────────────────────────────────
// term-host 패키지 위치 — 워크스페이스 형제(소스)와 번들 레이아웃 둘 다 커버.
function hostEntry() {
  const candidates = [
    path.join(__dirname, '..', 'term-host', 'index.js'),
  ];
  try { candidates.push(require.resolve('@codingpt/term-host')); } catch (_) { /* 링크 안 됨 */ }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* noop */ }
  }
  return null;
}

// 파이프 경로 — term-host/lib/paths.pipePath 와 반드시 같은 규칙(어긋나면 유령 호스트를 띄운다).
//  비-win32 는 runtime.stateDir(러너별 주입 가능)를 기준으로 하고, 스폰 시 env 로 호스트에도 같은
//  값을 전달해 양쪽이 같은 경로를 보게 한다.
function pipePath() {
  if (process.env.CPT_TERMHOST_SOCK) return process.env.CPT_TERMHOST_SOCK;
  if (process.platform === 'win32') {
    const h = crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\cpt-termhost-${h}`;
  }
  const p = path.join(runtime.stateDir(), 'termhost.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  const h = crypto.createHash('sha1').update(runtime.stateDir()).digest('hex').slice(0, 8);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cpt-termhost-${uid}-${h}.sock`);
}

// 이 프로세스에서 파이프 백엔드가 활성인가 — win32 항상, 그 외엔 테스트/개발 env 로만.
function isHostBackend() {
  return process.platform === 'win32' || !!process.env.CPT_TERMHOST_SOCK;
}

function stubError() {
  const e = new Error('term-backend: 이 플랫폼 경로는 웨이브2에서 기존 runTmux 로 위임 예정(미구현) — win32 또는 CPT_TERMHOST_SOCK 필요');
  e.code = 'TERM_BACKEND_STUB';
  return e;
}

// ── 호스트 스폰(미기동 시) ─────────────────────────────────────────────────
function spawnHost() {
  const entry = hostEntry();
  if (!entry) throw new Error('term-host 엔트리를 찾을 수 없습니다(@codingpt/term-host 미설치)');
  const child = spawn(process.execPath, [entry, 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      CPT_TERMHOST_SOCK: pipePath(),
      CODINGPT_STATE_DIR: runtime.stateDir(),
    },
  });
  child.unref();
  return child.pid;
}

function connectOnce(sockPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const to = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(to); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// 접속 확보 — 실패 시 1회 스폰 후 백오프 재시도(~3초). 스폰 경쟁은 파이프 락이 중재.
let spawnedOnce = false;
async function ensureConn() {
  if (!isHostBackend()) throw stubError();
  const p = pipePath();
  try { return await connectOnce(p); } catch (_) { /* 미기동 — 스폰 경로 */ }
  if (!spawnedOnce) { spawnHost(); spawnedOnce = true; }
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { return await connectOnce(p); } catch (e) { lastErr = e; }
  }
  spawnedOnce = false; // 다음 호출이 재스폰을 시도할 수 있게
  throw new Error(`term-host 접속 실패: ${(lastErr && lastErr.message) || lastErr}`);
}

// NDJSON 단발 요청 — 접속→요청 1건→응답 1건→종료(cpt-server one-shot 관례와 동일).
let reqSeq = 0;
async function request(op, payload = {}) {
  const sock = await ensureConn();
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { sock.destroy(); reject(new Error(`term-host 응답 시간 초과(op=${op})`)); }, 10000);
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(to);
      sock.destroy();
      let msg;
      try { msg = JSON.parse(buf.slice(0, i)); } catch (e) { return reject(e); }
      if (!msg.ok) {
        const err = new Error(msg.error || 'term-host 오류');
        err.code = msg.code || 'ERROR';
        return reject(err);
      }
      resolve(msg);
    });
    sock.on('error', (e) => { clearTimeout(to); reject(e); });
    sock.write(JSON.stringify({ id, op, ...payload }) + '\n');
  });
}

// ── 단발 op 1:1 API(설계 계약 1) ───────────────────────────────────────────
const api = {
  isHostBackend,
  pipePath,
  hostEntry,

  /** 세션 생성 — tmux new-session -d -s <name> -c <cwd> -e … 등가 */
  create({ name, cwd, env, cols, rows, shell } = {}) {
    return request('create', { name, cwd, env, cols, rows, shell });
  },
  /** 세션 목록 — [{name,title,windowName,command,panePid,createdAt,cols,rows,cwd,modes}] */
  async list() {
    return (await request('list')).sessions;
  },
  /** has-session 등가 — boolean */
  async has(name) {
    return (await request('has', { name })).exists;
  },
  /** kill-session 등가(멱등) */
  kill(name) {
    return request('kill', { name });
  },
  /** kill-server 등가 — 세션 전멸 + 호스트 종료 */
  killServer() {
    return request('killServer').catch((e) => {
      // 호스트가 응답 직후 종료하며 소켓이 끊길 수 있다 — 접속 자체가 안 되면 이미 없음(성공 취급).
      if (e && /ECONNREFUSED|ENOENT|시간 초과/.test(String(e.message))) return { ok: true };
      throw e;
    });
  },
  /** send-keys 등가 — data(원시 바이트) 또는 keys(tmux 표기 배열). literal=-l, count=-N */
  sendKeys(name, { data, keys, literal, count } = {}) {
    return request('sendKeys', { name, data, keys, literal, count });
  },
  /** capture-pane 등가 — escapes=-e, lines=-S -N, join=-J. 반환: 화면 텍스트 */
  async capture(name, { escapes, lines, join } = {}) {
    return (await request('capture', { name, escapes, lines, join })).text;
  },
  /** 리사이즈 — latest wins(window-size latest 등가) */
  resize(name, cols, rows) {
    return request('resize', { name, cols, rows });
  },
  /** set-environment 등가(이후 respawn 프로세스에 반영) */
  setEnv(name, k, v) {
    return request('setEnv', { name, k, v });
  },
  /** show-environment <k> 등가 — 값 또는 null */
  async getEnv(name, k) {
    return (await request('getEnv', { name, k })).value;
  },
  /** rename-window 등가(수동 이름 = automatic-rename off. 빈 값 = 자동 복귀) */
  rename(name, title) {
    return request('rename', { name, title });
  },
  /** respawn-pane -k 등가. 죽은 세션(호스트 크래시 저널 고아)도 이 op 로만 복원한다 */
  respawn(name, { cwd, cols, rows } = {}) {
    return request('respawn', { name, cwd, cols, rows });
  },
  /** display-message 등가 묶음 — meta + cursor{x,y} (pane_current_command/window_width/cursor_x·y) */
  info(name) {
    return request('info', { name });
  },

  /**
   * attach — 스트림 전환. 다중 attach 미러(출력 브로드캐스트·입력 전원 허용·리사이즈 latest wins).
   * @param {string} name
   * @param {object} o { cols, rows, onData(Buffer), onExit(code), onClose() }
   * @returns {Promise<{write(data), sendKeys(spec), resize(cols,rows), close()}>}
   */
  async attach(name, o = {}) {
    const sock = await ensureConn();
    return new Promise((resolve, reject) => {
      const id = ++reqSeq;
      let buf = '';
      let ready = false;
      let closed = false;
      const handle = {
        write(data) {
          const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
          try { sock.write(JSON.stringify({ t: 'i', d: b.toString('base64') }) + '\n'); } catch (_) { /* noop */ }
        },
        sendKeys(spec) {
          try { sock.write(JSON.stringify({ t: 'k', ...spec }) + '\n'); } catch (_) { /* noop */ }
        },
        resize(cols, rows) {
          try { sock.write(JSON.stringify({ t: 'r', cols, rows }) + '\n'); } catch (_) { /* noop */ }
        },
        close() { try { sock.destroy(); } catch (_) { /* noop */ } },
      };
      const fireClose = () => {
        if (closed) return;
        closed = true;
        if (typeof o.onClose === 'function') { try { o.onClose(); } catch (_) { /* noop */ } }
      };
      sock.on('close', fireClose);
      sock.on('error', () => { if (!ready) reject(new Error('attach 접속 오류')); fireClose(); });
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (!ready) {
            // 첫 줄 = attach 응답.
            if (msg.ok === false) { sock.destroy(); return reject(Object.assign(new Error(msg.error || 'attach 실패'), { code: msg.code })); }
            ready = true;
            resolve(handle);
            continue;
          }
          if (msg.t === 'o' && typeof o.onData === 'function') {
            try { o.onData(Buffer.from(String(msg.d || ''), 'base64')); } catch (_) { /* noop */ }
          } else if (msg.t === 'x' && typeof o.onExit === 'function') {
            try { o.onExit(msg.code | 0); } catch (_) { /* noop */ }
          }
        }
      });
      sock.write(JSON.stringify({ id, op: 'attach', name, cols: o.cols, rows: o.rows }) + '\n');
    });
  },
};

module.exports = api;
