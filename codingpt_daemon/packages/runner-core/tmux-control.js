'use strict';

// tmux control mode(`tmux -C attach`) 클라이언트 — 세션 하나에 **정확히 하나**만 붙는다.
//
// 왜 tty attach 가 아니라 control mode 인가(docs/terminal-v3-design.md §1-2): tty 클라이언트에게
//  tmux 는 "화면 재도장"을 보낸다(줄 단위 EL, attach 시 CSR+INDN, 리사이즈 재도장). 그걸 xterm 에
//  먹이면 스크롤백에 잔재가 쌓이고 alt-screen(1049)도 숨겨진다. control mode 는 pane 의 **원시 PTY
//  바이트**를 `%output` 으로 준다 — 실측(3.7b, 2026-09-05): DECSET 1049/1000/1006 그대로 통과, UTF-8
//  원시 바이트, 제어문자만 8진 이스케이프(`\033`, `\015\012`). 크기는 이 클라이언트가 `resize-window`
//  로 못 박는다(→ resize() 주석) — 다른 클라가 몇이 붙든 소유자 격자가 이긴다. lease·nudge 가 전부
//  필요 없어지는 이유.
//
// 프레임: `%begin ts num flags` … `%end|%error ts num flags` 가 명령 응답을 감싼다(순차 처리).
//  통지: `%output %<pane> <data>` · `%layout-change @win <layout> …` · `%exit` · `%sessions-changed` 등.
const { spawn } = require('child_process');
const EventEmitter = require('events');

const MAX_INPUT_CHUNK = 1024; // send-keys -H 한 명령에 싣는 바이트 상한(명령 줄 길이 보호)

/** `%output` 데이터의 8진 이스케이프를 원시 바이트로. 나머지 바이트는 그대로(UTF-8 은 이스케이프 안 됨). */
function unescapeOutput(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x5c /* \ */ && i + 1 < buf.length) {
      const a = buf[i + 1], b = buf[i + 2], d = buf[i + 3];
      if (i + 3 < buf.length && a >= 0x30 && a <= 0x37 && b >= 0x30 && b <= 0x37 && d >= 0x30 && d <= 0x37) {
        out[o++] = ((a - 0x30) << 6) | ((b - 0x30) << 3) | (d - 0x30);
        i += 3;
        continue;
      }
      if (a === 0x5c) { out[o++] = 0x5c; i += 1; continue; }
    }
    out[o++] = c;
  }
  return out.subarray(0, o);
}

class TmuxControl extends EventEmitter {
  /**
   * @param {object} o { tmux: 바이너리 경로, socket: -L 이름, session: 세션명, env }
   */
  constructor(o) {
    super();
    this.tmux = o.tmux;
    this.socket = o.socket;
    this.session = String(o.session);
    this.env = o.env || process.env;
    this.child = null;
    this.pending = [];      // 순차 명령 응답 대기열 [{resolve,reject,lines}]
    this.inBlock = null;    // %begin 안이면 현재 블록
    this.partial = Buffer.alloc(0);
    this.closed = false;
  }

  start() {
    const args = ['-L', this.socket, '-u', '-C', 'attach-session', '-t', '=' + this.session];
    this.child = spawn(this.tmux, args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this._feed(d));
    this.child.stderr.on('data', (d) => this.emit('stderr', String(d)));
    this.child.on('exit', (code, sig) => {
      this.closed = true;
      const err = new Error(`tmux control 종료(${code == null ? sig : code})`);
      for (const p of this.pending.splice(0)) p.reject(err);
      this.emit('exit', code == null ? -1 : code);
    });
    this.child.on('error', (e) => this.emit('error', e));
    return this;
  }

  _feed(data) {
    let buf = this.partial.length ? Buffer.concat([this.partial, data]) : data;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      this._line(buf.subarray(start, nl));
      start = nl + 1;
    }
    this.partial = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
  }

  _line(line) {
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line[0] !== 0x25 /* % */) {
      if (this.inBlock) this.inBlock.lines.push(line.toString('utf8'));
      return;
    }
    // `%output %N <data>` — 가장 빈번하므로 먼저, 바이트 단위로 처리(utf8 변환 금지).
    if (line.length > 8 && line.subarray(0, 8).equals(Buffer.from('%output '))) {
      const sp = line.indexOf(0x20, 8);
      if (sp > 0) this.emit('output', unescapeOutput(line.subarray(sp + 1)), line.subarray(8, sp).toString());
      return;
    }
    const text = line.toString('utf8');
    if (text.startsWith('%begin ')) { this.inBlock = { head: text, lines: [] }; return; }
    if (text.startsWith('%end ') || text.startsWith('%error ')) {
      const block = this.inBlock; this.inBlock = null;
      const p = this.pending.shift();
      if (p) {
        if (text.startsWith('%error ')) p.reject(new Error((block && block.lines.join('\n')) || 'tmux 명령 실패'));
        else p.resolve(block ? block.lines : []);
      }
      return;
    }
    if (text.startsWith('%layout-change ')) {
      // `%layout-change @0 a1dd,60x20,0,0,0 … *` — 두 번째 토큰 이후 layout 문자열에서 WxH 를 읽는다.
      const m = /,(\d+)x(\d+),/.exec(text);
      if (m) this.emit('layout', { cols: Number(m[1]), rows: Number(m[2]) });
      return;
    }
    if (text === '%exit' || text.startsWith('%exit ')) { this.emit('tmux-exit', text); return; }
    this.emit('notice', text);
  }

  /** 명령 한 줄을 보내고 `%end` 까지의 응답 줄들을 받는다. 순서 보장(tmux 가 순차 처리). */
  command(line) {
    if (this.closed || !this.child) return Promise.reject(new Error('tmux control 닫힘'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(line.replace(/\n/g, ' ') + '\n');
    });
  }

  /** 원시 바이트 입력 — `send-keys -H` (16진). 긴 붙여넣기는 명령 길이 보호를 위해 쪼갠다. */
  async input(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    for (let i = 0; i < b.length; i += MAX_INPUT_CHUNK) {
      const chunk = b.subarray(i, i + MAX_INPUT_CHUNK);
      const hex = chunk.toString('hex').match(/../g).join(' ');
      await this.command(`send-keys -t =${this.session}:0 -H ${hex}`);
    }
  }

  /**
   * 크기 — 소유자가 정한 격자를 window 에 **못 박는다**.
   *
   * ⚠ `refresh-client -C` 만으로는 부족하다(2026-09-06 실측). 그건 "이 클라이언트의 크기"를 바꿀 뿐이고
   *  window 크기는 window-size 정책이 유도한다. 그래서 ① 다른 클라이언트(구 v2 tty attach)가 하나라도
   *  붙어 있으면 latest 계산에 끼어들고, ② 그 클라가 `resize-window` 를 한 번이라도 부르면 window-size
   *  가 **manual 로 영구 고정**돼 이후 refresh-client -C 는 통째로 무시된다.
   *  실측(같은 세션): latest 에서 refresh -C 129x40 → 129x40 / v2 가 resize-window 90x24 → manual 90x24 /
   *  manual 에서 refresh -C 129x40 → **90x24 그대로** / resize-window 129x40 → 129x40.
   *
   *  `resize-window -x -y` 는 정책과 무관하게 정확히 그 크기로 고정한다 — "크기는 소유자 1명이 정한다"
   *  라는 v3 계약과 정확히 같은 의미다. refresh-client 도 같이 보내 컨트롤 클라이언트 자신의 크기를
   *  맞춰 둔다(안 맞으면 tmux 가 이 클라 기준으로 잘라 보내는 경로가 남는다).
   */
  async resize(cols, rows) {
    const w = cols | 0, h = rows | 0;
    await this.command(`refresh-client -C ${w}x${h}`);
    await this.command(`resize-window -t =${this.session}:0 -x ${w} -y ${h}`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin.write('detach\n'); } catch (_) { /* noop */ }
    setTimeout(() => { try { this.child.kill(); } catch (_) { /* noop */ } }, 300).unref();
  }
}

module.exports = { TmuxControl, unescapeOutput, MAX_INPUT_CHUNK };
