'use strict';

// 터미널 v3 스트림 — 뷰어(io) 하나를 TerminalHost(정본)에 붙인다. docs/terminal-v3-design.md §2-§3.
//
// 이 파일이 v2 의 attachPty(1,400줄) 를 대체하는 전부다. 사라진 것: controller lease · nudge ·
//  resize-window 클레임 · v1 부트스트랩 · 스냅샷 3벌 · 모드 조회 · canonical 플래그. 이유는 정본이
//  데몬 VT 하나이고 크기 주체가 소유자 1명이라 화해할 게 없기 때문이다.
const terminalV3 = require('./terminal-stream-v3');
const { TerminalHostRegistry } = require('./terminal-host');

const STREAM_IDLE_MS = Math.max(500, Number(process.env.CPT_STREAM_IDLE_MS) || 90000);
const HISTORY_LIMIT_MAX = 500;

let registry = null;
function hostRegistry(deps) {
  if (!registry) registry = new TerminalHostRegistry(deps);
  return registry;
}

/**
 * @param {object} ctx { name: tmux 세션명, cols, rows, device:{deviceId,name}, deps:{tmux,socket,env,runTmux} }
 * @param {object} io  { send, onMessage, onClose, close, transport, label }
 */
async function attachV3(ctx, io) {
  let host = await hostRegistry(ctx.deps).get(ctx.name, { cols: ctx.cols, rows: ctx.rows });
  await host.ready;
  const device = ctx.device && ctx.device.deviceId ? ctx.device : null;
  let seq = 0;
  let cleaned = false;
  let lastClientMsgAt = Date.now();
  // 탭 전환(terminal.select) 중에는 새 정본의 OUTPUT 을 잡아 둔다 — SNAPSHOT 보다 먼저 나가면
  //  클라가 아직 옛 세대의 seq/epoch 로 판정해 프레임을 통째로 버린다(화면이 안 바뀐다).
  let swapQueue = null;
  const send = (opcode, payload) => { try { io.send(terminalV3.encode(opcode, ++seq, payload)); } catch (_) { /* noop */ } };
  const sendJson = (opcode, obj) => send(opcode, JSON.stringify(obj));
  const ownerFrame = () => ({ owner: host.owner, self: !!(device && host.owner && host.owner.deviceId === device.deviceId), free: !host.owner });

  const sendSnapshot = async () => {
    const s = await host.snapshot();
    sendJson(terminalV3.OPCODE.SNAPSHOT, { ...s, ...ownerFrame() });
  };

  // 정본 → 이 뷰어. OUTPUT 은 정본 seq 를 그대로 싣는다(이어받기 기준이 뷰어별이 아니라 정본).
  const onFrame = (f) => {
    if (swapQueue) { swapQueue.push(f); return; }
    if (f.type === 'output') { try { io.send(terminalV3.encode(terminalV3.OPCODE.OUTPUT, f.seq, f.buf)); } catch (_) { /* noop */ } }
    else if (f.type === 'resized') sendJson(terminalV3.OPCODE.RESIZED, { cols: f.cols, rows: f.rows });
    else if (f.type === 'owner') sendJson(terminalV3.OPCODE.OWNER, ownerFrame());
    else if (f.type === 'exit') { sendJson(terminalV3.OPCODE.EXIT, { code: f.code }); cleanup(); }
  };
  let off = host.subscribe(onFrame);

  /**
   * 탭 전환 — 같은 뷰어(WS)를 다른 터미널 정본으로 갈아탄다. 앱/PC 는 탭을 바꿔도 스트림을 새로
   *  열지 않고 `terminal.select` 만 부르므로, 이게 없으면 탭을 눌러도 옛 터미널이 계속 보인다.
   *  (v2 의 attachPty 가 하던 swap 을 v3 로 옮긴 것 — 2026-09-06 이전까지 v3 에 아예 없었다.)
   */
  const swapTo = async (nextName) => {
    const name = String(nextName || '');
    if (!name || cleaned || name === host.name) return;
    swapQueue = [];
    off();
    const next = await hostRegistry(ctx.deps).get(name, { cols: host.cols, rows: host.rows });
    await next.ready;
    host = next;
    off = host.subscribe(onFrame);
    await sendSnapshot();                    // 새 세대의 seq·epoch·격자·소유자를 먼저 알린다
    const queued = swapQueue; swapQueue = null;
    for (const f of queued) onFrame(f);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(reaper);
    off();
    try { io.dispose && io.dispose(); } catch (_) { /* noop */ }
  };
  // 릴레이가 붙잡은 유령 스트림 회수 — 뷰어는 25초 keepalive 를 보낸다.
  const reaper = setInterval(() => {
    if (cleaned) return;
    if (Date.now() - lastClientMsgAt >= STREAM_IDLE_MS) {
      console.warn(`[pty3] 스트림 정리 — 무응답 ${Math.round((Date.now() - lastClientMsgAt) / 1000)}초 (${ctx.name})`);
      try { io.close(); } catch (_) { /* noop */ }
      cleanup();
    }
  }, Math.max(1000, Math.min(15000, Math.floor(STREAM_IDLE_MS / 4))));
  if (typeof reaper.unref === 'function') reaper.unref();

  // 입력 통지 — shift+tab(CSI Z) 같은 모드 전환 키는 statusline 감시자가 **즉시** 화면을 다시 읽어야
  //  채팅의 에이전트 모드 알약이 늦지 않는다(v2 attachPty 가 하던 일 — 2026-09-06 v3 로 옮김).
  //  지연 require: status-line → pty → pty-v3 순환을 피한다.
  const notifyInput = (buf) => {
    try { require('./status-line').onTerminalInput(host.name, buf); } catch (_) { /* noop */ }
  };

  io.onClose(cleanup);
  io.onMessage((kind, payload) => {
    lastClientMsgAt = Date.now();
    if (kind === 'stdin') { notifyInput(payload); host.input(payload).catch(() => {}); return; }
    let m;
    try { m = JSON.parse(String(payload)); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello': {
        // 이어받기: 링버퍼 안이면 OUTPUT 을 seq 순서로, 아니면 스냅샷. 항상 OWNER 도 알려준다.
        const replay = host.replaySince(m.lastSeq, m.epoch);
        if (replay) {
          sendJson(terminalV3.OPCODE.RESIZED, { cols: host.cols, rows: host.rows });
          sendJson(terminalV3.OPCODE.OWNER, ownerFrame());
          for (const r of replay) { try { io.send(terminalV3.encode(terminalV3.OPCODE.OUTPUT, r.seq, r.buf)); } catch (_) { /* noop */ } }
        } else sendSnapshot().catch(() => {});
        return;
      }
      case 'input': {
        if (typeof m.data === 'string') {
          const buf = Buffer.from(m.data, 'base64');
          notifyInput(buf);
          host.input(buf).catch(() => {});
        }
        return;
      }
      case 'resize': {
        const cols = m.cols | 0, rows = m.rows | 0;
        (async () => {
          const before = `${host.cols}x${host.rows}`;
          const ok = await host.resize(cols, rows, device && device.deviceId);
          if (!ok) { sendJson(terminalV3.OPCODE.OWNER, ownerFrame()); sendJson(terminalV3.OPCODE.RESIZED, { cols: host.cols, rows: host.rows }); return; }
          // 첫 소유자 확정(아직 아무도 없을 때의 resize)은 소유권 기록으로 남긴다.
          if (!host.owner && device) await host.claim(device);
          if (before !== `${host.cols}x${host.rows}`) await sendSnapshot();
        })().catch(() => {});
        return;
      }
      case 'claim': {
        if (!device) return;
        host.claim(device).then(() => sendJson(terminalV3.OPCODE.OWNER, ownerFrame())).catch(() => {});
        return;
      }
      case 'history': {
        const limit = Math.max(1, Math.min(HISTORY_LIMIT_MAX, m.limit | 0 || 200));
        host.historyPage({ before: m.before == null ? undefined : m.before | 0, limit })
          .then((page) => sendJson(terminalV3.OPCODE.HISTORY_PAGE, page))
          .catch(() => {});
        return;
      }
      case 'keepalive': return;
      default: return;
    }
  });

  // 첫 화면: 스냅샷 + 소유자. (hello 를 보내는 재접속 뷰어는 곧 이어받기를 받는다.)
  await sendSnapshot();
  console.log(`[pty3] 뷰어 연결 (${io.transport || 'relay'}, ${ctx.name}, ${host.cols}x${host.rows}, owner=${host.owner ? host.owner.deviceId : '-'}, viewer=${device ? device.deviceId : '?'})`);
  return { get host() { return host; }, cleanup, swapTo };
}

module.exports = { attachV3, hostRegistry, STREAM_IDLE_MS };
