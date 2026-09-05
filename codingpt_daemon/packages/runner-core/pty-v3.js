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
  const host = await hostRegistry(ctx.deps).get(ctx.name, { cols: ctx.cols, rows: ctx.rows });
  await host.ready;
  const device = ctx.device && ctx.device.deviceId ? ctx.device : null;
  let seq = 0;
  let cleaned = false;
  let lastClientMsgAt = Date.now();
  const send = (opcode, payload) => { try { io.send(terminalV3.encode(opcode, ++seq, payload)); } catch (_) { /* noop */ } };
  const sendJson = (opcode, obj) => send(opcode, JSON.stringify(obj));
  const ownerFrame = () => ({ owner: host.owner, self: !!(device && host.owner && host.owner.deviceId === device.deviceId), free: !host.owner });

  const sendSnapshot = async () => {
    const s = await host.snapshot();
    sendJson(terminalV3.OPCODE.SNAPSHOT, { ...s, ...ownerFrame() });
  };

  // 정본 → 이 뷰어. OUTPUT 은 정본 seq 를 그대로 싣는다(이어받기 기준이 뷰어별이 아니라 정본).
  const off = host.subscribe((f) => {
    if (f.type === 'output') { try { io.send(terminalV3.encode(terminalV3.OPCODE.OUTPUT, f.seq, f.buf)); } catch (_) { /* noop */ } }
    else if (f.type === 'resized') sendJson(terminalV3.OPCODE.RESIZED, { cols: f.cols, rows: f.rows });
    else if (f.type === 'owner') sendJson(terminalV3.OPCODE.OWNER, ownerFrame());
    else if (f.type === 'exit') { sendJson(terminalV3.OPCODE.EXIT, { code: f.code }); cleanup(); }
  });

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

  io.onClose(cleanup);
  io.onMessage((kind, payload) => {
    lastClientMsgAt = Date.now();
    if (kind === 'stdin') { host.input(payload).catch(() => {}); return; }
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
        if (typeof m.data === 'string') host.input(Buffer.from(m.data, 'base64')).catch(() => {});
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
  return { host, cleanup };
}

module.exports = { attachV3, hostRegistry, STREAM_IDLE_MS };
