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
const cptServer = require('./cpt-server');

const IDLE_TIMEOUT_MS = 90 * 1000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30 * 1000;

function run(config) {
  let backoff = BACKOFF_MIN_MS;
  let ws = null;
  let idleTimer = null;

  // cpt 소켓·shim·WS 연결은 파일 하단 boot() 에서 — 기존 인스턴스 인수(takeover) 후 순서대로.

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
      try { if (ws._socket) ws._socket.setNoDelay(true); } catch (_) { /* noop */ } // Nagle off — RPC/resize 응답성
      backoff = BACKOFF_MIN_MS;
      bumpIdle();
      ws.send(JSON.stringify({
        type: 'hello',
        deviceName: config.deviceName || os.hostname(),
        platform: process.platform,
        daemonVersion: config.daemonVersion || 'unknown',
        clientType: config.clientType || 'daemon',
      }));
      cptServer.setControlWs(ws); // cpt ui_command 전송로 갱신
      console.log('[control] 연결됨 — 지시 대기 중 (Ctrl+C 로 종료)');
    });

    // 업그레이드 거부(101 아님) — 401/403 = deviceToken 무효(계정 탈퇴/기기 해제). 재시도 무의미,
    //  방치하면 백오프 재연결이 영원히 돈다(고아 데몬 폭주). 즉시 종료한다.
    //  그 외 상태코드(프록시 5xx 등)는 일시 장애로 보고 기존 close 경로로 재접속을 잇는다.
    ws.on('unexpected-response', (_req2, res2) => {
      const sc = res2 && res2.statusCode;
      if (sc === 401 || sc === 403) {
        console.error('[control] 서버가 이 기기의 등록을 거부했습니다(계정 탈퇴/기기 해제). `pair` 를 다시 실행하세요.');
        process.exit(1);
      }
      try { ws.terminate(); } catch (_) { /* noop */ }
      ws.emit('close', 1006, `unexpected-response ${sc || ''}`); // close 핸들러(중복 가드 내장)로 재접속 스케줄
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
      // cpt ui_command 의 결과 회신(back → 데몬) — 대기 중인 CLI 요청으로 전달.
      if (msg.type === 'ui_result' && msg.id) {
        cptServer.resolveUi(msg.id, msg);
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
      if (code === 4000) { // replaced — 같은 기기의 새 데몬이 연결됨. 재접속하면 서로 밀어내는
        //  핑퐁(재연결 폭주)이 되므로 구 인스턴스는 조용히 물러난다(takeover 소켓이 못 잡는
        //  다른 stateDir/구버전 고아까지 이 경로로 정리됨).
        console.error('[control] 이 기기의 새 데몬 인스턴스로 대체되었습니다 — 이 인스턴스를 종료합니다.');
        process.exit(0);
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

  (async () => {
    // 같은 stateDir 의 기존 인스턴스가 살아있으면 정상 종료를 지시하고 대체(새 인스턴스 승리) —
    //  둘이 단일 control WS 를 서로 뺏는 replaced 재접속 폭주 방지. WS 연결 전에 수행해야 무쟁탈.
    try {
      // 소켓 무관 백스톱 먼저 — sock 을 잃은 좀비 데몬(takeover 사각지대)까지 ps 로 훑어 정리.
      const strays = await cptServer.killStrayDaemons();
      if (strays) console.log(`[control] 다른 데몬 프로세스 ${strays}개 정리(단일 인스턴스 강제)`);
      // 그다음 sock 소유자 graceful 인수(정상 경로).
      const took = await cptServer.takeoverExisting();
      if (took) console.log('[control] 기존 데몬 인스턴스 인수 완료(구 인스턴스 종료 지시)');
    } catch (_) { /* noop */ }
    // cpt 컨트롤 소켓 — 터미널 안의 AI/사용자가 `cpt` CLI 로 서비스를 조작하는 로컬 진입점.
    try { cptServer.start(config); } catch (e) { console.error('[control] cpt 소켓 시작 실패:', e.message); }
    // shim(cpt/claude/codex 래퍼 + claude 훅 설정) 멱등 생성 — 터미널 PATH 주입은 pty.js 가 담당.
    try { require('./shim').ensureShims(); } catch (e) { console.error('[control] shim 생성 실패:', e.message); }
    // 신선도 보고 루프(사이드바 미커밋/미푸시 배지) — 60s 주기, 변화시에만 서버 기록.
    try { require('./freshness').start(); } catch (e) { console.error('[control] freshness 시작 실패:', e.message); }
    // 스테일 뷰 세션 리퍼 — 시작 시 1회 + 주기(120s). 버려진 pane 뷰 세션(--p-/--v-/--c-)이 영구
    //  tmux 소켓에 무한 누적되는 것을 막는다(attach 없는 뷰만·primary 셸은 보존). idleSec grace 로
    //  방금 만든 뷰는 안 건드림. 데몬 수명 내내 소켓을 스스로 청소한다.
    const reap = () => ptyLib.reapStaleViews()
      .then((n) => { if (n) console.log(`[control] 스테일 뷰 세션 ${n}개 정리`); })
      .catch(() => { /* 서버 없음 등 — 다음 주기 */ });
    reap();
    const reapTimer = setInterval(reap, 120000);
    if (reapTimer.unref) reapTimer.unref();
    connect();
  })();
}

module.exports = { run };
