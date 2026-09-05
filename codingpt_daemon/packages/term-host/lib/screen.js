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

// tmux.conf 의 history-limit 과 **같아야** 한다. canonical VT 가 tmux history 를 대체한 뒤로는
//  이 값이 곧 "모바일에서 거슬러 올라갈 수 있는 과거"의 길이다. 2000 이던 시절엔 tmux 는 10000 을
//  들고 있는데 서버 VT 만 5분의 1이라 위로 스크롤이 중간에서 끊겼다.
const SCROLLBACK = Math.max(200, Number(process.env.CPT_TERM_SCROLLBACK) || 10000);

// ── 한 행 → SGR 포함 문자열 ────────────────────────────────────────────────
//  SerializeAddon 은 버퍼 전체만 직렬화해서 offset 페이지에 쓸 수 없다. history 는 페이지 단위로
//  나가므로 행 하나를 독립적으로 재생 가능한 문자열(항상 자기 SGR 을 켜고 \x1b[0m 으로 닫음)로 만든다.
const SGR_CACHE_MISS = Symbol('miss');

function colorCodes(cell, isFg) {
  const dflt = isFg ? cell.isFgDefault() : cell.isBgDefault();
  if (dflt) return null;
  const base = isFg ? 38 : 48;
  const color = isFg ? cell.getFgColor() : cell.getBgColor();
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
    return [base, 2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
  }
  return [base, 5, color & 0xff];
}

function cellSgr(cell) {
  const codes = [];
  if (cell.isBold()) codes.push(1);
  if (cell.isDim()) codes.push(2);
  if (cell.isItalic()) codes.push(3);
  if (cell.isUnderline()) codes.push(4);
  if (cell.isBlink()) codes.push(5);
  if (cell.isInverse()) codes.push(7);
  if (cell.isInvisible()) codes.push(8);
  if (cell.isStrikethrough()) codes.push(9);
  const fg = colorCodes(cell, true);
  if (fg) codes.push(...fg);
  const bg = colorCodes(cell, false);
  if (bg) codes.push(...bg);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

function serializeLine(line, cols) {
  const width = Math.max(0, Math.min(line.length | 0, cols | 0 || line.length | 0));
  // 끝의 "기본 속성 공백"은 버린다(배경색이 칠해진 공백은 의미가 있으므로 남긴다).
  let last = -1;
  const cell = line.getCell(0);
  if (!cell) return '';
  for (let x = 0; x < width; x++) {
    if (!line.getCell(x, cell)) continue;
    const chars = cell.getChars();
    if ((chars && chars !== ' ') || !cell.isBgDefault() || cell.isUnderline() || cell.isStrikethrough()) last = x;
  }
  if (last < 0) return '';
  let out = '';
  let sgr = SGR_CACHE_MISS;
  for (let x = 0; x <= last; x++) {
    if (!line.getCell(x, cell)) continue;
    if (cell.getWidth() === 0) continue; // 와이드 문자의 뒤쪽 반 칸
    const next = cellSgr(cell);
    if (next !== sgr) { out += next || (sgr === SGR_CACHE_MISS ? '' : '\x1b[0m'); sgr = next; }
    out += cell.getChars() || ' ';
  }
  return sgr ? `${out}\x1b[0m` : out;
}

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
    this.onData = null; // DA/DSR/CPR 등 VT가 생성한 응답 → 소유 PTY 입력으로 반환
    this.term.onBell(() => { if (this.onBell) { try { this.onBell(); } catch (_) { /* noop */ } } });
    this.term.onData((data) => { if (this.onData) { try { this.onData(data); } catch (_) { /* noop */ } } });
  }

  write(data) {
    // string(node-pty onData 는 이미 utf8 디코드됨)은 그대로, Buffer 는 **바이트 그대로** 넘긴다.
    //  xterm 은 Uint8Array 입력에 대해 UTF-8 디코더 상태를 유지하므로, 한 글자가 두 청크에
    //  걸려 와도(control mode %output 은 임의 경계로 쪼개진다) 깨지지 않는다. toString('utf8')
    //  으로 청크마다 디코드하면 경계의 다중바이트가 U+FFFD 로 굳는다.
    this.term.write(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
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
  // 스크롤 라우팅의 정본. 클라이언트가 DECSET 을 스스로 엿보며 추측하면 프레임 경계·모드 지연으로
  //  Codex 휠을 일반 스크롤로 오판한다. 서버 VT 가 실제로 적용한 값만 신뢰한다.
  get mouseTracking() {
    try { return !!this.term.modes.mouseTrackingMode && this.term.modes.mouseTrackingMode !== 'none'; } catch (_) { return false; }
  }
  get altScreen() {
    try { return this.term.buffer.active.type === 'alternate'; } catch (_) { return false; }
  }

  cursor() {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  // 서버 canonical scrollback 페이지. 현재 viewport는 제외하고 절대 행 offset으로 읽는다.
  // 클라이언트 화면 높이/resize와 무관한 정본이라 기기마다 baseY를 재구성하지 않아도 된다.
  //  · text — 평문(검색·로그용)
  //  · ansi — SGR 보존(뷰어가 라이브 화면과 같은 색으로 그린다). 평문만 주면 과거를 볼 때만
  //    화면이 단색이 되어 "여기부터는 다른 화면"처럼 보인다.
  historyPage(o = {}) {
    const b = this.term.buffer.active;
    const total = Math.max(0, b.baseY | 0);
    const end = o.before == null ? total : Math.max(0, Math.min(total, o.before | 0));
    const limit = Math.max(1, Math.min(500, o.limit | 0 || 200));
    const start = Math.max(0, end - limit);
    const rows = [];
    for (let y = start; y < end; y++) {
      const line = b.getLine(y);
      rows.push({
        offset: y,
        text: line ? line.translateToString(false) : '',
        ansi: line ? serializeLine(line, this.term.cols) : '',
        wrapped: !!(line && line.isWrapped),
      });
    }
    return { start, end, total, hasMore: start > 0, rows };
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
