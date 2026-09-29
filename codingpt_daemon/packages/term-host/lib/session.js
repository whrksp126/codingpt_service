/**
 * 세션 = tmux 세션의 등가물 — pty 1개(win32: ConPTY, darwin 개발: 일반 pty)
 *  + 서버사이드 스크린 버퍼(Screen) + env맵 + title + 다중 attach 브로드캐스트.
 *
 * tmux 와 같은 의미론을 유지한다(웨이브2 재배선이 "이름만 바꿔" 성립하는 조건):
 *  · 세션명 = 기존 그대로 `cpt-<ws>--t-<tid>` 문자열(상위 계층 무수정).
 *  · 셸 프로세스가 죽으면 세션도 죽는다(tmux 기본 — "세션이 없다 = 닫혔다"는 결정적 상태).
 *  · setEnv 는 "이후 spawn(=respawn)되는 프로세스"에만 반영(tmux set-environment 동일 — 이미 뜬
 *    셸엔 안 먹는다. 초기 셸에 넣을 값은 create 의 env 로 — new-session -e 등가).
 *  · 리사이즈는 latest wins(window-size latest) — 어느 attach/RPC 가 요청했든 마지막 값 하나.
 *  · 자동 rename: 포그라운드가 셸이면 폴더명, 아니면 OSC 타이틀(호스트형 제외) → 프로세스명
 *    (tmux automatic-rename-format 등가). rename{} 수동 지정 시 automatic-rename off 등가.
 */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const nodePty = require('node-pty');
const { Screen } = require('./screen');
const { keysToBytes } = require('./keys');
const paths = require('./paths');

// 셸 판정(자동 rename 용) — darwin/linux + win32 셸 전부.
const SHELL_NAMES = new Set([
  'zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh',
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe',
]);

// win32 셸 탐색: pwsh → powershell → cmd (설계 계약 1). PATHEXT 아닌 고정 .exe 이름으로 PATH 순회.
function findInPath(exe) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.existsSync(p)) return p; } catch (_) { /* noop */ }
  }
  return null;
}

function defaultShell() {
  if (process.platform === 'win32') {
    return findInPath('pwsh.exe') || findInPath('powershell.exe') || process.env.ComSpec || 'cmd.exe';
  }
  // darwin(개발/테스트)·linux — 사용자 로그인 셸 우선.
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/**
 * 기본 셸 스펙 {shell, args} — win32 셸 프로필 주입(계약 4)을 **여기 한 곳**에 내장한다.
 *
 * 세션 생성 주체가 둘이다(데몬 create + PC 앱의 create op). 프로필 규칙을 term-host 의 기본값으로
 * 두면 두 주체가 자동으로 한 벌이 된다:
 *  · pwsh/powershell: `-NoLogo -NoExit -Command ". '<stateDir>\shim\ps\cpt-profile.ps1'"`
 *    (cpt-profile.ps1 = ① 사용자 $PROFILE dot-source ② PATH prepend ③ claude/codex/cpt 함수)
 *  · cmd.exe 폴백:    `/K "<stateDir>\shim\cmd\cpt-init.cmd"` (PATH prepend 동형)
 *  · 프로필 파일이 아직 없으면(데몬 미가동·shim 미생성) 인자 없이 민짜 셸 — 조용한 실패 대신
 *    "터미널은 항상 열린다" 를 지키고, 다음 세션부터 프로필이 적용된다.
 * create op 이 shell/args 를 명시하면 그것이 우선한다(호출자 의도 존중 — 테스트/특수 세션).
 */
function defaultShellSpec() {
  const shell = defaultShell();
  if (process.platform !== 'win32') return { shell, args: [] };
  const base = path.basename(String(shell)).toLowerCase();
  if (base === 'pwsh.exe' || base === 'powershell.exe' || base === 'pwsh' || base === 'powershell') {
    const profile = path.join(paths.stateDir(), 'shim', 'ps', 'cpt-profile.ps1');
    if (fileExists(profile)) {
      // ★ -ExecutionPolicy Bypass 는 필수다. Windows 기본 정책(Restricted)에서는 .ps1 dot-source 가
      //  PSSecurityException(UnauthorizedAccess)로 막혀 프로필이 통째로 안 실린다 → claude/codex/cpt
      //  래퍼가 정의되지 않아 **터미널은 열리는데 BYO 연동만 조용히 죽는다**(2026-08-14 실기 실측).
      //  이 플래그는 **이 프로세스에만** 적용된다 — 머신/사용자 정책은 건드리지 않는다(무수정 원칙).
      //  단, GPO 로 정책이 강제된 환경에서는 무시될 수 있다. 그때도 셸 자체는 열린다(아래 폴백과 동일 취지).
      return {
        shell,
        args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${profile.replace(/'/g, "''")}'`],
      };
    }
    return { shell, args: [] };
  }
  // cmd.exe 계열
  const init = path.join(paths.stateDir(), 'shim', 'cmd', 'cpt-init.cmd');
  if (fileExists(init)) return { shell, args: ['/K', init] };
  return { shell, args: [] };
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// 자식 env 규율 — tmuxEnv() 등가: TMUX 제거(중첩 가드), UTF-8 로케일 강제(비-win32).
function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.TMUX;
  if (process.platform !== 'win32') {
    if (!/UTF-?8/i.test(env.LANG || '')) env.LANG = 'en_US.UTF-8';
    if (!/UTF-?8/i.test(env.LC_CTYPE || '')) env.LC_CTYPE = 'en_US.UTF-8';
  }
  return env;
}

class Session {
  /**
   * @param {object} o { name, cwd, env, cols, rows, shell, args }
   * @param {object} hooks { onDeath(session), onMutate(session) } — 서버(저널/목록)가 건다.
   */
  constructor(o, hooks = {}) {
    this.name = String(o.name);
    this.cwd = o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir();
    this.env = { ...(o.env || {}) };            // 세션 env맵(set-environment 등가 — respawn 시 반영)
    // 셸/인자: 호출자가 명시하면 그대로, 미지정이면 기본 스펙(win32 = 프로필 주입 pwsh — 계약 4.
    //  데몬 create 와 PC 앱 create op 이 여기 한 곳으로 한 벌이 된다).
    if (o.shell) {
      this.shell = o.shell;
      this.args = Array.isArray(o.args) ? o.args : [];
    } else {
      const spec = defaultShellSpec();
      this.shell = spec.shell;
      this.args = Array.isArray(o.args) && o.args.length ? o.args : spec.args;
    }
    this.manualName = null;                      // rename{} 수동 이름(automatic-rename off 등가)
    this.createdAt = Date.now();
    this.dead = false;
    this.gen = 0;                                // respawn 세대 — 구 pty 의 exit 를 무시하는 토큰
    this.attachments = new Set();                // 다중 attach 커넥션(전원 브로드캐스트)
    this.hooks = hooks;
    this.screen = new Screen(o.cols || 80, o.rows || 24);
    this.screen.onBell = () => this._broadcast({ t: 'bell' }); // BEL → attach 전원(알림 UI 재료)
    this.pty = null;
    this._spawn();
  }

  _spawn() {
    const gen = ++this.gen;
    const p = nodePty.spawn(this.shell, this.args, {
      name: 'xterm-256color',
      cols: this.screen.cols,
      rows: this.screen.rows,
      cwd: this.cwd,
      env: childEnv(this.env),
      useConpty: process.platform === 'win32' ? true : undefined,
    });
    this.pty = p;
    p.onData((data) => {
      if (gen !== this.gen) return;              // respawn 으로 교체된 구 pty 잔여 출력 무시
      this.screen.write(data);
      this._broadcast({ t: 'o', d: Buffer.from(data, 'utf8').toString('base64') });
    });
    p.onExit(({ exitCode }) => {
      if (gen !== this.gen) return;              // respawn 정상경로의 구 pty 종료
      // tmux 기본 의미론: 셸 종료 = 세션 소멸(결정적 상태). attach 전원에게 종료 통지 후 정리.
      this._broadcast({ t: 'x', code: exitCode });
      this._die();
    });
  }

  _die() {
    if (this.dead) return;
    this.dead = true;
    for (const conn of [...this.attachments]) { try { conn.end(); } catch (_) { /* noop */ } }
    this.attachments.clear();
    this.screen.dispose();
    if (this.hooks.onDeath) { try { this.hooks.onDeath(this); } catch (_) { /* noop */ } }
  }

  _mutated() {
    if (this.hooks.onMutate) { try { this.hooks.onMutate(this); } catch (_) { /* noop */ } }
  }

  _broadcast(frame) {
    if (!this.attachments.size) return;
    const line = JSON.stringify(frame) + '\n';
    for (const conn of this.attachments) {
      try { conn.write(line); } catch (_) { /* 죽은 커넥션은 close 이벤트가 회수 */ }
    }
  }

  // ── attach(미러) — 전원 출력 브로드캐스트·입력 전원 허용·리사이즈 latest wins ──
  attach(conn) {
    this.attachments.add(conn);
    // tmux attach 의 전체 리페인트 등가 — 새 뷰어가 즉시 현재 화면을 본다.
    try { conn.write(JSON.stringify({ t: 'o', d: Buffer.from(this.screen.serializeRepaint(), 'utf8').toString('base64') }) + '\n'); } catch (_) { /* noop */ }
  }

  detach(conn) {
    this.attachments.delete(conn);
  }

  write(data) {
    if (this.dead) return;
    try { this.pty.write(typeof data === 'string' ? data : data.toString('utf8')); } catch (_) { /* noop */ }
  }

  // send-keys 등가 — data(원시 바이트) 또는 keys(tmux 표기 배열, literal/-N count 지원).
  sendKeys({ data, keys, literal, count } = {}) {
    if (data != null) { this.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); return; }
    const bytes = keysToBytes(keys || [], { literal: !!literal, count, appCursor: this.screen.appCursor });
    if (bytes) this.write(bytes);
  }

  // latest wins — 호출 시점이 곧 "마지막" (별도 중재 없음 = window-size latest 등가).
  resize(cols, rows) {
    if (this.dead) return;
    const c = Math.max(2, cols | 0), r = Math.max(2, rows | 0);
    if (c === this.screen.cols && r === this.screen.rows) return;
    try { this.pty.resize(c, r); } catch (_) { /* noop */ }
    this.screen.resize(c, r);
  }

  async capture({ escapes, lines, join, historyOnly } = {}) {
    await this.screen.flush(); // 방금 들어온 출력까지 반영 후 스크랩(51ms TUI 판정 등가)
    if (historyOnly) {
      const page = this.screen.historyPage({ limit: Math.max(1, lines | 0 || 10000) });
      return page.rows.map((r) => r.text).join('\n');
    }
    return escapes ? this.screen.captureEscapes({ lines }) : this.screen.captureText({ lines, join });
  }

  setEnv(k, v) {
    if (v == null) delete this.env[String(k)];
    else this.env[String(k)] = String(v);
    this._mutated();
  }

  getEnv(k) {
    const key = String(k);
    if (Object.prototype.hasOwnProperty.call(this.env, key)) return this.env[key];
    return null;
  }

  rename(title) {
    this.manualName = title == null || title === '' ? null : String(title);
    this._mutated();
  }

  // respawn-pane -k 등가 — 프로세스 강제 교체(cwd 덮어쓰기 가능), 세션/스크린 히스토리는 유지.
  respawn({ cwd } = {}) {
    if (cwd && fs.existsSync(cwd)) this.cwd = cwd;
    const old = this.pty;
    this.gen++; // 이 시점부터 구 pty 의 onExit/_onData 는 무시된다
    try { old.kill(); } catch (_) { /* noop */ }
    this._spawn();
    this._mutated();
  }

  kill() {
    const p = this.pty;
    this.gen++;                                  // onExit 의 이중 정리 방지 — 여기서 직접 죽인다
    try { p.kill(); } catch (_) { /* noop */ }
    this._broadcast({ t: 'x', code: 0 });
    this._die();
  }

  // 포그라운드 프로세스명 — node-pty 크로스플랫폼(darwin: proc info, win32: ConPTY 프로세스).
  command() {
    try { return String(this.pty.process || '').trim(); } catch (_) { return ''; }
  }

  // tmux automatic-rename-format 등가의 window name.
  windowName() {
    if (this.manualName) return this.manualName;
    const cmd = this.command();
    const base = cmd ? path.basename(cmd).toLowerCase() : '';
    if (!cmd || SHELL_NAMES.has(cmd) || SHELL_NAMES.has(base)) return path.basename(this.cwd);
    const title = this.screen.title;
    const host = os.hostname();
    const shortHost = host.split('.')[0];
    const hostLike = !title || title === host || title === shortHost || title.includes('@' + shortHost);
    return hostLike ? cmd : title;
  }

  meta() {
    return {
      name: this.name,
      title: this.screen.title,
      windowName: this.windowName(),
      command: this.command(),
      panePid: this.dead ? 0 : (this.pty && this.pty.pid) || 0,
      createdAt: this.createdAt,
      cols: this.screen.cols,
      rows: this.screen.rows,
      cwd: this.cwd,
      modes: { appCursor: this.screen.appCursor, bracketedPaste: this.screen.bracketedPaste },
    };
  }

  // 저널 레코드(크래시 복원 = respawn 정책의 재료). args 포함 — win32 프로필 주입 셸(계약 4)이
  //  크래시 복원 후에도 같은 인자로 되살아난다.
  journalEntry() {
    return { name: this.name, cwd: this.cwd, env: this.env, title: this.manualName, createdAt: this.createdAt, shell: this.shell, args: this.args };
  }
}

module.exports = { Session, defaultShell, defaultShellSpec, childEnv, SHELL_NAMES };
