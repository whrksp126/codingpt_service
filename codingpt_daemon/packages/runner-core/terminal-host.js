'use strict';

// TerminalHost — 터미널(tmux 세션) 하나의 **정본**. docs/terminal-v3-design.md §2.
//
//  tmux 세션 ──%output 원시바이트──▶ TerminalHost ──OUTPUT(seq)──▶ 뷰어 N
//                                    ├ VT(headless xterm) = 스냅샷·과거·모드·커서의 유일한 출처
//                                    ├ owner(기기 1명) = 크기를 정하는 유일한 주체
//                                    └ 링버퍼(2 MiB) = 재접속 이어받기
//
// 규칙:
//  · 크기는 owner 의 resize 만 받는다. 비소유자 resize 는 무시(OWNER 프레임으로 되돌려줌).
//  · 소유권은 사용자가 명시적으로 가져간다(claim). 자동 탈취 없음 — 재배치 폭풍의 원인이라서.
//  · 뷰어가 0 이어도 VT 는 유지한다(과거 보존). 데몬 재시작 시 capture-pane 으로 1회 시드.
const EventEmitter = require('events');
const { Screen } = require('../term-host/lib/screen');
const { TmuxControl } = require('./tmux-control');

const RING_BYTES = 2 * 1024 * 1024;   // sshx 와 같은 2 MiB — 이 안이면 seq 이어받기, 밖이면 스냅샷
const MIN_COLS = 8, MIN_ROWS = 3;     // 격자가 숨겨진 뷰어의 fit 이 주는 퇴화값(2x1) 차단
const MAX_COLS = 500, MAX_ROWS = 200;

class TerminalHost extends EventEmitter {
  /**
   * @param {object} o { name: tmux 세션명, tmux, socket, env, runTmux, cols, rows, owner:{deviceId,name}|null }
   */
  constructor(o) {
    super();
    this.name = String(o.name);
    this.runTmux = o.runTmux;
    this.cols = clampCols(o.cols || 80);
    this.rows = clampRows(o.rows || 24);
    this.owner = o.owner || null;          // {deviceId, name}
    this.screen = new Screen(this.cols, this.rows);
    this.seq = 0;                          // OUTPUT 프레임 seq(단조 — **이 세대 안에서만** 유효)
    // 세대 식별자 — host 가 새로 만들어질 때마다(데몬 재시작·세션 재생성) 바뀐다. seq 는 세대 안에서만
    //  의미가 있어서, 이게 없으면 재시작 뒤 옛 뷰어의 seq 를 최신으로 오판해 화면이 멈춘다(replaySince).
    this.epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.ring = [];                        // [{seq, buf}]
    this.ringBytes = 0;
    this.viewers = new Set();              // 구독 콜백 fn(frame)
    this.closed = false;
    this.exitCode = null;
    this.control = new TmuxControl({ tmux: o.tmux, socket: o.socket, session: this.name, env: o.env });
    this.control.on('output', (buf) => this._onOutput(buf));
    this.control.on('layout', (l) => this._onLayout(l));
    this.control.on('tmux-exit', () => this._onExit(0));
    this.control.on('exit', (code) => this._onExit(code));
    this.control.on('error', (e) => this.emit('error', e));
    this.ready = this._open();
  }

  async _open() {
    this.control.start();
    // 데몬 재시작 등으로 이미 내용이 있는 세션이면 VT 를 tmux 격자로 1회 시드한다(유일한 capture 사용처).
    //  history + 현재화면. 이후엔 %output 원시 바이트만으로 정본이 이어진다.
    try {
      const [hist, scr] = await Promise.all([
        this.runTmux(['capture-pane', '-e', '-p', '-t', `=${this.name}:0`, '-S', '-10000', '-E', '-1']),
        this.runTmux(['capture-pane', '-e', '-p', '-t', `=${this.name}:0`]),
      ]);
      const h = String(hist || '').replace(/\n$/, '');
      const s = String(scr || '').replace(/\n$/, '');
      const seed = '\x1b[3J\x1b[H\x1b[2J'
        + (h ? h.replace(/\n/g, '\x1b[0m\r\n') + '\x1b[0m\r\n' : '')
        + '\r\n'.repeat(this.rows) + '\x1b[H\x1b[2J' + s.replace(/\n/g, '\x1b[0m\r\n');
      this.screen.write(seed);
      await this.screen.flush();
    } catch (_) { /* 새 세션 등 — 빈 화면에서 시작 */ }
    // 크기 확정: 이 컨트롤 클라이언트가 유일하므로 window 가 정확히 이 값이 된다.
    await this.control.resize(this.cols, this.rows).catch(() => {});
    return this;
  }

  _onOutput(buf) {
    if (this.closed) return;
    this.screen.write(buf);
    const frame = { type: 'output', seq: ++this.seq, buf };
    this.ring.push({ seq: frame.seq, buf });
    this.ringBytes += buf.length;
    while (this.ringBytes > RING_BYTES && this.ring.length > 1) {
      this.ringBytes -= this.ring[0].buf.length;
      this.ring.shift();
    }
    this._broadcast(frame);
  }

  _onLayout(l) {
    // tmux 가 실제로 잡은 크기. 우리가 요청한 값과 다르면(구버전 tmux 등) VT 를 tmux 에 맞춘다.
    if (!l || !l.cols || !l.rows) return;
    if (l.cols === this.cols && l.rows === this.rows) return;
    this.cols = l.cols; this.rows = l.rows;
    this.screen.resize(this.cols, this.rows);
    this._broadcast({ type: 'resized', cols: this.cols, rows: this.rows });
  }

  _onExit(code) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code | 0;
    this._broadcast({ type: 'exit', code: this.exitCode });
    this.viewers.clear();
    try { this.screen.dispose(); } catch (_) { /* noop */ }
    this.emit('closed', this.exitCode);
  }

  _broadcast(frame) {
    for (const fn of this.viewers) { try { fn(frame); } catch (_) { /* viewer isolation */ } }
  }

  // ── 뷰어 API ─────────────────────────────────────────────────────────────
  subscribe(fn) {
    this.viewers.add(fn);
    let off = false;
    return () => { if (off) return; off = true; this.viewers.delete(fn); };
  }

  /** 재접속 이어받기: lastSeq 다음부터의 OUTPUT 들. 링버퍼 밖이면 null(스냅샷 필요). */
  /**
   * 재접속 이어받기. 이어 붙일 수 있으면 프레임 배열, **못 하면 null**(호출자는 스냅샷을 보낸다).
   *
   * ★ epoch 가 필요한 이유(2026-09-06 실기 사고): 데몬이 재시작하면 host 가 새로 만들어져 seq 가
   *  0 부터 다시 센다. 그때 옛 뷰어가 큰 lastSeq 로 hello 하면 예전 코드는 `n >= this.seq` 를
   *  "너는 최신"으로 읽어 아무것도 안 보냈고, 그 화면은 **영원히 멈췄다**(PC 에서 작업해도 폰/패드에
   *  아무 변화 없음). seq 는 세대 안에서만 의미가 있으므로 세대 식별자로 먼저 가른다.
   *  epoch 를 안 보내는 구 뷰어를 위해 "정본보다 앞선 seq" 도 이어받기 불가로 본다.
   */
  replaySince(lastSeq, epoch) {
    if (epoch != null && String(epoch) !== this.epoch) return null;
    const n = Number(lastSeq) || 0;
    if (n > this.seq) return null;       // 정본보다 앞섬 = 다른 세대의 seq
    if (n === this.seq) return [];       // 진짜로 최신
    if (!this.ring.length || this.ring[0].seq > n + 1) return null;
    return this.ring.filter((r) => r.seq > n);
  }

  async snapshot() {
    await this.ready;
    await this.screen.flush();
    return {
      cols: this.cols, rows: this.rows, owner: this.owner, seq: this.seq, epoch: this.epoch,
      modes: this.modes(),
      cursor: this.screen.cursor(),
      ansi: this.screen.serializeRepaint(),
    };
  }

  modes() {
    return {
      appCursor: this.screen.appCursor, bracketedPaste: this.screen.bracketedPaste,
      mouseTracking: this.screen.mouseTracking, altScreen: this.screen.altScreen,
    };
  }

  async historyPage(o = {}) {
    await this.ready;
    await this.screen.flush();
    return this.screen.historyPage(o);
  }

  input(buf) {
    if (this.closed) return Promise.resolve();
    return this.control.input(buf);
  }

  /** 소유자만 크기를 바꾼다. 반환: 적용 여부. */
  async resize(cols, rows, deviceId) {
    if (this.closed) return false;
    if (!this.isOwner(deviceId)) return false;
    const c = clampCols(cols), r = clampRows(rows);
    if (c !== (cols | 0) || r !== (rows | 0)) return false;   // 퇴화/과대 값은 거부(조용히 접히지 않게)
    if (c === this.cols && r === this.rows) return true;
    this.cols = c; this.rows = r;
    this.screen.resize(c, r);
    this._broadcast({ type: 'resized', cols: c, rows: r });
    await this.control.resize(c, r).catch(() => {});
    return true;
  }

  isOwner(deviceId) {
    if (!this.owner) return true;               // 아직 아무도 안 잡았으면 첫 요청자가 잡는다(claim 과 동일)
    return !!deviceId && this.owner.deviceId === deviceId;
  }

  /** 명시적 소유권 이전. 크기는 새 소유자가 곧 보낼 resize 가 정한다. */
  async claim(device) {
    if (!device || !device.deviceId) return this.owner;
    this.owner = { deviceId: String(device.deviceId), name: String(device.name || '') };
    this._broadcast({ type: 'owner', owner: this.owner });
    // 데몬 재시작에도 남게 tmux window 옵션에 기록한다.
    await this.runTmux(['set-option', '-w', '-t', `=${this.name}:0`, '@cpt_owner', JSON.stringify(this.owner)]).catch(() => {});
    return this.owner;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.control.close(); } catch (_) { /* noop */ }
    try { this.screen.dispose(); } catch (_) { /* noop */ }
    this.viewers.clear();
    this.emit('closed', null);
  }
}

function clampCols(c) { return Math.max(MIN_COLS, Math.min(MAX_COLS, c | 0)); }
function clampRows(r) { return Math.max(MIN_ROWS, Math.min(MAX_ROWS, r | 0)); }

/** 세션명 → TerminalHost. 닫힌 호스트는 자동으로 빠진다. */
class TerminalHostRegistry {
  constructor(deps) { this.deps = deps; this.hosts = new Map(); }
  async get(name, o = {}) {
    const key = String(name);
    let h = this.hosts.get(key);
    if (h && !h.closed) return h;
    // 저장된 소유자 복원(데몬 재시작).
    let owner = null;
    try {
      const raw = await this.deps.runTmux(['show-options', '-wv', '-t', `=${key}:0`, '@cpt_owner']);
      owner = JSON.parse(String(raw).trim() || 'null');
    } catch (_) { owner = null; }
    h = new TerminalHost({ ...this.deps, name: key, owner, ...o });
    h.once('closed', () => { if (this.hosts.get(key) === h) this.hosts.delete(key); });
    this.hosts.set(key, h);
    return h;
  }
  has(name) { const h = this.hosts.get(String(name)); return !!(h && !h.closed); }
  close(name) { const h = this.hosts.get(String(name)); if (h) h.close(); this.hosts.delete(String(name)); }
  closeAll() { for (const h of this.hosts.values()) h.close(); this.hosts.clear(); }
}

module.exports = { TerminalHost, TerminalHostRegistry, RING_BYTES, MIN_COLS, MIN_ROWS };
