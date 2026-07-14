/**
 * 제어 채널 — back(/api/daemon/connect)으로의 상시 아웃바운드 WS
 *
 * 데몬은 인바운드 포트를 열지 않는다. 이 연결 하나로 back 의 지시(stream_open)를
 * 받고, 스트림은 그때마다 별도 WS 를 추가 다이얼(dial-back — lib/pty.js).
 *
 * 재접속: 지수 백오프(1s→최대 30s) + 지터. back 재배포로 끊겨도 자동 복구.
 * 생존 감시: back 이 30s 마다 protocol ping(ws 가 자동 pong). 반대로 90s 동안
 * 아무 신호가 없으면 죽은 연결로 보고 terminate → 재접속.
 */
const os = require('os');
const WebSocket = require('ws');
const ptyLib = require('./pty');
const proxyLib = require('./proxy');
const fsRpc = require('./fs');
const wsRpc = require('./workspace');
const agentLib = require('./agent');
const syncLib = require('./sync');

const IDLE_TIMEOUT_MS = 90 * 1000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;

function run(config) {
  let backoff = BACKOFF_MIN_MS;
  let ws = null;
  let idleTimer = null;

  const wsUrl = config.serverUrl.replace(/^http/, 'ws') + '/api/daemon/connect';

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn('[control] 90초간 신호 없음 — 연결 재수립');
      try { ws.terminate(); } catch (_) { /* noop */ }
    }, IDLE_TIMEOUT_MS);
  };

  const connect = () => {
    console.log(`[control] 연결 시도 → ${wsUrl}`);
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${config.deviceToken}` } });

    ws.on('open', () => {
      backoff = BACKOFF_MIN_MS;
      bumpIdle();
      ws.send(JSON.stringify({
        type: 'hello',
        deviceName: config.deviceName || os.hostname(),
        platform: process.platform,
        daemonVersion: config.daemonVersion || 'unknown',
        clientType: config.clientType || 'daemon',
      }));
      console.log('[control] 연결됨 — 지시 대기 중 (Ctrl+C 로 종료)');
    });

    ws.on('ping', bumpIdle);
    ws.on('message', (data, isBinary) => {
      bumpIdle();
      if (isBinary) return;
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'hello_ack') {
        console.log(`[control] 서버 확인 (serverTime=${msg.serverTime})`);
        return;
      }
      if (msg.type === 'stream_open') {
        console.log(`[control] stream_open kind=${msg.kind}`);
        try {
          if (msg.kind === 'pty') {
            ptyLib.openPtyStream(config, msg);
          } else if (msg.kind === 'tcp') {
            proxyLib.openTcpStream(config, msg); // 프리뷰 — 로컬 포트 raw TCP 터널
          } else {
            throw new Error(`지원하지 않는 스트림 종류: ${msg.kind}`);
          }
        } catch (e) {
          console.error(`[control] 스트림 열기 실패: ${e.message}`);
          try { ws.send(JSON.stringify({ type: 'stream_fail', streamToken: msg.streamToken, message: e.message })); } catch (_) { /* noop */ }
        }
        return;
      }
      // fs RPC(list/read/write/watch/unwatch) — 요청/응답. back 이 id 로 응답을 매칭.
      if (msg.type === 'rpc' && msg.id) {
        const ok = (result) => { try { ws.send(JSON.stringify({ type: 'rpc_result', id: msg.id, ok: true, result })); } catch (_) { /* noop */ } };
        const fail = (e) => { try { ws.send(JSON.stringify({ type: 'rpc_result', id: msg.id, ok: false, error: (e && e.message) || String(e) })); } catch (_) { /* noop */ } };
        // watch/unwatch 는 unsolicited push(fs_event)를 동반하므로 여기서 직접 처리(제어 ws 에 바인딩).
        if (msg.method === 'fs.watch') {
          try {
            const r = fsRpc.startWatch(msg.params && msg.params.path, (ev) => {
              try { ws.send(JSON.stringify({ type: 'fs_event', event: ev.event, path: ev.path })); } catch (_) { /* noop */ }
            });
            ok(r);
          } catch (e) { fail(e); }
          return;
        }
        if (msg.method === 'fs.unwatch') { fsRpc.stopWatch(); ok({ ok: true }); return; }
        if (msg.method === 'net.ports') { proxyLib.listPorts(msg.params || {}).then(ok).catch(fail); return; }
        // 멀티 터미널(tmux window) — terminal.list/new/select/close.
        if (msg.method.startsWith('terminal.')) { ptyLib.handleTerminalRpc(msg.method, msg.params).then(ok).catch(fail); return; }
        // BYO 에이전트(agent.start/input/approve/…) — ws 를 넘겨 이벤트 push 대상 갱신.
        if (msg.method.startsWith('agent.')) { agentLib.handle(msg.method, msg.params, ws).then(ok).catch(fail); return; }
        // 동기화(sync.checkpoint/materialize/status/resolve) — ws 를 넘겨 sync_event push.
        if (msg.method.startsWith('sync.')) { syncLib.handle(msg.method, msg.params, ws).then(ok).catch(fail); return; }
        // 워크스페이스 스캐폴드/루트 지정(ws.getRoot/setRoot/create).
        if (msg.method.startsWith('ws.')) { wsRpc.handle(msg.method, msg.params).then(ok).catch(fail); return; }
        fsRpc.handle(msg.method, msg.params).then(ok).catch(fail);
        return;
      }
    });

    const scheduleReconnect = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const delay = backoff + Math.floor(Math.random() * 1000);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      console.log(`[control] ${Math.round(delay / 1000)}초 후 재접속`);
      setTimeout(connect, delay);
    };

    let closed = false;
    ws.on('close', (code, reason) => {
      if (closed) return; closed = true;
      fsRpc.stopWatch(); // 이 연결에 바인딩된 감시 정리(재접속 시 앱이 다시 watch 등록)
      agentLib.detachAll(); // 이벤트 push 대상 해제(자식 claude 는 유지 — 재접속 시 backlog)
      console.warn(`[control] 연결 끊김 code=${code} reason=${reason || ''}`);
      if (code === 4001) { // revoked — 재페어링 필요
        console.error('[control] 서버에서 이 기기의 연결이 해제되었습니다. `pair` 를 다시 실행하세요.');
        process.exit(1);
      }
      scheduleReconnect();
    });
    ws.on('error', (e) => {
      console.warn(`[control] WS 오류: ${e.message}`);
      // 'close' 가 뒤따르지 않는 초기 접속 실패도 있어 close 핸들러와 중복 방지.
      if (closed) return; closed = true;
      try { ws.terminate(); } catch (_) { /* noop */ }
      scheduleReconnect();
    });
  };

  connect();
}

module.exports = { run };
