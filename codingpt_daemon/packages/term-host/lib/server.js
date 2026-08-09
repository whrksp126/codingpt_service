/**
 * term-host 서버 — named pipe(win32)/유닉스 소켓(개발) 위 NDJSON 프로토콜(설계 계약 1).
 *
 * 프로토콜: 접속당 1개 NDJSON 채널. 첫 줄부터 `{id, op, ...}` 단발 op 를 임의 개수 처리하다가
 *  `attach` 를 만나면 그 커넥션은 양방향 스트림으로 전환된다.
 *   · 단발 op: create · list · has · kill · killServer · sendKeys · capture · resize ·
 *              setEnv · getEnv · rename · respawn · info · ping
 *   · 응답: `{id, ok:true, ...결과}` | `{id, ok:false, error, code}`
 *   · attach 스트림 프레임: {t:'o',d:b64}(출력) {t:'i',d:b64}(입력) {t:'r',cols,rows}(리사이즈)
 *     {t:'k',keys,literal,count}(send-keys 등가) {t:'x',code}(세션 종료) {t:'bell'}
 *
 * 단일 인스턴스 = 파이프 서버 점유가 곧 락: listen 에 성공한 프로세스만 호스트다.
 *  EADDRINUSE 면 살아있는 호스트 존재(정상) → started:false 로 보고. 유닉스 소켓은 스테일
 *  파일(크래시 잔재)일 수 있어 connect 프로브 후 unlink-재시도한다.
 *
 * 내구성: 클라이언트 0이어도 상주. killServer op 로만 종료. 세션 메타는
 *  `<stateDir>/termhost/sessions.json` 에 저널(복원은 respawn 정책 — 자동 재기동 금지: 크래시
 *  후 첫 respawn{name} 호출이 저널의 cwd/env 로 셸을 되살린다).
 */
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const paths = require('./paths');
const { Session } = require('./session');

const PROTOCOL_VERSION = 1;

class TermHostServer {
  /**
   * @param {object} o { sockPath?, journalPath?, exitOnKill? } — 테스트는 exitOnKill:false 로
   *  in-process 기동한다(프로토콜 로직은 플랫폼 중립).
   */
  constructor(o = {}) {
    this.sockPath = o.sockPath || paths.pipePath();
    this.journalPath = o.journalPath || paths.journalPath();
    this.exitOnKill = o.exitOnKill !== false;
    this.sessions = new Map();   // name -> Session(live)
    this.orphans = new Map();    // name -> journalEntry(직전 호스트 크래시 잔재 — respawn 재료)
    this.server = null;
    this._loadJournal();
  }

  // ── 저널 ────────────────────────────────────────────────────────────────
  _loadJournal() {
    try {
      const j = JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
      for (const e of (j && j.sessions) || []) {
        if (e && e.name) this.orphans.set(String(e.name), e);
      }
    } catch (_) { /* 저널 없음/파손 = 빈 시작 */ }
  }

  _writeJournal() {
    try {
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      const doc = { version: 1, updatedAt: Date.now(), sessions: [...this.sessions.values()].map((s) => s.journalEntry()) };
      const tmp = this.journalPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, this.journalPath);
    } catch (_) { /* 저널 실패는 서비스 비치명(복원 품질만 저하) */ }
  }

  // ── 기동/종료 ───────────────────────────────────────────────────────────
  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this._handleConn(sock));
      const listen = () => server.listen(this.sockPath, () => {
        this.server = server;
        if (process.platform !== 'win32') { try { fs.chmodSync(this.sockPath, 0o600); } catch (_) { /* noop */ } }
        resolve({ started: true, sockPath: this.sockPath });
      });
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          // 이미 다른 호스트가 점유(단일 인스턴스 락). 유닉스 소켓은 스테일 파일 가능성 프로브.
          if (process.platform === 'win32') return resolve({ started: false, reason: 'already-running' });
          const probe = net.connect(this.sockPath);
          probe.once('connect', () => { probe.destroy(); resolve({ started: false, reason: 'already-running' }); });
          probe.once('error', () => {
            probe.destroy();
            try { fs.unlinkSync(this.sockPath); } catch (_) { /* noop */ }
            server.removeAllListeners('error');
            server.once('error', reject);
            listen();
          });
          return;
        }
        reject(err);
      });
      try { fs.mkdirSync(path.dirname(this.sockPath), { recursive: true }); } catch (_) { /* pipe 네임스페이스 등 */ }
      listen();
    });
  }

  stop() {
    for (const s of [...this.sessions.values()]) { try { s.kill(); } catch (_) { /* noop */ } }
    this.sessions.clear();
    this._writeJournal();
    if (this.server) { try { this.server.close(); } catch (_) { /* noop */ } this.server = null; }
    if (process.platform !== 'win32') { try { fs.unlinkSync(this.sockPath); } catch (_) { /* noop */ } }
  }

  // ── 커넥션 처리(NDJSON) ─────────────────────────────────────────────────
  _handleConn(sock) {
    sock.setNoDelay(true);
    let buf = '';
    let attached = null; // Session — attach 후 스트림 모드
    const detach = () => { if (attached) { attached.detach(sock); attached = null; } };
    sock.on('close', detach);
    sock.on('error', () => { /* close 가 정리 */ });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (attached) this._handleFrame(attached, msg);
        else this._handleOp(sock, msg, (s) => { attached = s; });
      }
    });
  }

  _reply(sock, id, body) {
    try { sock.write(JSON.stringify({ id, ok: true, ...body }) + '\n'); } catch (_) { /* noop */ }
  }
  _replyErr(sock, id, error, code) {
    try { sock.write(JSON.stringify({ id, ok: false, error: String(error), code: code || 'ERROR' }) + '\n'); } catch (_) { /* noop */ }
  }

  _need(name) {
    const s = this.sessions.get(String(name));
    if (!s || s.dead) { const e = new Error(`세션이 없습니다: ${name}`); e.code = 'NO_SESSION'; throw e; }
    return s;
  }

  // attach 스트림 프레임(클라→호스트).
  _handleFrame(session, f) {
    if (!f || typeof f.t !== 'string') return;
    if (f.t === 'i') { try { session.write(Buffer.from(String(f.d || ''), 'base64')); } catch (_) { /* noop */ } return; }
    if (f.t === 'r') { session.resize(f.cols, f.rows); return; } // latest wins — 마지막 프레임이 이긴다
    if (f.t === 'k') { try { session.sendKeys({ keys: f.keys, data: f.data, literal: f.literal, count: f.count }); } catch (_) { /* noop */ } return; }
  }

  async _handleOp(sock, msg, onAttach) {
    const { id, op } = msg || {};
    try {
      switch (op) {
        case 'ping':
          return this._reply(sock, id, { pid: process.pid, version: PROTOCOL_VERSION, sessions: this.sessions.size });

        case 'create': {
          const name = String(msg.name || '');
          if (!name) return this._replyErr(sock, id, '세션명이 필요합니다', 'BAD_REQUEST');
          if (this.sessions.has(name) && !this.sessions.get(name).dead) {
            return this._replyErr(sock, id, `duplicate session: ${name}`, 'DUPLICATE_SESSION');
          }
          const s = new Session(
            { name, cwd: msg.cwd, env: msg.env, cols: msg.cols, rows: msg.rows, shell: msg.shell, args: msg.args },
            {
              onDeath: (sess) => { this.sessions.delete(sess.name); this.orphans.delete(sess.name); this._writeJournal(); },
              onMutate: () => this._writeJournal(),
            }
          );
          this.sessions.set(name, s);
          this.orphans.delete(name);
          this._writeJournal();
          return this._reply(sock, id, s.meta());
        }

        case 'list':
          return this._reply(sock, id, { sessions: [...this.sessions.values()].filter((s) => !s.dead).map((s) => s.meta()) });

        case 'has': {
          const alive = this.sessions.has(String(msg.name)) && !this.sessions.get(String(msg.name)).dead;
          return this._reply(sock, id, { exists: alive });
        }

        case 'info': {
          // display-message 등가 묶음 — pane_current_command/window_width/cursor_x·y 소비자 커버.
          const s = this._need(msg.name);
          await s.screen.flush();
          return this._reply(sock, id, { ...s.meta(), cursor: s.screen.cursor() });
        }

        case 'kill': {
          const s = this.sessions.get(String(msg.name));
          if (s && !s.dead) s.kill(); // onDeath 가 목록/저널 정리
          this.orphans.delete(String(msg.name));
          this._writeJournal();
          return this._reply(sock, id, {}); // 이미 없어도 멱등 성공(kill-session 소비자 관례)
        }

        case 'killServer': {
          this._reply(sock, id, {});
          // 응답 플러시 여지를 준 뒤 정리(tmux kill-server 등가 — 세션 전멸 + 서버 종료).
          setTimeout(() => {
            this.stop();
            if (this.exitOnKill) process.exit(0);
          }, 30);
          return;
        }

        case 'sendKeys': {
          const s = this._need(msg.name);
          s.sendKeys({ data: msg.data, keys: msg.keys, literal: msg.literal, count: msg.count });
          return this._reply(sock, id, {});
        }

        case 'capture': {
          const s = this._need(msg.name);
          const text = await s.capture({ escapes: !!msg.escapes, lines: msg.lines, join: !!msg.join });
          return this._reply(sock, id, { text });
        }

        case 'resize': {
          const s = this._need(msg.name);
          s.resize(msg.cols, msg.rows);
          return this._reply(sock, id, { cols: s.screen.cols, rows: s.screen.rows });
        }

        case 'setEnv': {
          this._need(msg.name).setEnv(msg.k, msg.v);
          return this._reply(sock, id, {});
        }

        case 'getEnv': {
          const v = this._need(msg.name).getEnv(msg.k);
          return this._reply(sock, id, { value: v });
        }

        case 'rename': {
          this._need(msg.name).rename(msg.title);
          return this._reply(sock, id, {});
        }

        case 'respawn': {
          const name = String(msg.name || '');
          const live = this.sessions.get(name);
          if (live && !live.dead) {
            live.respawn({ cwd: msg.cwd });
            return this._reply(sock, id, live.meta());
          }
          // 크래시 복원 정책: 저널 고아를 respawn 으로 되살린다(자동 재기동은 하지 않는다).
          const orphan = this.orphans.get(name);
          if (!orphan) return this._replyErr(sock, id, `세션이 없습니다: ${name}`, 'NO_SESSION');
          const s = new Session(
            { name, cwd: msg.cwd || orphan.cwd, env: orphan.env, cols: msg.cols, rows: msg.rows, shell: orphan.shell },
            {
              onDeath: (sess) => { this.sessions.delete(sess.name); this.orphans.delete(sess.name); this._writeJournal(); },
              onMutate: () => this._writeJournal(),
            }
          );
          if (orphan.title) s.rename(orphan.title);
          this.sessions.set(name, s);
          this.orphans.delete(name);
          this._writeJournal();
          return this._reply(sock, id, s.meta());
        }

        case 'attach': {
          const s = this._need(msg.name);
          this._reply(sock, id, { name: s.name, cols: s.screen.cols, rows: s.screen.rows, panePid: s.meta().panePid });
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) s.resize(msg.cols, msg.rows); // 접속 크기 = latest
          s.attach(sock);
          onAttach(s);
          return;
        }

        default:
          return this._replyErr(sock, id, `알 수 없는 op: ${op}`, 'BAD_OP');
      }
    } catch (e) {
      return this._replyErr(sock, id, (e && e.message) || e, (e && e.code) || 'ERROR');
    }
  }
}

module.exports = { TermHostServer, PROTOCOL_VERSION };
