'use strict';

// 터미널별 단일 VT 정본. backend(tmux/term-host) attach는 정확히 하나만 만들고 모든 원격
// 뷰어가 같은 Screen과 단조 sequence를 구독한다. 클라이언트별 xterm 재구성은 단계적으로 이
// 모델의 snapshot/diff/history API로 교체한다.
const { Screen } = require('../term-host/lib/screen');

// 마지막 뷰어가 떠난 뒤 모델을 살려 두는 시간. 탭 전환·네트워크 순단으로 되돌아오는 흔한 경우엔
//  attach 와 history seed 를 다시 하지 않고, 그 시간을 넘기면 VT·tmux attach 클라이언트를 회수한다.
//  ⚠ 이 회수가 없으면 뷰어가 다 끊긴 뒤에도 터미널마다 tmux 클라이언트 1개 + 10k행 스크롤백이
//    데몬에 영구히 남는다(2026-09-04 실측: 13일 전 모바일 세션의 89x21 attach 가 살아 있었다).
const IDLE_CLOSE_MS = Math.max(1000, Number(process.env.CPT_CANONICAL_IDLE_MS) || 30000);

class CanonicalTerminal {
  constructor(name, backend, o = {}) {
    this.name = String(name);
    this.backend = backend;
    this.cols = Math.max(2, o.cols | 0 || 80);
    this.rows = Math.max(2, o.rows | 0 || 24);
    this.cwd = o.cwd;
    this.screen = new Screen(this.cols, this.rows);
    this.seq = 0;
    this.subscribers = new Set();
    this.handle = null;
    this.closed = false;
    this.disposed = false;
    this.idleMs = Math.max(0, o.idleMs == null ? IDLE_CLOSE_MS : o.idleMs | 0);
    this.idleTimer = null;
    this.onRelease = null; // registry 가 map 에서 자기 자신을 떼어내는 훅
    this.ready = this._open();
  }

  async _open() {
    const responseQueue = [];
    this.screen.onData = (data) => {
      if (this.handle) this.handle.write(data);
      else responseQueue.push(data);
    };
    this.handle = await this.backend.attach(this.name, {
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      ignoreSize: true,
      onData: (data) => this._onData(data),
      onExit: (code) => this._onExit(code),
      onClose: () => this._onExit(0),
    });
    // attach 가 도는 동안 회수됐으면(마지막 뷰어 이탈/세션 종료) 갓 만든 핸들을 즉시 닫는다.
    if (this.disposed) { try { this.handle.close(); } catch (_) { /* noop */ } this.handle = null; return this; }
    for (const data of responseQueue.splice(0)) this.handle.write(data);
    // 기존 tmux 세션을 처음 canonical 모델로 감쌀 때, attach 이전 history를 서버 VT에 seed한다.
    // 초기 raw repaint가 안정된 뒤 authoritative capture로 한 번 교체하고 이후 출력만 누적한다.
    if (typeof this.backend.captureHistory === 'function' && typeof this.backend.capture === 'function') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      try {
        const [historyRaw, screenRaw] = await Promise.all([
          this.backend.captureHistory(this.name, { escapes: true, lines: 10000 }),
          this.backend.capture(this.name, { escapes: true, lines: 0 }),
        ]);
        this.screen.reset();
        const history = String(historyRaw || '').replace(/\n/g, '\r\n');
        const screen = String(screenRaw || '').replace(/\n/g, '\r\n');
        this.screen.write('\x1b[3J\x1b[H\x1b[2J' + (history ? history + '\r\n' : '') + '\r\n'.repeat(this.rows) + '\x1b[H\x1b[2J' + screen);
        await this.screen.flush();
      } catch (_) { /* 새 세션/종료 경쟁은 raw attach repaint로 폴백 */ }
    }
    return this;
  }

  _onData(data) {
    if (this.closed) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.screen.write(payload.toString('utf8'));
    const frame = { type: 'output', seq: ++this.seq, payload };
    for (const fn of this.subscribers) { try { fn(frame); } catch (_) { /* subscriber isolation */ } }
  }

  _onExit(code) {
    if (this.closed) return;
    this.closed = true;
    const frame = { type: 'exit', seq: ++this.seq, code: code | 0 };
    for (const fn of this.subscribers) { try { fn(frame); } catch (_) { /* subscriber isolation */ } }
    this.subscribers.clear();
    // 세션이 죽으면 VT·attach 핸들도 같이 회수한다. 예전엔 closed 플래그만 세워 headless
    //  terminal 과 backend 핸들이 데몬이 죽을 때까지 남았다.
    this._dispose();
    this._release();
  }

  _release() {
    if (!this.onRelease) return;
    try { this.onRelease(this); } catch (_) { /* noop */ }
  }

  _dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.screen.onData = null;
    try { this.handle && this.handle.close(); } catch (_) { /* noop */ }
    try { this.screen.dispose(); } catch (_) { /* noop */ }
    this.subscribers.clear();
  }

  // 마지막 구독자가 떠났을 때만 예약한다. 유예 안에 새 뷰어가 붙으면 subscribe 가 취소한다.
  _scheduleIdleClose() {
    if (this.closed || this.subscribers.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || this.subscribers.size) return;
      this.close();
      this._release();
    }, this.idleMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async snapshot() {
    await this.ready;
    await this.screen.flush();
    return {
      seq: this.seq,
      cols: this.screen.cols,
      rows: this.screen.rows,
      cursor: this.screen.cursor(),
      historyDepth: this.screen.historyPage({ limit: 1 }).total,
      modes: {
        appCursor: this.screen.appCursor,
        bracketedPaste: this.screen.bracketedPaste,
      },
      ansi: this.screen.serializeRepaint(),
    };
  }

  // 스크롤 라우팅용 모드 정본. altScreen 은 백엔드가 더 정확히 알 수 있어(tmux 는 alternate-screen
  //  off 로 클라이언트에 1049 를 안 보낸다) 호출자가 override 를 얹을 수 있게 열어 둔다.
  async modes(override = {}) {
    await this.ready;
    await this.screen.flush();
    return {
      mouseTracking: this.screen.mouseTracking,
      altScreen: this.screen.altScreen,
      appCursor: this.screen.appCursor,
      bracketedPaste: this.screen.bracketedPaste,
      ...override,
    };
  }

  // 과거의 정본은 **백엔드(tmux)** 다. 이 Screen 의 스크롤백을 쓰면 tmux 가 리사이즈마다 pane 을
  //  통째로 다시 그리는 잔재까지 "과거"로 쌓인다(실측 2026-09-04: 리사이즈 7회에 tmux 대비 43줄 과다).
  //  멀티기기에서는 window-size latest 로 그 리사이즈가 상시 일어나 과거가 뭉개진다.
  //  백엔드가 못 주면(term-host) VT 스크롤백으로 폴백한다 — 그쪽은 tmux 재도장 자체가 없다.
  async historyPage(o = {}) {
    await this.ready;
    await this.screen.flush();
    if (typeof this.backend.historyPage === 'function') {
      try {
        const page = await this.backend.historyPage(this.name, o);
        if (page) return { modelSeq: this.seq, source: 'backend', ...page };
      } catch (_) { /* 세션 종료 경쟁 등 — VT 폴백 */ }
    }
    return { modelSeq: this.seq, source: 'vt', ...this.screen.historyPage(o) };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    let released = false;
    return () => {
      if (released) return; // 중복 해제로 refcount 가 음수처럼 굴지 않게
      released = true;
      this.subscribers.delete(fn);
      this._scheduleIdleClose();
    };
  }

  async write(data) {
    await this.ready;
    this.handle.write(data);
  }

  async resize(cols, rows) {
    await this.ready;
    const c = Math.max(2, cols | 0), r = Math.max(2, rows | 0);
    if (c === this.screen.cols && r === this.screen.rows) return false;
    this.handle.resize(c, r);
    this.screen.resize(c, r);
    this.cols = c; this.rows = r;
    return true;
  }

  close() {
    this.closed = true;
    this._dispose();
  }
}

class CanonicalTerminalRegistry {
  constructor(backend, o = {}) {
    this.backend = backend;
    this.idleMs = o.idleMs;
    this.terminals = new Map();
  }

  get(name, o = {}) {
    const key = String(name);
    let model = this.terminals.get(key);
    if (!model || model.closed) {
      model = new CanonicalTerminal(key, this.backend, { idleMs: this.idleMs, ...o });
      // 모델이 스스로 수명을 끝내면(세션 종료·유휴 회수) map 에서도 빠진다. 그래야 다음 attach 가
      //  죽은 모델을 재사용하지 않고, 죽은 엔트리가 무한히 쌓이지도 않는다.
      model.onRelease = (m) => { if (this.terminals.get(key) === m) this.terminals.delete(key); };
      this.terminals.set(key, model);
    }
    return model;
  }

  close(name) {
    const key = String(name);
    const model = this.terminals.get(key);
    if (model) model.close();
    this.terminals.delete(key);
  }

  closeAll() {
    for (const model of this.terminals.values()) model.close();
    this.terminals.clear();
  }
}

module.exports = { CanonicalTerminal, CanonicalTerminalRegistry };
