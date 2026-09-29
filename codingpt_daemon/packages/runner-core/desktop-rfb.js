'use strict';

/**
 * desktop-rfb — 에이전트 데스크톱(게스트 macOS VM)의 화면·입력을 **VNC(RFB 3.8)** 로 다루는 최소 클라이언트.
 *
 *  왜 VNC 인가: 게스트에 아무것도 설치하지 않고도 프레임버퍼와 마우스·키보드가 열린다(Lume 이 VM 마다
 *  VNC 서버를 띄운다). 게스트 안 helper 는 나중(자체 이미지)에 붙이고, 그때도 VNC 는 폴백으로 남는다.
 *
 *  범위: Raw 인코딩만 받는다(로컬 루프백이라 대역폭이 문제가 아니다) · VNC 인증(DES) · 포인터·키 이벤트 ·
 *  DesktopSize 의사 인코딩(해상도 변경 추적). 프레임버퍼는 BGRX 32bpp 로 들고 있다가 BMP 로 내보낸다.
 */
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

const ENC_RAW = 0;
const ENC_DESKTOP_SIZE = -223;

/** VNC 인증용 DES — 비밀번호 각 바이트를 비트 반전해 키로 쓴다(RFB 관례). Node 의 OpenSSL 3 에는 단일
 *  DES 가 없어 같은 키를 세 번 이어 붙인 3DES-ECB 로 대신한다(K|K|K 는 수학적으로 단일 DES 와 같다). */
function vncEncrypt(challenge, password) {
  const key = Buffer.alloc(8);
  const pw = Buffer.from(String(password || ''), 'latin1');
  for (let i = 0; i < 8; i++) {
    let b = i < pw.length ? pw[i] : 0;
    let r = 0;
    for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; }
    key[i] = r;
  }
  const c = crypto.createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(challenge), c.final()]);
}

/** X11 keysym 표 — RFB KeyEvent 가 쓰는 코드. 이름은 cpt/화면이 보내는 키 이름과 맞춘다. */
const KEYSYMS = {
  enter: 0xff0d, return: 0xff0d, backspace: 0xff08, tab: 0xff09, escape: 0xff1b, esc: 0xff1b,
  delete: 0xffff, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, space: 0x20,
  shift: 0xffe1, ctrl: 0xffe3, control: 0xffe3,
  //  ★ Apple 의 _VZVNCServer(Lume 이 쓰는 VNC 서버) 실측(2026-09-17): Alt_L(0xffe9) 이 **Command**, Meta_L(0xffe7) 이
  //   **Option** 으로 들어간다. Super_L(0xffeb)/Meta_L 을 Command 로 보내면 수식키가 무시되고 본 키만 찍힌다
  //   ("cmd+v" → 'v' 가 타이핑됨). Lume 자체 클라이언트(VNCService.swift)도 같은 표를 쓴다.
  cmd: 0xffe9, command: 0xffe9, super: 0xffe9, alt: 0xffe7, option: 0xffe7, meta: 0xffe7,
  f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2, f6: 0xffc3, f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,
};
const MODIFIERS = new Set(['shift', 'ctrl', 'control', 'alt', 'option', 'cmd', 'command', 'super', 'meta']);

function keysymOf(name) {
  const k = String(name || '');
  if (!k) return null;
  const low = k.toLowerCase();
  if (KEYSYMS[low] != null) return KEYSYMS[low];
  if (k.length === 1) return k.codePointAt(0);   // Latin-1/BMP 문자는 keysym == 코드포인트(0x100 이하) — 그 밖은 서버 재량
  return null;
}

class RfbClient extends EventEmitter {
  /** @param {{host?:string, port:number, password?:string, connectTimeoutMs?:number}} o */
  constructor(o) {
    super();
    this.host = o.host || '127.0.0.1';
    this.port = o.port | 0;
    this.password = o.password || '';
    this.connectTimeoutMs = o.connectTimeoutMs || 8000;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.width = 0; this.height = 0; this.name = '';
    this.fb = null;                 // BGRX
    this.ready = false;
    this.closed = false;
    this.pending = [];              // FramebufferUpdate 대기 resolve 들
    this.buttons = 0;
    this.px = 0; this.py = 0;
    this.dirty = false;
    this._state = 'version';
    this._need = 12;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      this.sock = s;
      const t = setTimeout(() => { reject(new Error('VNC 연결 시간 초과')); try { s.destroy(); } catch (_) { /* noop */ } }, this.connectTimeoutMs);
      this._resolveReady = () => { clearTimeout(t); resolve(this); };
      this._rejectReady = (e) => { clearTimeout(t); reject(e); };
      s.on('data', (d) => this._onData(d));
      s.on('error', (e) => { this._fail(e); });
      s.on('close', () => { this.closed = true; this.emit('close'); this._flushPending(new Error('VNC 연결이 닫혔어요')); });
      s.setNoDelay(true);
    });
  }

  close() { this.closed = true; try { this.sock && this.sock.destroy(); } catch (_) { /* noop */ } }

  _fail(e) {
    if (!this.ready && this._rejectReady) { const r = this._rejectReady; this._rejectReady = null; r(e); }
    //  듣는 이가 없는 'error' 는 EventEmitter 가 던진다 — connect() 의 reject 가 이미 전달한 뒤라 그럴 이유가 없다.
    if (this.listenerCount('error')) this.emit('error', e);
    this.close();
  }

  _flushPending(err) {
    const ps = this.pending; this.pending = [];
    for (const p of ps) (err ? p.reject(err) : p.resolve());
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    try {
      for (;;) {
        if (this.buf.length < this._need) return;
        const before = this._state;
        const consumed = this._step();
        if (consumed === 0 && this._state === before) return;   // 더 필요
        if (consumed > 0) this.buf = this.buf.subarray(consumed);
      }
    } catch (e) { this._fail(e); }
  }

  /** 상태기계 한 스텝. 소비한 바이트 수를 돌려주고, 부족하면 this._need 를 세팅하고 0 을 돌려준다. */
  _step() {
    const b = this.buf;
    switch (this._state) {
      case 'version': {
        const v = b.subarray(0, 12).toString('latin1');
        if (!/^RFB 00[0-9]\.00[0-9]\n$/.test(v)) throw new Error(`VNC 서버 인사가 낯설어요: ${JSON.stringify(v)}`);
        this.sock.write('RFB 003.008\n');
        this._state = 'sec-count'; this._need = 1;
        return 12;
      }
      case 'sec-count': {
        const n = b[0];
        if (n === 0) { this._state = 'sec-fail-reason'; this._need = 4; return 1; }
        if (b.length < 1 + n) { this._need = 1 + n; return 0; }
        const types = Array.from(b.subarray(1, 1 + n));
        const pick = types.includes(1) ? 1 : (types.includes(2) ? 2 : null);
        if (pick == null) throw new Error(`지원하는 VNC 인증이 없어요(${types.join(',')})`);
        this.sock.write(Buffer.from([pick]));
        if (pick === 2) { this._state = 'vnc-challenge'; this._need = 16; }
        else { this._state = 'sec-result'; this._need = 4; }
        return 1 + n;
      }
      case 'sec-fail-reason': {
        const len = b.readUInt32BE(0);
        if (b.length < 4 + len) { this._need = 4 + len; return 0; }
        throw new Error(`VNC 서버가 연결을 거절했어요: ${b.subarray(4, 4 + len).toString('utf8')}`);
      }
      case 'vnc-challenge': {
        this.sock.write(vncEncrypt(b.subarray(0, 16), this.password));
        this._state = 'sec-result'; this._need = 4;
        return 16;
      }
      case 'sec-result': {
        const r = b.readUInt32BE(0);
        if (r !== 0) { this._state = 'sec-fail-reason'; this._need = 4; return 4; }
        this.sock.write(Buffer.from([1]));          // ClientInit: shared
        this._state = 'server-init'; this._need = 24;
        return 4;
      }
      case 'server-init': {
        const nameLen = b.readUInt32BE(20);
        if (b.length < 24 + nameLen) { this._need = 24 + nameLen; return 0; }
        this.width = b.readUInt16BE(0); this.height = b.readUInt16BE(2);
        this.name = b.subarray(24, 24 + nameLen).toString('utf8');
        this.fb = Buffer.alloc(this.width * this.height * 4);
        this._setPixelFormat();
        this._setEncodings();
        this.ready = true;
        this._state = 'msg'; this._need = 1;
        if (this._resolveReady) { const r = this._resolveReady; this._resolveReady = null; r(); }
        this.emit('ready');
        return 24 + nameLen;
      }
      case 'msg': {
        const t = b[0];
        if (t === 0) { this._state = 'fbu-head'; this._need = 4; return 0; }
        if (t === 1) { this._state = 'colourmap'; this._need = 6; return 0; }
        if (t === 2) { return 1; }                                       // Bell
        if (t === 3) { this._state = 'cuttext'; this._need = 8; return 0; }
        throw new Error(`알 수 없는 VNC 서버 메시지 ${t}`);
      }
      case 'colourmap': {
        const n = b.readUInt16BE(4);
        if (b.length < 6 + n * 6) { this._need = 6 + n * 6; return 0; }
        this._state = 'msg'; this._need = 1;
        return 6 + n * 6;
      }
      case 'cuttext': {
        const len = b.readUInt32BE(4);
        if (b.length < 8 + len) { this._need = 8 + len; return 0; }
        this.emit('cuttext', b.subarray(8, 8 + len).toString('latin1'));
        this._state = 'msg'; this._need = 1;
        return 8 + len;
      }
      case 'fbu-head': {
        this._rects = b.readUInt16BE(2);
        this._state = this._rects ? 'rect-head' : 'msg';
        this._need = this._rects ? 12 : 1;
        if (!this._rects) this._updateDone();
        return 4;
      }
      case 'rect-head': {
        const x = b.readUInt16BE(0), y = b.readUInt16BE(2), w = b.readUInt16BE(4), h = b.readUInt16BE(6);
        const enc = b.readInt32BE(8);
        if (enc === ENC_DESKTOP_SIZE) {
          this._resize(w, h);
          return this._rectDone(12);
        }
        if (enc !== ENC_RAW) throw new Error(`요청하지 않은 VNC 인코딩 ${enc}`);
        const bytes = w * h * 4;
        if (b.length < 12 + bytes) { this._need = 12 + bytes; return 0; }
        this._blit(x, y, w, h, b.subarray(12, 12 + bytes));
        return this._rectDone(12 + bytes);
      }
      default:
        throw new Error(`상태기계 오류 ${this._state}`);
    }
  }

  _rectDone(consumed) {
    this._rects -= 1;
    if (this._rects > 0) { this._state = 'rect-head'; this._need = 12; }
    else { this._state = 'msg'; this._need = 1; this._updateDone(); }
    return consumed;
  }

  _updateDone() {
    this.dirty = true;
    this.emit('update');
    this._flushPending(null);
  }

  _resize(w, h) {
    if (w === this.width && h === this.height) return;
    const nfb = Buffer.alloc(w * h * 4);
    const cw = Math.min(w, this.width), ch = Math.min(h, this.height);
    for (let y = 0; y < ch; y++) this.fb.copy(nfb, y * w * 4, y * this.width * 4, y * this.width * 4 + cw * 4);
    this.width = w; this.height = h; this.fb = nfb;
    this.emit('resize', { width: w, height: h });
  }

  _blit(x, y, w, h, src) {
    if (x + w > this.width || y + h > this.height) return;   // 서버 오류 — 조용히 버린다
    const stride = this.width * 4, row = w * 4;
    for (let r = 0; r < h; r++) src.copy(this.fb, (y + r) * stride + x * 4, r * row, r * row + row);
  }

  _setPixelFormat() {
    // 32bpp · depth 24 · little-endian · true colour · R<<16 G<<8 B  → 메모리 [B,G,R,X] = BMP 32bpp 그대로
    const m = Buffer.alloc(20);
    m[0] = 0; m[4] = 32; m[5] = 24; m[6] = 0; m[7] = 1;
    m.writeUInt16BE(255, 8); m.writeUInt16BE(255, 10); m.writeUInt16BE(255, 12);
    m[14] = 16; m[15] = 8; m[16] = 0;
    this.sock.write(m);
  }

  _setEncodings() {
    const encs = [ENC_RAW, ENC_DESKTOP_SIZE];
    const m = Buffer.alloc(4 + encs.length * 4);
    m[0] = 2; m.writeUInt16BE(encs.length, 2);
    encs.forEach((e, i) => m.writeInt32BE(e, 4 + i * 4));
    this.sock.write(m);
  }

  /** 프레임 갱신을 요청하고 도착까지 기다린다. incremental=false 면 전체 화면을 다시 받는다. */
  requestUpdate(incremental = true, timeoutMs = 3000) {
    if (!this.ready || this.closed) return Promise.reject(new Error('VNC 가 준비되지 않았어요'));
    const m = Buffer.alloc(10);
    m[0] = 3; m[1] = incremental ? 1 : 0;
    m.writeUInt16BE(0, 2); m.writeUInt16BE(0, 4); m.writeUInt16BE(this.width, 6); m.writeUInt16BE(this.height, 8);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.pending.indexOf(p); if (i >= 0) this.pending.splice(i, 1);
        //  갱신이 없으면 서버가 응답을 미룰 수 있다(변화 없음) — 오류가 아니라 "그대로" 다.
        resolve(false);
      }, timeoutMs);
      const p = { resolve: () => { clearTimeout(t); resolve(true); }, reject: (e) => { clearTimeout(t); reject(e); } };
      this.pending.push(p);
      this.sock.write(m);
    });
  }

  /** 포인터 — 좌표는 픽셀. buttons 비트: 1=왼쪽 2=가운데 4=오른쪽 8/16=휠 위/아래 */
  pointer(x, y, buttons) {
    this.px = Math.max(0, Math.min(this.width - 1, x | 0));
    this.py = Math.max(0, Math.min(this.height - 1, y | 0));
    this.buttons = buttons & 0xff;
    const m = Buffer.alloc(6);
    m[0] = 5; m[1] = this.buttons; m.writeUInt16BE(this.px, 2); m.writeUInt16BE(this.py, 4);
    this.sock.write(m);
  }

  key(keysym, down) {
    const m = Buffer.alloc(8);
    m[0] = 4; m[1] = down ? 1 : 0; m.writeUInt32BE(keysym >>> 0, 4);
    this.sock.write(m);
  }

  /** "cmd+shift+a" 같은 조합. 수식키는 누른 채 본 키를 눌렀다 뗀 뒤 역순으로 뗀다. */
  async chord(spec, holdMs = 30) {
    const parts = String(spec || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('키 이름이 비었어요');
    const mods = parts.filter((p) => MODIFIERS.has(p.toLowerCase()));
    const mains = parts.filter((p) => !MODIFIERS.has(p.toLowerCase()));
    const modSyms = mods.map((m) => keysymOf(m));
    const mainSyms = mains.map((k) => { const s = keysymOf(k); if (s == null) throw new Error(`모르는 키 이름이에요: ${k}`); return s; });
    for (const s of modSyms) this.key(s, true);
    for (const s of mainSyms) { this.key(s, true); await sleep(holdMs); this.key(s, false); }
    for (const s of modSyms.reverse()) this.key(s, false);
  }

  /** 문자열 타이핑 — keysym 으로 한 글자씩. 라틴 밖(한글 등)은 서버가 받아 줄지 보장이 없어 호출자가
   *  클립보드 경로(pbcopy + cmd+v)로 우회한다. */
  async typeAscii(text, perKeyMs = 12) {
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (ch === '\n') { await this.chord('enter'); continue; }
      if (cp > 0xff) throw new Error('라틴 밖 문자는 keysym 으로 칠 수 없어요');
      const upper = /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch);
      if (upper) this.key(KEYSYMS.shift, true);
      this.key(cp, true); await sleep(perKeyMs); this.key(cp, false);
      if (upper) this.key(KEYSYMS.shift, false);
    }
  }

  clientCutText(text) {
    const b = Buffer.from(String(text || ''), 'latin1');
    const m = Buffer.alloc(8 + b.length);
    m[0] = 6; m.writeUInt32BE(b.length, 4); b.copy(m, 8);
    this.sock.write(m);
  }

  /**
   * 현재 프레임버퍼를 24bpp BMP(bottom-up) 로 — sips 가 받아 주는 형태다(emulator.rawToBmp 와 같은 규칙).
   *  ★ 32bpp·top-down(음수 높이) BMP 는 sips 가 **검은 그림**을 돌려준다(2026-09-17 실측) — 그래서 24bpp.
   *  maxWidth 를 주면 박스 평균으로 줄인다(최근접은 계단 노이즈로 JPEG 가 4배 커진다 — emulator.js 실측).
   */
  toBmp(maxWidth) {
    const w = this.width, h = this.height, fb = this.fb;
    const cap = Math.max(120, Math.min(4000, maxWidth || w));
    const scale = w > cap ? cap / w : 1;
    const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
    const rowBytes = (ow * 3 + 3) & ~3;
    const pix = rowBytes * oh;
    const out = Buffer.alloc(54 + pix);
    out.write('BM', 0, 'latin1');
    out.writeUInt32LE(54 + pix, 2); out.writeUInt32LE(54, 10); out.writeUInt32LE(40, 14);
    out.writeInt32LE(ow, 18); out.writeInt32LE(oh, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(pix, 34);
    const bx = Math.max(1, Math.floor(w / ow)), by = Math.max(1, Math.floor(h / oh)), area = bx * by;
    for (let y = 0; y < oh; y++) {
      const sy0 = Math.min(h - by, Math.floor(y / scale));
      const dst = 54 + (oh - 1 - y) * rowBytes;
      for (let x = 0; x < ow; x++) {
        const sx0 = Math.min(w - bx, Math.floor(x / scale));
        let b = 0, g = 0, r = 0;
        for (let dy = 0; dy < by; dy++) {
          let si = ((sy0 + dy) * w + sx0) * 4;
          for (let dx = 0; dx < bx; dx++) { b += fb[si]; g += fb[si + 1]; r += fb[si + 2]; si += 4; }   // BGRX
        }
        const di = dst + x * 3;
        out[di] = (b / area) | 0; out[di + 1] = (g / area) | 0; out[di + 2] = (r / area) | 0;
      }
    }
    return { buf: out, width: ow, height: oh };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { RfbClient, vncEncrypt, keysymOf, KEYSYMS };
