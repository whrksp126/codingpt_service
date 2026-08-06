/**
 * serve-sim 세션 — **iOS 시뮬레이터의 라이브 화면과 조작**.
 *
 * 왜 idb 가 아닌가(2026-08-06 조사, Orca 소스 대조):
 *  · `simctl` 에는 입력 주입이 아예 없다. `idb` 는 되지만 **탭 한 번마다 파이썬 CLI 를 띄우고**
 *    companion 을 붙잡아 왕복이 수백 ms 다. 화면은 별도로 `simctl io screenshot` 을 폴링해야 했다.
 *  · `serve-sim`(npm, Apache-2.0)은 Swift 헬퍼가 시뮬레이터 프레임버퍼를 직접 잡아
 *    **H.264 스트림 + 상시 열린 WebSocket HID 채널**로 연다. Orca 가 쓰는 것과 같은 물건이다.
 *
 *  실측(iPhone 16 Pro, 이 Mac): MJPEG 40.8fps/1206x2622 였고 H.264 는 격한 스크롤 중 379KB/s —
 *  우리 안드로이드(scrcpy) 스트림과 같은 급이라 릴레이·LAN·WebRTC 어디로도 보낼 수 있다.
 *
 * ★ 이 클래스는 `ScrcpySession` 과 **같은 인터페이스**를 흉내 낸다(start/meta/configPacket/
 *  onFrame/close). emulator-stream.js 의 뷰어·GOP·배압 배관을 한 줄도 바꾸지 않고 쓰기 위해서다.
 *  화면 코드가 안드로이드용과 iOS용으로 갈라지면 반드시 한쪽만 고쳐진다.
 *
 * 와이어(실측으로 확정):
 *   HTTP `/stream.avcc` = [길이 4바이트 BE][태그 1바이트][페이로드] 의 반복.
 *     태그 1 = avcC 설명(SPS/PPS 레코드) · 2 = 키프레임 · 3 = 델타 · 4 = JPEG 스냅샷
 *     페이로드는 **AVCC**(NAL 앞에 길이)다. 우리 화면 디코더는 Annex-B 를 기대하므로
 *     (scrcpy 가 그렇게 준다) 여기서 시작코드로 바꿔 준다 — 클라이언트는 수정이 필요 없다.
 *   WS `/ws` = [태그 1바이트][JSON]. 3=touch 4=button 6=key 7=rotate 11=scroll.
 *     **좌표가 0~1 정규화**라 우리 프로토콜과 그대로 같다(포인트/픽셀 환산이 없다).
 *     서버→클라 태그 130 = {width,height,orientation}.
 */
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

/** 프레임 하나의 상한 — 어긋난 스트림을 무한히 모으지 않는다. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
/** 헬퍼가 포트를 열 때까지 기다리는 시간. 첫 기동은 Swift 헬퍼 로딩까지 포함한다. */
const READY_TIMEOUT_MS = 25000;

// ── 실행 파일 찾기 ───────────────────────────────────────────────────────────
//  PC 앱이 번들한 사이드카에서는 데몬 옆 node_modules 에 들어 있다. 개발 중에는 workspaces 루트.
let entryCache;
function serveSimEntry() {
  if (entryCache !== undefined) return entryCache;
  entryCache = null;
  //  ★ `require.resolve('serve-sim/dist/serve-sim.js')` 는 못 쓴다 — 이 패키지의 `exports` 맵에
  //   그 경로가 없어서 Node 가 ERR_PACKAGE_PATH_NOT_EXPORTED 로 막는다. 대신 **공개된**
  //   `serve-sim/middleware` 를 풀어 dist 디렉터리를 알아낸다(같은 폴더에 CLI 가 있다).
  try {
    entryCache = path.join(path.dirname(require.resolve('serve-sim/middleware')), 'serve-sim.js');
    if (!fs.existsSync(entryCache)) entryCache = null;
  } catch (_) { entryCache = null; }
  if (!entryCache) {
    //  사이드카 복사본 등 해석이 안 되는 배치를 위한 마지막 후보들.
    for (const c of [
      path.join(__dirname, '..', '..', 'node_modules', 'serve-sim', 'dist', 'serve-sim.js'),
      path.join(__dirname, 'node_modules', 'serve-sim', 'dist', 'serve-sim.js'),
    ]) {
      try { if (fs.existsSync(c)) { entryCache = c; break; } } catch (_) { /* noop */ }
    }
  }
  return entryCache;
}

/** 이 기계에서 쓸 수 있는가 — macOS arm64 + 패키지가 있어야 한다(네이티브 헬퍼가 arm64 전용). */
function available() {
  return process.platform === 'darwin' && process.arch === 'arm64' && !!serveSimEntry();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ── H.264 포맷 변환 ──────────────────────────────────────────────────────────

const START_CODE = Buffer.from([0, 0, 0, 1]);

/**
 * avcC 레코드 → Annex-B SPS/PPS.
 *  레이아웃: [0]=1 · [1..3] 프로파일 · [4]=0xFC|(길이바이트-1) · [5]=0xE0|SPS개수 ·
 *            (u16 길이 + SPS)* · PPS개수 1바이트 · (u16 길이 + PPS)*
 * @returns {{ data: Buffer, lengthSize: number }|null}
 */
function avccConfigToAnnexB(rec) {
  if (!rec || rec.length < 7 || rec[0] !== 1) return null;
  const lengthSize = (rec[4] & 0x03) + 1;
  const parts = [];
  let off = 5;
  const readSet = (count) => {
    for (let i = 0; i < count; i++) {
      if (off + 2 > rec.length) return false;
      const len = rec.readUInt16BE(off);
      off += 2;
      if (off + len > rec.length) return false;
      parts.push(START_CODE, rec.subarray(off, off + len));
      off += len;
    }
    return true;
  };
  if (!readSet(rec[off++] & 0x1f)) return null;      // SPS
  if (off >= rec.length) return null;
  if (!readSet(rec[off++])) return null;             // PPS
  if (!parts.length) return null;
  return { data: Buffer.concat(parts), lengthSize };
}

/**
 * AVCC(길이 접두) NAL 들 → Annex-B(시작코드).
 *  길이가 어긋나면 null 을 돌려준다 — 억지로 이어 붙이면 디코더가 조용히 깨진 화면을 그린다.
 */
function avccToAnnexB(buf, lengthSize) {
  const ls = lengthSize || 4;
  const parts = [];
  let off = 0;
  while (off + ls <= buf.length) {
    let len = 0;
    for (let i = 0; i < ls; i++) len = (len << 8) | buf[off + i];
    off += ls;
    if (len < 0 || off + len > buf.length) return null;
    parts.push(START_CODE, buf.subarray(off, off + len));
    off += len;
  }
  return off === buf.length ? Buffer.concat(parts) : null;
}

/**
 * `[길이4][태그1][페이로드]` 스트림에서 완성된 것만 꺼낸다.
 *  TCP 는 우리가 쓴 경계를 지켜 주지 않는다 — 조립은 여기 한 곳에서만 한다(scrcpy 쪽과 같은 규율).
 */
function parseEnvelopes(pending, chunk) {
  const buf = pending && pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const out = [];
  let off = 0;
  while (buf.length - off >= 5) {
    const len = buf.readUInt32BE(off);
    if (len < 1 || len > MAX_FRAME_BYTES) {
      throw new Error(`serve-sim 프레임 크기 ${len} 가 상한을 넘었어요 — 스트림이 어긋났습니다`);
    }
    if (buf.length - off - 4 < len) break;
    out.push({ tag: buf[off + 4], payload: Buffer.from(buf.subarray(off + 5, off + 4 + len)) });
    off += 4 + len;
  }
  return { items: out, pending: off > 0 ? Buffer.from(buf.subarray(off)) : buf };
}

const TAG = { CONFIG: 1, KEY: 2, DELTA: 3, JPEG: 4 };
/** WS 로 보내는 메시지 태그(serve-sim 의 HID 프로토콜). */
const WS_TAG = { TOUCH: 3, BUTTON: 4, KEY: 6, ROTATE: 7, SCROLL: 11 };

// ── 세션 ─────────────────────────────────────────────────────────────────────

class ServeSimSession {
  /**
   * @param {{ udid: string }} opts
   * @param {{ onMeta, onFrame, onError, onClose }} cb
   */
  constructor(opts, cb) {
    this.opts = opts;
    this.cb = cb || {};
    this.child = null;
    this.port = 0;
    this.baseUrl = '';
    this.req = null;
    this.ws = null;
    this.pending = Buffer.alloc(0);
    this.lengthSize = 4;
    this.meta = null;
    this.closed = false;
    /** 새로 붙는 화면에게 즉시 보내 줄 SPS/PPS — 없으면 다음 키프레임까지 검은 화면이다. */
    this.configPacket = null;
    /** 헬퍼가 알려 준 화면 크기·방향(WS 태그 130). 좌표는 정규화라 표시용이다. */
    this.orientation = 'portrait';
    /**
     * 그 방향을 **믿어도 되는가**.
     *
     * ★ serve-sim 헬퍼는 새로 뜰 때 무조건 'portrait' 로 시작한다 — 기기에 지금 방향을 묻지 않는다.
     *  그래서 이미 눕혀 놓은 기기에 새로 붙으면 "세로" 라고 **틀리게** 말한다(실측). 화면이 그 말을
     *  믿고 그리면 눕힌 채로 보인다. 우리가 직접 돌렸을 때만 참으로 친다.
     *  (접근성 트리로 가로/세로는 알 수 있지만 **좌/우 어느 쪽인지는 알 수 없다** — 반만 아는 값으로
     *   찍으면 절반은 위아래가 뒤집힌다. 모르면 모른다고 두는 편이 낫다.)
     */
    this.orientationKnown = false;
  }

  static async start(opts, cb) {
    const s = new ServeSimSession(opts, cb);
    try {
      await s._spawn();
      await s._waitReady();
      s._openStream();
      await s._openControl();
      //  ★ 크기를 모르는 채로 돌려주면 안 된다. 화면은 이 값으로 캔버스를 잡고 좌표를 환산한다 —
      //   0 을 받으면 첫 프레임이 올 때까지 아무것도 못 그린다(실측: streamStart 가 0x0 을 반환).
      await s._waitMeta();
      await s._syncOrientation();
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }

  async _spawn() {
    const entry = serveSimEntry();
    if (!entry) throw new Error('serve-sim 을 찾을 수 없어요 — PC 앱을 업데이트해 주세요');
    await reapStrays(entry, this.opts.udid);
    this.port = await freePort();
    this.baseUrl = `http://127.0.0.1:${this.port}/helper/${this.opts.udid}`;
    //  ★ `--detach` 를 쓰지 않는다. 그러면 헬퍼가 우리 손을 떠나고, 같은 기계의 다른 앱(예: Orca)이
    //   띄워 둔 **구버전 서버에 얹혀 붙는 일**이 생긴다(조사 중 실제로 겪었다 — 터치가 조용히 무시됐다).
    //   우리가 고른 포트로 우리 자식으로 띄우면 버전도 수명도 우리가 안다.
    this.child = cp.spawn(process.execPath, [entry, '--no-preview', '-q', '--port', String(this.port), this.opts.udid], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child.stdout.on('data', () => { /* 준비 판정은 HTTP 로 한다 — 형식에 기대지 않는다 */ });
    let errTail = '';
    this.child.stderr.on('data', (d) => { errTail = (errTail + String(d)).slice(-800); });
    this.child.on('exit', (code) => {
      if (this.closed) return;
      this._fail(`serve-sim 이 종료됐어요(코드 ${code})${errTail ? ` — ${errTail.trim().split('\n').pop()}` : ''}`);
    });
    this.child.on('error', (e) => this._fail((e && e.message) || String(e)));
  }

  /** 포트가 열리고 기기를 받아들일 때까지 기다린다(첫 기동은 Swift 헬퍼 로딩이 있다). */
  async _waitReady() {
    const until = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (this.closed) throw new Error('닫혔어요');
      const ok = await this._probeConfig();
      if (ok) return;
      if (Date.now() > until) throw new Error('serve-sim 이 응답하지 않아요');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  _probeConfig() {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/config`, { timeout: 2000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(false); return; }
          try {
            const j = JSON.parse(body);
            //  크기는 첫 프레임이 나와야 채워진다 — 200 이면 "받을 준비가 됐다" 로 본다.
            if (j && typeof j.orientation === 'string') { resolve(true); return; }
          } catch (_) { /* noop */ }
          resolve(false);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch (_) { /* noop */ } resolve(false); });
    });
  }

  /**
   * 화면 크기가 정해질 때까지 기다린다.
   *  헬퍼는 **구독자가 붙어야** 캡처를 시작하므로(그전 `/config` 는 0x0 이다) 스트림을 연 뒤에 부른다.
   *  못 얻어도 세션은 살린다 — 크기는 첫 config 프레임에서 곧 채워진다.
   */
  async _waitMeta(timeoutMs = 6000) {
    const until = Date.now() + timeoutMs;
    while (!this.meta && !this.closed && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.meta || this.closed) return;
    const j = await this._fetchJson(`${this.baseUrl}/config`).catch(() => null);
    if (j && j.width > 0 && j.height > 0) {
      this.meta = { codec: 'h264', width: j.width, height: j.height };
      try { this.cb.onMeta?.(this.meta); } catch (_) { /* noop */ }
    }
  }

  /**
   * 헬퍼가 말하는 방향을 **기기의 진짜 방향과 맞춘다.**
   *
   * ★ 왜(2026-08-06 실측): 새로 뜬 serve-sim 헬퍼는 기기에 방향을 묻지 않고 무조건 'portrait' 로
   *  시작한다. 이미 눕혀 둔 기기에 붙으면 헬퍼도 우리도 "세로" 라고 믿는데 화면은 누워 있고,
   *  그 상태에서 회전 버튼을 누르면 **180도 어긋난 그림**이 나온다(위아래가 뒤집힌다 — 실제로 봤다).
   *
   * 접근성 트리는 진짜를 안다(눕혀 두면 874x402 로 보고한다). 다만 **좌/우 어느 쪽인지는 모른다** —
   *  그래서 누워 있으면 세로로 한 번 세워 **양쪽이 아는 상태**로 맞춘다. 기기 상태를 건드리는
   *  일이지만, 대안은 "화면이 뒤집혀 보이는데 이유를 알 수 없는" 것이라 이쪽이 낫다.
   */
  async _syncOrientation() {
    let landscape = false;
    try {
      const raw = await this.axJson();
      const roots = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const f = roots[0] && roots[0].frame;
      if (!f || !(f.width > 0) || !(f.height > 0)) return;   // 못 읽으면 아무것도 단정하지 않는다
      landscape = f.width > f.height;
    } catch (_) { return; }
    if (this.closed) return;
    if (landscape) this.rotate('portrait');       // rotate 가 orientationKnown 을 세운다
    else { this.orientation = 'portrait'; this.orientationKnown = true; }
  }

  /** 접근성 트리(원본 JSON) — 화면을 "글자"로 읽는 유일한 길이다. */
  axJson() { return this._fetchJson(`${this.baseUrl}/ax`, 8000); }

  _fetchJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs || 2000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(); } catch (_) { /* noop */ } reject(new Error('timeout')); });
    });
  }

  _openStream() {
    this.req = http.get(`${this.baseUrl}/stream.avcc`, (res) => {
      if (res.statusCode !== 200) { this._fail(`영상 스트림이 열리지 않았어요(HTTP ${res.statusCode})`); return; }
      res.on('data', (chunk) => this._onChunk(chunk));
      res.on('end', () => { if (!this.closed) this._fail('영상 스트림이 끊겼어요'); });
      res.on('error', (e) => { if (!this.closed) this._fail((e && e.message) || String(e)); });
    });
    this.req.on('error', (e) => { if (!this.closed) this._fail((e && e.message) || String(e)); });
  }

  _onChunk(chunk) {
    let out;
    try { out = parseEnvelopes(this.pending, chunk); }
    catch (e) { this._fail(e.message); return; }
    this.pending = out.pending;
    for (const it of out.items) {
      if (it.tag === TAG.JPEG) continue;              // 초기 스냅샷 — H.264 경로에는 필요 없다
      if (it.tag === TAG.CONFIG) {
        const c = avccConfigToAnnexB(it.payload);
        if (!c) continue;                             // 알아볼 수 없는 설명은 버린다(다음 것을 기다린다)
        this.lengthSize = c.lengthSize;
        this.configPacket = c.data;
        this._emit({ config: true, keyFrame: false, data: c.data });
        continue;
      }
      const annexb = avccToAnnexB(it.payload, this.lengthSize);
      if (!annexb) continue;                          // 길이가 어긋난 프레임 — 그리면 화면이 깨진다
      this._emit({ config: false, keyFrame: it.tag === TAG.KEY, data: annexb });
    }
  }

  _emit(frame) {
    try { this.cb.onFrame?.(frame); } catch (e) { console.warn(`[serve-sim] 프레임 처리 실패: ${(e && e.message) || e}`); }
  }

  /** HID 채널 — 조작은 전부 여기로 간다(프로세스를 새로 띄우지 않는다). */
  _openControl() {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}/helper/${this.opts.udid}/ws`;
      const ws = new WebSocket(url);
      ws.binaryType = 'nodebuffer';
      const onFail = (e) => reject(new Error(`조작 채널을 열지 못했어요: ${(e && e.message) || e}`));
      ws.once('error', onFail);
      ws.on('open', () => {
        ws.off('error', onFail);
        try { ws._socket?.setNoDelay(true); } catch (_) { /* noop */ }
        this.ws = ws;
        ws.on('error', () => { /* 끊김은 close 에서 다룬다 */ });
        ws.on('close', () => { if (this.ws === ws) this.ws = null; });
        ws.on('message', (m) => this._onControlMessage(Buffer.isBuffer(m) ? m : Buffer.from(m)));
        resolve();
      });
    });
  }

  _onControlMessage(buf) {
    if (!buf.length || buf[0] !== 130) return;        // 130 = 화면 설정(크기·방향)
    let j = null;
    try { j = JSON.parse(buf.subarray(1).toString('utf8')); } catch (_) { return; }
    if (!j || !(j.width > 0) || !(j.height > 0)) return;
    this.orientation = String(j.orientation || 'portrait');
    const meta = { codec: 'h264', width: j.width, height: j.height };
    const first = !this.meta;
    this.meta = meta;
    if (first) { try { this.cb.onMeta?.(meta); } catch (_) { /* noop */ } }
  }

  _sendControl(tag, obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(obj))]));
      return true;
    } catch (_) { return false; }
  }

  /** @param {'begin'|'move'|'end'} type  좌표는 0~1 정규화 그대로 보낸다. */
  touch(type, x, y) { return this._sendControl(WS_TAG.TOUCH, { type, x: clamp01(x), y: clamp01(y) }); }

  /**
   * 하드웨어 버튼.
   *
   * ★ 이름은 **소문자**다(실측). 대문자 'HOME' 은 조용히 무시된다 — idb 가 대문자를 쓰기 때문에
   *  그대로 넘겼다가 "ok 인데 아무 일도 안 일어나는" 상태를 만들 뻔했다.
   * ★ 표에 있는 버튼은 HID page/usage 를 **같이** 보내야 한다(serve-sim CLI 와 같은 규칙).
   *  이름만 보내면 네이티브가 무엇을 누를지 모른다.
   *
   * @param {string|{button:string,page?:number,usage?:number}} spec
   */
  button(spec) {
    const o = typeof spec === 'string' ? { button: spec } : spec;
    if (!o || !o.button) return false;
    return this._sendControl(WS_TAG.BUTTON, o);
  }
  rotate(orientation) {
    const ok = this._sendControl(WS_TAG.ROTATE, { orientation });
    if (ok) this.orientationKnown = true;      // 우리가 돌렸으니 이제 안다
    return ok;
  }

  _fail(msg) {
    if (this.closed) return;
    try { this.cb.onError?.(msg); } catch (_) { /* noop */ }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.req?.destroy(); } catch (_) { /* noop */ }
    try { this.ws?.close(); } catch (_) { /* noop */ }
    //  ★ `serve-sim --kill` 을 쓰지 않는다 — 그 명령은 상태 파일을 보고 **다른 기기의 서버까지**
    //   끊는다(실측). 우리 자식만 정확히 보낸다.
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch (_) { /* noop */ }
      //  정상적으로는 SIGTERM 뒤 ~1초에 스스로 끝난다(실측). 그보다 오래 버티면 캡처가 계속
      //  돌고 있다는 뜻이라 강제로 끊는다 — 조용히 CPU 를 먹는 유령을 남기지 않는다.
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }, 3000);
      if (typeof t.unref === 'function') t.unref();      // 이 타이머 때문에 프로세스가 안 끝나면 안 된다
    }
    try { this.cb.onClose?.(); } catch (_) { /* noop */ }
  }
}

/**
 * 지난번에 우리가 띄웠다가 **남은** 헬퍼를 정리한다.
 *
 * 왜: 데몬이 곱게 끝나면 close() 가 자식을 죽이지만, 강제 종료(SIGKILL·크래시)면 자식이 살아남아
 *  시뮬레이터를 계속 캡처한다(CPU 를 조용히 먹는다). 데몬은 SIGTERM 핸들러를 두지 않는다 —
 *  핸들러를 달면 기본 종료 동작이 대체돼서 데몬이 안 죽는 사고가 나기 때문이다. 그래서 대신
 *  **다음 기동 때** 치운다.
 *
 * ⚠ 조건이 **둘 다** 맞아야 죽인다: 우리 entry 경로 + 같은 udid. 그래야 같은 기계의 다른 앱
 *  (예: Orca 가 자기 런타임으로 띄운 serve-sim)을 절대 건드리지 않는다.
 */
/**
 * `ps -o pid=,command=` 한 줄을 보고 **죽여도 되는 유령인지** 판정한다.
 *  판정을 따로 떼어 둔 이유: 여기서 틀리면 남의 앱 프로세스를 죽인다 — 테스트로 못박아야 한다.
 * @returns {number|0} 죽일 pid, 아니면 0
 */
function strayPid(line, entry, udid, selfPid) {
  const m = /^\s*(\d+)\s+(.*)$/.exec(String(line || ''));
  if (!m) return 0;
  const pid = Number(m[1]);
  const cmd = m[2];
  if (!pid || pid === selfPid) return 0;
  //  ★ 우리 entry 경로와 같은 udid 가 **둘 다** 있어야 한다.
  if (!entry || !cmd.includes(entry)) return 0;
  if (!udid || !cmd.includes(udid)) return 0;
  return pid;
}

function reapStrays(entry, udid) {
  return new Promise((resolve) => {
    cp.execFile('/usr/bin/pgrep', ['-f', udid], { timeout: 3000 }, (err, out) => {
      if (err || !out) { resolve(); return; }
      const pids = String(out).split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      if (!pids.length) { resolve(); return; }
      cp.execFile('/bin/ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { timeout: 3000 }, (e2, out2) => {
        if (!e2 && out2) {
          for (const line of String(out2).split('\n')) {
            const pid = strayPid(line, entry, udid, process.pid);
            if (!pid) continue;
            try { process.kill(pid, 'SIGTERM'); } catch (_) { /* 이미 죽었다 */ }
          }
        }
        resolve();
      });
    });
  });
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

module.exports = {
  ServeSimSession, available, serveSimEntry,
  _avccConfigToAnnexB: avccConfigToAnnexB, _avccToAnnexB: avccToAnnexB,
  _parseEnvelopes: parseEnvelopes, _clamp01: clamp01, _strayPid: strayPid, TAG, WS_TAG,
};
