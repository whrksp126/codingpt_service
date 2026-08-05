/**
 * scrcpy 세션 — jar 준비 → push → adb forward → 서버 기동 → 소켓 두 개(영상/컨트롤).
 *  바이트 계약은 scrcpy-protocol.js(순수)에 있고, 여기는 그 계약을 실제 프로세스·소켓에 붙인다.
 *
 * ⚠ 순서가 중요하다(실측으로 확인): `control=true` 면 서버는 **컨트롤 소켓까지 연결된 뒤에야**
 *  영상을 흘린다. 영상 소켓만 열고 기다리면 더미 바이트 하나만 받고 영원히 멈춘다(처음에 그랬다).
 *
 * ⚠ adb 는 서버의 추상 소켓이 생기기 **전에도** 포워드된 TCP 연결을 받아 주고 곧 끊는다.
 *  그래서 "연결됐다"가 아니라 "첫 바이트가 왔다"를 성공 신호로 쓴다.
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const P = require('./scrcpy-protocol');
const runtime = require('./runtime');

/** jar 는 저장소에 넣지 않고 처음 쓸 때 한 번 받아 캐시한다(우리 dmg 를 불리지 않는다). */
const JAR_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${P.SCRCPY_VERSION}/scrcpy-server-v${P.SCRCPY_VERSION}`;
const JAR_MIN_BYTES = 10_000;

function jarPath() {
  return path.join(runtime.stateDir(), 'scrcpy', `scrcpy-server-v${P.SCRCPY_VERSION}.jar`);
}

function jarReady() {
  try { return fs.statSync(jarPath()).size >= JAR_MIN_BYTES; } catch (_) { return false; }
}

let inFlightJar = null;
/** 동시에 두 기기를 열어도 내려받기는 한 번이다. */
function ensureJar() {
  if (jarReady()) return Promise.resolve(jarPath());
  if (!inFlightJar) {
    inFlightJar = download(JAR_URL, jarPath())
      .then(() => {
        if (!jarReady()) throw new Error('내려받은 파일이 온전하지 않아요');
        return jarPath();
      })
      .catch((e) => {
        try { fs.unlinkSync(jarPath()); } catch (_) { /* noop */ }
        throw new Error(`화면 스트리밍 도우미를 받지 못했어요(${e.message})`);
      })
      .finally(() => { inFlightJar = null; });
  }
  return inFlightJar;
}

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('리디렉션이 너무 많아요')); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, depth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function newScid() {
  // 서버가 %08x 로 파싱하는 **부호 있는** 32비트라 31비트로 마스크한다.
  return (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
}

function adb(adbPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { timeout: timeoutMs || 15000 }, (e, out) => e ? reject(e) : resolve(String(out)));
  });
}

class ScrcpySession {
  /**
   * @param {{ adb: string, serial: string, maxSize?: number, maxFps?: number, bitRate?: number }} opts
   * @param {{ onMeta, onFrame, onError, onClose }} cb
   */
  constructor(opts, cb) {
    this.opts = opts;
    this.cb = cb;
    this.scid = newScid();
    this.port = 0;
    this.server = null;
    this.video = null;
    this.control = null;
    this.pending = Buffer.alloc(0);
    this.headerStripped = false;
    this.meta = null;
    this.closed = false;
    /** 새로 붙는 화면에게 즉시 보내 줄 SPS/PPS — 없으면 다음 키프레임까지 검은 화면이다. */
    this.configPacket = null;
  }

  static async start(opts, cb) {
    const s = new ScrcpySession(opts, cb);
    try {
      await s._deploy();
      s._spawn();
      await s._connect();
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }

  async _deploy() {
    const jar = await ensureJar();
    await adb(this.opts.adb, P.pushArgs(this.opts.serial, jar), 60000);
    const out = await adb(this.opts.adb, P.forwardArgs(this.opts.serial, 0, this.scid));
    const port = parseInt(String(out).trim(), 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error('adb 가 포워드 포트를 알려주지 않았어요');
    this.port = port;
  }

  _spawn() {
    this.server = spawn(this.opts.adb, P.serverArgs(this.opts.serial, {
      scid: this.scid,
      maxSize: this.opts.maxSize,
      maxFps: this.opts.maxFps,
      videoBitRate: this.opts.bitRate,
    }), { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = (c) => { log = (log + c).slice(-2000); };
    this.server.stdout?.on('data', keep);
    this.server.stderr?.on('data', keep);
    this.server.on('error', (e) => this._fail(e.message));
    this.server.on('exit', () => {
      if (!this.meta) this._fail(`화면 스트리밍이 시작되지 못했어요${log.trim() ? ` — ${log.trim().split('\n').pop()}` : ''}`);
      else this.close();
    });
  }

  /** 첫 바이트가 올 때까지 재시도한다(위 주석: adb 는 서버보다 먼저 연결을 받아 준다). */
  _connect() {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        if (this.closed) { reject(new Error('닫혔어요')); return; }
        const sock = net.connect(this.port, '127.0.0.1');
        let settled = false;
        const retry = () => {
          if (settled || this.closed) return;
          settled = true;
          sock.destroy();
          if (n >= 100) { reject(new Error('화면 스트리밍이 시작되지 않았어요')); return; }
          setTimeout(() => attempt(n + 1), 100);
        };
        sock.once('data', (first) => {
          if (settled) return;
          settled = true;
          sock.setTimeout(0);
          this.video = sock;
          sock.on('data', (c) => this._onChunk(c));
          sock.on('error', (e) => this._fail(e.message));
          sock.on('close', () => this.close());
          this._readyResolve = resolve;
          this._onChunk(first);
          // ★ 컨트롤 소켓을 열어야 서버가 영상을 흘리기 시작한다.
          this._openControl();
        });
        sock.once('error', retry);
        sock.once('close', retry);
        sock.setTimeout(2000, retry);
      };
      attempt(0);
    });
  }

  _openControl() {
    if (this.closed) return;
    const sock = net.connect(this.port, '127.0.0.1');
    sock.on('error', () => { /* 조작만 안 될 뿐 화면은 산다 */ });
    sock.on('close', () => { if (this.control === sock) this.control = null; });
    sock.on('data', () => { /* 서버→클라 메시지(클립보드 등)는 안 쓴다 */ });
    this.control = sock;
  }

  _onChunk(chunk) {
    let buf = Buffer.concat([this.pending, chunk]);
    if (!this.headerStripped) {
      const need = P.DUMMY_BYTE + P.DEVICE_NAME_BYTES;
      if (buf.length < need) { this.pending = buf; return; }
      buf = Buffer.from(buf.subarray(need));
      this.headerStripped = true;
    }
    if (!this.meta) {
      const meta = P.parseCodecMeta(buf);
      if (!meta) { this.pending = buf; return; }
      this.meta = meta;
      buf = Buffer.from(buf.subarray(P.CODEC_META_SIZE));
      try { this.cb.onMeta?.(meta); } catch (_) { /* noop */ }
      this._readyResolve?.();
      this._readyResolve = null;
    }
    let out;
    try { out = P.parseFrames(Buffer.alloc(0), buf); }
    catch (e) { this._fail(e.message); return; }
    this.pending = out.pending;
    for (const f of out.frames) {
      if (f.config) this.configPacket = f.data;
      try { this.cb.onFrame?.(f); } catch (_) { /* noop */ }
    }
  }

  /** 컨트롤 소켓으로 바이트를 쓴다. 없으면 false — 호출측이 adb 폴백을 쓸 수 있게 정직하게 알린다. */
  send(buf) {
    if (!this.control || this.control.destroyed) return false;
    try { this.control.write(buf); return true; } catch (_) { return false; }
  }

  _fail(msg) {
    if (this.closed) return;
    try { this.cb.onError?.(msg); } catch (_) { /* noop */ }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.video?.destroy(); } catch (_) { /* noop */ }
    try { this.control?.destroy(); } catch (_) { /* noop */ }
    try { this.server?.kill(); } catch (_) { /* noop */ }
    if (this.port) adb(this.opts.adb, P.removeForwardArgs(this.opts.serial, this.port)).catch(() => {});
    try { this.cb.onClose?.(); } catch (_) { /* noop */ }
  }
}

module.exports = { ScrcpySession, ensureJar, jarPath, jarReady, _download: download };
