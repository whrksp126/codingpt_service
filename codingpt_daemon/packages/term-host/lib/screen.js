/**
 * 서버사이드 스크린 버퍼 — tmux 의 "pane 화면"을 @xterm/headless 로 재현한다(설계 계약 1).
 *
 * 존재 이유: capture-pane 등가(원격 승인/상태감지/TUI 조작의 기반)와 attach 시 전체 리페인트.
 *  · captureText  = `capture-pane -p [-J] [-S -N]` — 순수 텍스트 스크랩(다이얼로그 판정 등).
 *  · captureEscapes = `capture-pane -e -p [-S -N]` — SGR 포함(@xterm/addon-serialize).
 *  · serializeRepaint = attach 직후 새 뷰어에 현재 화면 전체를 다시 그리는 프레임
 *    (tmux attach 의 전체 리페인트 등가 — 모드(DECSET)까지 복원해 TUI 상태 일관).
 *
 * ⚠ xterm 의 write 는 비동기다 — capture 류는 반드시 flush() 후에 읽는다(안 그러면 방금 send-keys
 *   한 결과가 화면에 아직 없어 "51ms 만에 그려지는" TUI 다이얼로그 판정이 한 박자 늦는다).
 */
'use strict';
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SCROLLBACK = 2000; // tmux.conf history-limit 등가(과도한 메모리 방지)

class Screen {
  constructor(cols, rows) {
    this.term = new Terminal({
      cols: Math.max(2, cols | 0 || 80),
      rows: Math.max(2, rows | 0 || 24),
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.title = '';
    this.term.onTitleChange((t) => { this.title = String(t || ''); });
    this.onBell = null; // 세션이 걸어 attach 전원에게 {t:'bell'} 브로드캐스트
    this.term.onBell(() => { if (this.onBell) { try { this.onBell(); } catch (_) { /* noop */ } } });
  }

  write(data) {
    // node-pty onData 는 utf8 디코드된 string — 그대로 흘린다(바이트 재해석 금지).
    this.term.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  // 펜딩 write 전부 반영 후 resolve — 빈 write 의 콜백은 큐 말미에 실행된다.
  flush() {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  resize(cols, rows) {
    this.term.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
  }

  reset() {
    this.term.reset();
  }

  get cols() { return this.term.cols; }
  get rows() { return this.term.rows; }

  // DECCKM — send-keys 방향키 변형(SS3/CSI) 판정에 사용.
  get appCursor() {
    try { return !!this.term.modes.applicationCursorKeysMode; } catch (_) { return false; }
  }
  get bracketedPaste() {
    try { return !!this.term.modes.bracketedPasteMode; } catch (_) { return false; }
  }

  cursor() {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  /**
   * capture-pane -p 등가 — 보이는 화면(+lines 만큼 위 히스토리) 텍스트.
   * @param {object} o { lines?: number(위로 몇 줄 더 — `-S -N`), join?: boolean(`-J` 랩 병합) }
   */
  captureText(o = {}) {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;              // 보이는 영역 하단(exclusive)
    const start = Math.max(0, buf.baseY - (Math.max(0, o.lines | 0)));
    const rows = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      if (!line) { rows.push({ text: '', wrapped: false }); continue; }
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped });
    }
    if (!o.join) return rows.map((r) => r.text).join('\n');
    // -J: 이어진(wrapped) 줄을 논리 한 줄로 병합.
    const outLines = [];
    for (const r of rows) {
      if (r.wrapped && outLines.length) outLines[outLines.length - 1] += r.text;
      else outLines.push(r.text);
    }
    return outLines.join('\n');
  }

  /**
   * capture-pane -e -p 등가 — SGR 포함 화면(@xterm/addon-serialize).
   *  serialize 는 행을 \r\n 으로 잇는다 → 소비자(status-line 등)가 \n split 하므로 정규화한다.
   *  alt-screen TUI 활성 시 serialize 출력은 [일반 버퍼 + \x1b[?1049h + alt 내용] — 소비자는
   *  bottom-up 스캔/정규식이라 무해하지만, 필요하면 마지막 1049h 이후만 취해 화면만 남긴다.
   */
  captureEscapes(o = {}) {
    let s = '';
    try {
      s = this.serializer.serialize({ scrollback: Math.max(0, o.lines | 0), excludeModes: true });
    } catch (_) {
      return this.captureText(o); // serialize 실패 폴백 — 스크랩 자체는 살린다
    }
    const idx = s.lastIndexOf('\x1b[?1049h');
    if (idx >= 0) s = s.slice(idx + '\x1b[?1049h'.length);
    return s.replace(/\r\n/g, '\n');
  }

  // attach 리페인트 — 전체 리셋(RIS) 후 모드 포함 직렬화 + 커서 복원.
  serializeRepaint() {
    let body = '';
    try { body = this.serializer.serialize(); } catch (_) { body = ''; }
    const c = this.cursor();
    return '\x1bc' + body + `\x1b[${c.y + 1};${c.x + 1}H`;
  }

  dispose() {
    try { this.term.dispose(); } catch (_) { /* noop */ }
  }
}

module.exports = { Screen };
