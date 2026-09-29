#!/usr/bin/env node
/**
 * @codingpt/term-host — tmux 서버의 Windows 등가물(상주 세션 호스트) CLI 엔트리.
 *
 *  node index.js run          호스트 기동(단일 인스턴스 — 파이프 점유가 락. 이미 있으면 즉시 종료 0)
 *  node index.js kill-server  실행 중인 호스트에 killServer op 전송(유일한 정규 종료 경로)
 *  node index.js status       ping 결과 출력(디버그)
 *
 * 데몬(term-backend)이 최초 필요 시 detached 로 spawn 한다 — 데몬이 죽어도 터미널(세션)은 이
 * 프로세스에 살아남는다. 파이프 경로 규칙은 lib/paths.js(설계 계약 1).
 */
'use strict';
const net = require('net');
const paths = require('./lib/paths');
const { TermHostServer } = require('./lib/server');

function oneShot(op) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(paths.pipePath());
    let buf = '';
    sock.once('error', reject);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, op }) + '\n'));
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
        sock.destroy();
      }
    });
  });
}

async function main() {
  const cmd = process.argv[2] || 'run';

  if (cmd === 'run') {
    const server = new TermHostServer();
    const r = await server.start();
    if (!r.started) {
      // 단일 인스턴스: 이미 다른 호스트가 파이프를 점유 — 정상 종료(스폰 경쟁 무해).
      console.log('[term-host] 이미 실행 중 — 종료');
      process.exit(0);
    }
    console.log(`[term-host] listening ${r.sockPath} (pid=${process.pid})`);
    // 클라이언트 0이어도 상주. killServer op 로만 종료(설계 계약 1 내구성 조항).
    // SIGTERM/SIGINT 은 저널 flush 후 종료(세션은 자식이라 함께 죽는다 — 크래시 복원은 respawn).
    const bye = () => { try { server.stop(); } catch (_) { /* noop */ } process.exit(0); };
    process.on('SIGTERM', bye);
    process.on('SIGINT', bye);
    return;
  }

  if (cmd === 'kill-server') {
    try { await oneShot('killServer'); console.log('[term-host] killServer 전송 완료'); }
    catch (_) { console.log('[term-host] 실행 중인 호스트가 없습니다'); }
    return;
  }

  if (cmd === 'status') {
    try { console.log(JSON.stringify(await oneShot('ping'), null, 2)); }
    catch (_) { console.log(JSON.stringify({ running: false })); process.exitCode = 1; }
    return;
  }

  console.error(`사용법: term-host <run|kill-server|status> (알 수 없는 명령: ${cmd})`);
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => { console.error('[term-host] 치명 오류:', (e && e.message) || e); process.exit(1); });
}

module.exports = { TermHostServer, paths };
