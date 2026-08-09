/**
 * term-backend — 터미널 세션 백엔드의 **유일 진입점**(Windows 포팅 설계 계약 1).
 *
 * 웨이브2에서 pty.js/cpt-server.js/status-line.js/agent-watch.js/question-revive.js 의 tmux
 * 호출부는 전부 이 모듈을 경유하게 재배선된다. 시그니처는 term-host op 목록과 1:1.
 *
 *  · win32: @codingpt/term-host 파이프 클라이언트. 호스트 미기동이면 스폰 후 재시도
 *    (스폰 경쟁은 무해 — 파이프 점유가 단일 인스턴스 락이라 진 쪽은 스스로 종료한다).
 *    스폰은 WMI(Win32_Process.Create) 1차 — PC 앱(Rust)이 데몬을 Job Object(KILL_ON_JOB_CLOSE)에
 *    넣으므로 평범한 spawn 은 Job 에 상속돼 **앱 종료 시 터미널이 함께 죽는다**(계약 1 위반).
 *    WMI 생성 프로세스는 WmiPrvSE 의 자식이라 Job 밖이다. 실패 시 기존 detached 스폰 폴백.
 *  · darwin/linux: term-backend-tmux.js — 기존 runTmux/스폰 조립을 백엔드 안으로 이동(웨이브2,
 *    동작 완전 불변). 단, CPT_TERMHOST_SOCK 이 설정돼 있으면 비-win32 에서도 파이프 클라이언트로
 *    동작한다 — mac 에서 term-host 를 실제 pty 로 띄워 e2e 테스트하는 개발 경로(설계 계약 1 폴백).
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
const { spawn, execFile } = require('child_process');
const runtime = require('./runtime');

// darwin/linux 구현 — tmux 서브커맨드 조립(지연 로드: 순환 require 회피 + win32 에서 불필요).
const tmuxBackend = () => require('./term-backend-tmux');

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
  if (process.env.CPT_TERMHOST_SOCK) {
    const p = process.env.CPT_TERMHOST_SOCK;
    // win32: 파일 경로 스타일 오버라이드는 파이프 이름으로 정규화(term-host paths.normalizeWinPipe 와
    //  같은 규칙 — 어긋나면 유령 호스트를 띄운다. net.listen 은 \\.\pipe\ 외 경로에서 실패한다).
    if (process.platform === 'win32' && !/^\\\\[.?]\\pipe\\/.test(p)) {
      return `\\\\.\\pipe\\cpt-termhost-test-${crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 8)}`;
    }
    return p;
  }
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
//
// CPT_TERM_BACKEND(테스트 주입 훅): 'tmux' = win32 에서도 tmux 구현(term-backend-tmux) 강제.
//  존재 이유 — runTmux 몽키패치로 도는 스텁 테스트 7종(agent-watch/chat-mode/codex-mode/
//  context-gate/question-revive/status-line/tui-dialog)이 win32 CI 에서 파이프 경로를 타면
//  스텁이 백엔드에 안 걸린다(합성 화면 미도달·파이프 접속 시도). tmux 구현은 실행을
//  `pty().runTmux` **호출 시점 지연 참조**로 하므로, 이 훅으로 강제하면 tmux 바이너리 없이도
//  몽키패치가 그대로 걸린다. 'host' = 반대 방향 강제(대칭 완비 — 현재 소비자 없음).
//  ⚠ 프로덕션 경로에서 이 env 를 세우지 말 것 — win32 실사용은 항상 파이프다.
function isHostBackend() {
  if (process.env.CPT_TERM_BACKEND === 'tmux') return false;
  if (process.env.CPT_TERM_BACKEND === 'host') return true;
  return process.platform === 'win32' || !!process.env.CPT_TERMHOST_SOCK;
}

// ── 호스트 스폰(미기동 시) ─────────────────────────────────────────────────
// detached 스폰(비-win32 정규 경로 + win32 WMI 실패 폴백).
function spawnDetached(entry) {
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

/**
 * win32 WMI 스폰 명령 조립 — **순수 함수**(mac 유닛테스트 대상, 실행 무접촉).
 *
 * 왜 WMI 인가: PC 앱(Rust)이 데몬을 Job Object(KILL_ON_JOB_CLOSE|BREAKAWAY_OK)에 넣는데,
 *  Node 의 spawn 은 CREATE_BREAKAWAY_FROM_JOB 을 줄 수 없어 자식(term-host)이 Job 에 상속된다
 *  → 앱을 끄면 터미널 세션이 전멸한다(계약 1 "데몬이 죽어도 터미널 생존" 위반).
 *  Invoke-CimMethod Win32_Process.Create 로 만들면 생성 프로세스가 WmiPrvSE(서비스)의 자식이라
 *  Job 밖에서 태어난다. env(CPT_TERMHOST_SOCK/CODINGPT_STATE_DIR — 유령 호스트 방지 필수)는
 *  WMI 가 부모 env 를 물려주지 않으므로 cmd `set "K=V"` 체인으로 명령줄에 실어 전달한다.
 *
 * 인용 규율: cmd 는 `/d /s /c "…"`(양끝 따옴표 제거 모드 — 내부 따옴표 보존), 경로는 각각 "…",
 *  PowerShell 문자열은 '…'(작은따옴표 이스케이프 = 두 배). ShowWindow=0 으로 콘솔 무표시.
 */
function buildWmiSpawnSpec({ nodePath, entry, sockPath, stateDir }) {
  const inner = [
    `set "CPT_TERMHOST_SOCK=${sockPath}"`,
    `set "CODINGPT_STATE_DIR=${stateDir}"`,
    `"${nodePath}" "${entry}" run`,
  ].join(' && ');
  const cmdLine = `cmd.exe /d /s /c "${inner}"`;
  const psq = cmdLine.replace(/'/g, "''");
  const script = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = 0 };',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psq}'; ProcessStartupInformation = $si };`,
    'if ($null -eq $r -or $r.ReturnValue -ne 0) { exit 1 };',
    "Write-Output ('CPT_TERMHOST_PID=' + $r.ProcessId)",
  ].join(' ');
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cmdLine,
  };
}

// win32: WMI 1차(Job 탈출) → 실패 시 detached 폴백(fire-and-forget — ensureConn 의 재시도 루프가
//  접속을 기다린다). 폴백은 Job 상속을 감수한다(앱 종료 시 세션 사망 리스크가 있지만 무스폰보단 낫다).
function spawnHostWin32(entry) {
  const spec = buildWmiSpawnSpec({
    nodePath: process.execPath,
    entry,
    sockPath: pipePath(),
    stateDir: runtime.stateDir(),
  });
  execFile(spec.file, spec.args, { timeout: 15000, windowsHide: true }, (err, stdout) => {
    if (!err && /CPT_TERMHOST_PID=\d+/.test(String(stdout || ''))) return;
    console.warn(`[term-backend] WMI 스폰 실패 — detached 폴백(Job 상속 감수): ${(err && err.message) || String(stdout || '').trim() || 'ReturnValue!=0'}`);
    try { spawnDetached(entry); } catch (e) { console.error('[term-backend] 폴백 스폰도 실패:', (e && e.message) || e); }
  });
  return null; // pid 는 비동기 판정 — 접속 성공이 곧 성공의 정의다
}

function spawnHost() {
  const entry = hostEntry();
  if (!entry) throw new Error('term-host 엔트리를 찾을 수 없습니다(@codingpt/term-host 미설치)');
  if (process.platform === 'win32') return spawnHostWin32(entry);
  return spawnDetached(entry);
}

function connectOnce(sockPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    const to = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(to); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(to); reject(e); });
  });
}

// 접속 확보 — 실패 시 1회 스폰 후 백오프 재시도(~3초, win32 는 WMI/PowerShell 기동 지연을 감안해
//  ~9초). 스폰 경쟁은 파이프 락이 중재.
let spawnedOnce = false;
async function ensureConn() {
  if (!isHostBackend()) {
    // 방어선: 파이프 경로는 호스트 백엔드에서만 탄다(비-win32 는 tmux 구현으로 분기됨).
    throw new Error('term-backend: 파이프 백엔드 비활성(win32 또는 CPT_TERMHOST_SOCK 필요)');
  }
  const p = pipePath();
  try { return await connectOnce(p); } catch (_) { /* 미기동 — 스폰 경로 */ }
  if (!spawnedOnce) { spawnHost(); spawnedOnce = true; }
  let lastErr = null;
  const tries = process.platform === 'win32' ? 60 : 20;
  for (let i = 0; i < tries; i++) {
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

// ── 단발 op 1:1 API(설계 계약 1) — win32/env: 파이프, darwin/linux: tmux 구현 ──
const api = {
  isHostBackend,
  pipePath,
  hostEntry,
  _buildWmiSpawnSpec: buildWmiSpawnSpec,

  /** 세션 생성 — tmux new-session -d -s <name> -c <cwd> -e … 등가 */
  create({ name, cwd, env, cols, rows, shell } = {}) {
    if (!isHostBackend()) return tmuxBackend().create({ name, cwd, env, cols, rows });
    return request('create', { name, cwd, env, cols, rows, shell });
  },
  /** 세션 목록 — [{name,title,windowName,command,panePid,createdAt,cols,rows,cwd,modes}]
   *  (tmux 구현은 {name,createdAt,windowName,command,title} — 소비자 전수의 교집합 키) */
  async list() {
    if (!isHostBackend()) return tmuxBackend().list();
    return (await request('list')).sessions;
  },
  /** 모든 세션 이름 — tmux 는 list-sessions(뷰/풀/레거시 포함), 호스트는 list 의 이름 사상 */
  async listSessionNames() {
    if (!isHostBackend()) return tmuxBackend().listSessionNames();
    return (await request('list')).sessions.map((s) => String(s.name || '')).filter(Boolean);
  },
  /** has-session 등가 — boolean */
  async has(name) {
    if (!isHostBackend()) return tmuxBackend().has(name);
    return (await request('has', { name })).exists;
  },
  /** kill-session 등가(멱등) */
  kill(name) {
    if (!isHostBackend()) return tmuxBackend().kill(name);
    return request('kill', { name });
  },
  /** kill-server 등가 — 세션 전멸 + 호스트 종료 */
  killServer() {
    if (!isHostBackend()) return tmuxBackend().killServer();
    return request('killServer').catch((e) => {
      // 호스트가 응답 직후 종료하며 소켓이 끊길 수 있다 — 접속 자체가 안 되면 이미 없음(성공 취급).
      if (e && /ECONNREFUSED|ENOENT|시간 초과/.test(String(e.message))) return { ok: true };
      throw e;
    });
  },
  /** send-keys 등가 — data(원시 바이트) 또는 keys(tmux 표기 배열). literal=-l, count=-N */
  sendKeys(name, { data, keys, literal, count } = {}) {
    if (!isHostBackend()) return tmuxBackend().sendKeys(name, { data, keys, literal, count });
    return request('sendKeys', { name, data, keys, literal, count });
  },
  /** capture-pane 등가 — escapes=-e, lines=-S -N, join=-J. 반환: 화면 텍스트 */
  async capture(name, { escapes, lines, join } = {}) {
    if (!isHostBackend()) return tmuxBackend().capture(name, { escapes, lines, join });
    return (await request('capture', { name, escapes, lines, join })).text;
  },
  /** 리사이즈 — latest wins(window-size latest 등가. tmux 는 attach 클라이언트가 담당 = no-op) */
  resize(name, cols, rows) {
    if (!isHostBackend()) return tmuxBackend().resize(name, cols, rows);
    return request('resize', { name, cols, rows });
  },
  /** set-environment 등가(이후 respawn 프로세스에 반영) */
  setEnv(name, k, v) {
    if (!isHostBackend()) return tmuxBackend().setEnv(name, k, v);
    return request('setEnv', { name, k, v });
  },
  /** show-environment <k> 등가 — 값 또는 null */
  async getEnv(name, k) {
    if (!isHostBackend()) return tmuxBackend().getEnv(name, k);
    return (await request('getEnv', { name, k })).value;
  },
  /** rename-window 등가(수동 이름 = automatic-rename off. 빈 값 = 자동 복귀) */
  rename(name, title) {
    if (!isHostBackend()) return tmuxBackend().rename(name, title);
    return request('rename', { name, title });
  },
  /** respawn-pane -k 등가. 죽은 세션(호스트 크래시 저널 고아)도 이 op 로만 복원한다 */
  respawn(name, { cwd, cols, rows } = {}) {
    if (!isHostBackend()) return tmuxBackend().respawn(name, { cwd });
    return request('respawn', { name, cwd, cols, rows });
  },
  /** display-message 등가 묶음 — meta + cursor{x,y} (pane_current_command/window_width/cursor_x·y) */
  info(name) {
    if (!isHostBackend()) return tmuxBackend().info(name);
    return request('info', { name });
  },

  /**
   * attach — 스트림 전환. 다중 attach 미러(출력 브로드캐스트·입력 전원 허용·리사이즈 latest wins).
   *  tmux 구현은 node-pty 로 tmux 클라이언트를 스폰한다(옵션 {cwd, setLatest, sharedCreate} 는
   *  darwin 전용 — 종전 attachPty 의 spawnArgs 를 그대로 재현하기 위한 것. 호스트 경로는 무시).
   * @param {string} name
   * @param {object} o { cols, rows, onData(Buffer|string), onExit(code), onClose() }
   * @returns {Promise<{write(data), sendKeys(spec), resize(cols,rows), close()}>}
   */
  async attach(name, o = {}) {
    if (!isHostBackend()) return tmuxBackend().attach(name, o);
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
