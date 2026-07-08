/**
 * 승인 중계 MCP 서버 (stdio) — claude 의 `--permission-prompt-tool` 대상.
 *
 * claude 가 게이트된 도구(Write/Edit/Bash 등)를 쓰려 할 때마다 이 서버의 `approval_prompt`
 * 도구를 호출한다. 서버는 그 요청을 유닉스 소켓(CPT_APPROVAL_SOCK)으로 데몬(lib/agent.js)에
 * 넘겨 앱에 승인 카드를 띄우고, 앱의 결정을 받아 claude 에 {behavior:'allow'|'deny'} 로 돌려준다.
 *
 * 이 프로세스는 claude 가 spawn 하는 자식이다(우리가 아님). 자격증명은 다루지 않는다.
 * env: CPT_APPROVAL_SOCK(유닉스 소켓 경로), CPT_SPAWN_ID(어느 claude 세션인지 식별).
 */
const net = require('net');

const SOCK = process.env.CPT_APPROVAL_SOCK;
const SPAWN_ID = process.env.CPT_SPAWN_ID || '';

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// 데몬으로 승인 요청 1건 → 결정 1건. 소켓 실패 시 기본 deny(안전).
function askDaemon(payload) {
  return new Promise((resolve) => {
    if (!SOCK) return resolve({ behavior: 'deny', message: '승인 채널이 없습니다.' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = net.connect(SOCK, () => {
      sock.write(JSON.stringify({ spawnId: SPAWN_ID, ...payload }) + '\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try { finish(JSON.parse(buf.slice(0, i))); } catch (_) { finish({ behavior: 'deny', message: '승인 응답 파싱 실패' }); }
        try { sock.end(); } catch (_) { /* noop */ }
      }
    });
    sock.on('error', () => finish({ behavior: 'deny', message: '승인 채널 연결 실패' }));
    sock.on('close', () => finish({ behavior: 'deny', message: '승인 채널이 닫혔습니다.' }));
  });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    handle(m);
  }
});

async function handle(m) {
  if (m.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cptapproval', version: '1.0.0' },
    } });
  }
  if (m.method === 'notifications/initialized') return; // 알림 — 응답 없음
  if (m.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
      name: 'approval_prompt',
      description: 'Request user approval for a tool use. Returns allow/deny.',
      inputSchema: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
        required: ['tool_name', 'input'],
      },
    }] } });
  }
  if (m.method === 'tools/call') {
    const a = (m.params && m.params.arguments) || {};
    const decision = await askDaemon({
      tool_name: a.tool_name,
      input: a.input || {},
      tool_use_id: a.tool_use_id || m.params.tool_use_id || null,
    });
    // Claude Code 계약: permission-prompt-tool 은 {behavior:'allow',updatedInput}|{behavior:'deny',message} 를
    // JSON 텍스트 content 로 반환한다.
    const payload = decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: decision.updatedInput || a.input || {} }
      : { behavior: 'deny', message: decision.message || '사용자가 거부했습니다.' };
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  }
  if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: {} });
}
