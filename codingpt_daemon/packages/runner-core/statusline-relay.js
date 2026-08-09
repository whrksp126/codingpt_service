// statusline-relay — claude `statusLine` 훅의 **중계기**. claude 가 상태가 바뀔 때마다 실행한다.
//
// 하는 일 두 가지, 순서가 중요하다:
//  ① 사용자가 원래 쓰던 statusLine 명령을 **그대로 실행**하고 그 stdout 을 그대로 내보낸다
//     → 터미널 아래 줄은 한 글자도 안 바뀐다. statusLine 슬롯이 1개뿐이라 우리가 차지하는 대신
//       체인하는 것이다(사용자 확정 2026-08-03: "터미널 화면은 그대로").
//  ② 같은 stdin JSON 사본을 데몬 소켓에 던진다(fire-and-forget) → 채팅 UI 의 상태 표시가 된다.
//
// 규율:
//  · ①이 정본이다. ②가 실패해도 ①은 반드시 나가야 한다(데몬이 죽어 있어도 사용자 화면 무손상).
//  · 사용자 명령은 **매번 다시 읽는다**(캐시 금지) — 사용자가 settings.json 을 고치면 즉시 따라야 한다.
//  · 우리가 아무것도 못 찾으면 **아무것도 출력하지 않는다** = statusLine 미설정과 같은 화면.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const SOCKET_TIMEOUT_MS = 400;   // 보고는 화면을 절대 붙잡지 않는다

/** 사용자가 설정한 statusLine 명령을 찾는다. 우선순위 = 프로젝트 local > 프로젝트 > 홈 local > 홈. */
function userStatusLine(cwd) {
  const files = [
    path.join(cwd || process.cwd(), '.claude', 'settings.local.json'),
    path.join(cwd || process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    const sl = j && j.statusLine;
    // ⚠ 우리 자신을 다시 부르지 않는다(무한 재귀 방지) — 사용자가 우리 래퍼 경로를 자기 설정에
    //  복사해 둔 경우가 있을 수 있다.
    if (sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command
      && !/cpt-statusline/.test(sl.command)) return sl.command;
  }
  return null;
}

/** 보고할 소켓 경로 — 단일 출처(sock-path.js). CPT_SOCK 은 테스트/비표준 stateDir 용 탈출구(우선). */
function sockPath() {
  return require('./sock-path').clientSockPath();
}

/** 데몬에 한 줄 보고(응답을 기다리지 않는다). 실패는 전부 무시한다. */
function report(payload, rendered, done) {
  let finished = false;
  const end = () => { if (!finished) { finished = true; done(); } };
  let sock;
  try {
    sock = net.connect(sockPath(), () => {
      try { sock.write(JSON.stringify({ cmd: 'status.report', args: { payload, ...(rendered ? { rendered } : {}) } }) + '\n'); } catch (_) { /* noop */ }
      // 응답은 필요 없다 — 쓰기만 하고 끊는다.
      try { sock.end(); } catch (_) { /* noop */ }
      end();
    });
  } catch (_) { end(); return; }
  sock.setTimeout(SOCKET_TIMEOUT_MS, () => { try { sock.destroy(); } catch (_) { /* noop */ } end(); });
  sock.on('error', end);
  sock.on('close', end);
}

// 사용자 줄 사본 상한 — 채팅에 미러할 한 줄이면 충분하다(폭주 방어).
const RENDER_CAP = 4096;

/**
 * 사용자 명령을 같은 stdin 으로 실행하고 stdout 을 **그대로 흘려 보내면서 사본을 뜬다**.
 *
 * ★ 사본을 뜨는 이유(2026-08-04 사용자 지적): 채팅에 우리가 고른 항목(7일 한도 등)을 그리고 있었는데,
 *  사용자가 statusline 에 설정해 둔 내용과 달랐다. "설정한 콘텐츠에 맞게" 가 맞다 — 그리고 그 콘텐츠의
 *  정본은 **이 스크립트의 출력** 그 자체다(우리가 스크립트를 해석할 수는 없다).
 *  ⚠ 통과가 먼저다: 청크가 오는 즉시 stdout 에 쓰고, 사본은 곁다리로만 모은다(화면 지연 0).
 */
function chain(cmd, raw, done) {
  if (!cmd) { done(''); return; }
  let ch;
  try {
    // 사용자 statusLine 명령은 "셸 한 줄"이다 — darwin/linux 는 /bin/sh(기존 그대로), win32 는 cmd /c.
    ch = process.platform === 'win32'
      ? spawn(process.env.comspec || process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', cmd],
        { stdio: ['pipe', 'pipe', 'inherit'], windowsVerbatimArguments: true, windowsHide: true })
      : spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'inherit'] });
  } catch (_) { done(''); return; }
  let buf = '';
  ch.stdout.on('data', (d) => {
    try { process.stdout.write(d); } catch (_) { /* 파이프가 닫혔다 */ }
    if (buf.length < RENDER_CAP) buf += d.toString('utf8');
  });
  ch.on('error', () => done(''));
  ch.on('close', () => done(buf.slice(0, RENDER_CAP)));
  try { ch.stdin.end(raw); } catch (_) { /* 자식이 stdin 을 안 읽었다 — 무해 */ }
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(raw); } catch (_) { /* 형식이 바뀌었다 — 체인만 한다 */ }
    const cmd = userStatusLine(payload && payload.cwd);
    // 보고는 **사용자 줄이 나온 뒤** 보낸다(그 사본을 함께 싣기 위해). 화면 출력은 이미 흘러갔다.
    chain(cmd, raw, (rendered) => {
      if (payload) report(payload, rendered, () => process.exit(0));
      else process.exit(0);
    });
    // 어떤 이유로든 매달리지 않게 하드 상한(사용자 스크립트가 hang 해도 claude 는 타임아웃을 갖지만
    //  우리가 그 위에 또 매달릴 이유는 없다).
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

if (require.main === module) main();
module.exports = { userStatusLine, _main: main };
