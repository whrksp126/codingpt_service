// Windows 포팅(워크스트림 D) 유닛 — 플랫폼 중립 로직을 mac 에서 검증한다.
//
// 계약(docs/windows-port/design.md):
//  · 계약 2: cpt 소켓 → named pipe(sock-path.js 단일 출처, 3벌 복제 통합)
//  · 계약 4: shim win32(ps 프로필·cmd 래퍼·PATHEXT 탐색·.cmd 스폰 셔틀)
//  · §D-4: lsof → Get-NetTCPConnection / ps → Get-CimInstance 병렬 파서(고정 샘플로 검증)
// darwin 경로 무회귀는 기존 테스트 전체가 담보하고, 여기서는 win32 분기와 공용 헬퍼만 본다.
process.env.CPT_SHIM_NO_GLOBAL_LINK = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-winport-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const sockPath = require('../sock-path');
const agents = require('../agents');
const spawnUtil = require('../spawn-util');
const shim = require('../shim');
const proxy = require('../proxy');
const wrapper = require('../win-agent-wrapper');

// ── 계약 2: sock-path ────────────────────────────────────────────────────────

test('sock-path: darwin 은 기존 규칙 그대로 — <stateDir>/cpt.sock', () => {
  const dir = '/Users/u/.codingpt';
  // 기대값은 POSIX 조인 — win32 호스트에서 darwin 규칙을 검증할 때 path.join 은 '\\' 를 섞는다
  //  (제품은 path.posix 고정이라 어느 호스트에서든 이 값이 정답이다).
  assert.strictEqual(sockPath.serverSockPath(dir, 'darwin'), dir + '/cpt.sock');
});

test('sock-path: darwin sun_path 한계(104B) 초과 시 /tmp 짧은 폴백(기존 규칙 보존)', () => {
  const dir = '/Users/' + 'x'.repeat(120) + '/.codingpt';
  const p = sockPath.serverSockPath(dir, 'darwin');
  assert.ok(p.startsWith('/tmp/cpt-'), `짧은 폴백이 아니다: ${p}`);
  assert.ok(Buffer.byteLength(p) <= 100, 'sun_path 한계 초과 — 커널이 조용히 잘라 유령 소켓이 된다');
});

test('sock-path: win32 기본 stateDir = \\\\.\\pipe\\codingpt-cpt-<sha8(homedir)> (계약 2 이름 그대로)', () => {
  const p = sockPath.serverSockPath(undefined, 'win32');
  assert.match(p, /^\\\\\.\\pipe\\codingpt-cpt-[0-9a-f]{8}$/);
  assert.strictEqual(p, '\\\\.\\pipe\\codingpt-cpt-' + sockPath._sha8(os.homedir()));
});

test('sock-path: win32 비표준 stateDir 는 다른 파이프 이름(전역 네임스페이스 충돌 방지)', () => {
  const a = sockPath.serverSockPath(undefined, 'win32');
  const b = sockPath.serverSockPath('/tmp/cpt-test-other-state', 'win32');
  assert.notStrictEqual(a, b, '테스트/클라우드 인스턴스가 실데몬 파이프와 충돌한다');
  assert.match(b, /^\\\\\.\\pipe\\codingpt-cpt-[0-9a-f]{8}$/);
});

test('sock-path: 승인 소켓 — win32 파이프 / posix tmpdir 소켓', () => {
  assert.strictEqual(sockPath.approvalSockPath(123, 'win32'), '\\\\.\\pipe\\cpt-approval-123');
  assert.strictEqual(sockPath.approvalSockPath(123, 'darwin'), path.join(os.tmpdir(), 'cpt-approval-123.sock'));
});

test('sock-path: isPipePath 판정 + CPT_SOCK env 우선(clientSockPath)', () => {
  assert.ok(sockPath.isPipePath('\\\\.\\pipe\\codingpt-cpt-deadbeef'));
  assert.ok(sockPath.isPipePath('\\\\?\\pipe\\x'));
  assert.ok(!sockPath.isPipePath('/Users/u/.codingpt/cpt.sock'));
  const prev = process.env.CPT_SOCK;
  process.env.CPT_SOCK = '\\\\.\\pipe\\override';
  try { assert.strictEqual(sockPath.clientSockPath('win32'), '\\\\.\\pipe\\override'); }
  finally { if (prev === undefined) delete process.env.CPT_SOCK; else process.env.CPT_SOCK = prev; }
});

// ── 계약 4: PATHEXT 바이너리 탐색(agents.findBin win 분기) ────────────────────

test('findBin(win): PATHEXT 확장자 매칭 — X_OK 대신 .exe/.cmd 존재로 판정', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-pathext-'));
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\n'); // 실행 비트 없음(win 관례)
  const { findBin } = agents._internals;
  assert.strictEqual(findBin('claude', [dir], { win: true, pathext: ['.EXE', '.CMD'] }), path.join(dir, 'claude.cmd'));
  // PATHEXT 순서 존중 — .EXE 가 먼저면 exe 가 이긴다(cmd.exe 탐색 의미론)
  fs.writeFileSync(path.join(dir, 'claude.exe'), 'MZ');
  assert.strictEqual(findBin('claude', [dir], { win: true, pathext: ['.EXE', '.CMD'] }), path.join(dir, 'claude.exe'));
  // 확장자를 이미 가진 이름은 그대로 조회
  assert.strictEqual(findBin('claude.cmd', [dir], { win: true }), path.join(dir, 'claude.cmd'));
  // posix 판정은 기존 그대로(X_OK) — 실행 비트 없는 .cmd 만 있으면 못 찾는다(무회귀)
  assert.strictEqual(findBin('claude', [dir], { win: false }), null);
});

test('winFallbackDirs: npm 전역·WinGet Links·~/.local/bin 포함(계약 §D-3)', () => {
  const dirs = agents._internals.winFallbackDirs();
  assert.ok(dirs.some((d) => /[\\/]npm$/.test(d)), 'npm 전역 prefix 누락');
  assert.ok(dirs.some((d) => /WinGet[\\/]Links$/.test(d)), 'winget Links 누락');
  assert.ok(dirs.some((d) => /[\\/]\.local[\\/]bin$/.test(d)), 'claude 공식 인스톨러 위치 누락');
});

// ── 계약 4: .cmd 스폰 셔틀(spawn-util) ───────────────────────────────────────

test('needsCmdShell: win32 의 .cmd/.bat 만 — darwin 은 항상 false(무회귀)', () => {
  assert.ok(spawnUtil.needsCmdShell('C:\\x\\claude.CMD', 'win32'));
  assert.ok(spawnUtil.needsCmdShell('C:\\x\\a.bat', 'win32'));
  assert.ok(!spawnUtil.needsCmdShell('C:\\x\\claude.exe', 'win32'));
  assert.ok(!spawnUtil.needsCmdShell('/usr/local/bin/claude', 'darwin'));
  assert.ok(!spawnUtil.needsCmdShell('/x/claude.cmd', 'darwin'), 'darwin 에서 cmd.exe 경유는 회귀다');
});

test('cmdQuote: 통제된 인자 인용 규칙', () => {
  const q = spawnUtil._cmdQuote;
  assert.strictEqual(q('--version'), '--version');
  assert.strictEqual(q('C:\\Program Files\\x.cmd'), '"C:\\Program Files\\x.cmd"');
  assert.strictEqual(q('a"b'), '"a\\"b"');
  assert.strictEqual(q(''), '""');
});

test('ptyCommand: 비-win 경로는 무변형 통과', () => {
  assert.deepStrictEqual(spawnUtil.ptyCommand('/usr/local/bin/claude', ['-p']), { file: '/usr/local/bin/claude', args: ['-p'] });
});

// ── 계약 4: PowerShell 인용·프로필·훅 명령 ───────────────────────────────────

test('psQuote: 단일 인용 — 내부 \' 는 \'\' 로', () => {
  const { psQuote } = shim._win;
  assert.strictEqual(psQuote('C:\\bin'), "'C:\\bin'");
  assert.strictEqual(psQuote("C:\\Users\\O'Neil"), "'C:\\Users\\O''Neil'");
});

test('winHookCommand: 3셸(PowerShell·Git Bash·cmd) 교집합 형태', () => {
  const c = shim._win.winHookCommand('X:\\bin\\cpt.cmd claude-hook stop');
  assert.match(c, /^cmd\.exe \/d \/s \/c "[^"]*"$/, '첫 토큰 무인용 + 내부는 큰따옴표 1쌍이어야 3셸에서 동일 파싱된다');
});

test('buildPsProfile: $PROFILE dot-source → PATH prepend → 함수 3종(계약 4 순서)', () => {
  const p = shim._win.buildPsProfile('C:\\Users\\u\\.codingpt\\bin');
  const iProfile = p.indexOf('Test-Path $PROFILE');
  const iPath = p.indexOf('$env:Path =');
  const iFn = p.indexOf('function global:claude');
  assert.ok(iProfile >= 0 && iPath > iProfile && iFn > iPath, '순서: 사용자 프로필 → PATH → 함수');
  assert.ok(p.includes('function global:codex'));
  assert.ok(p.includes('function global:cpt'));
  assert.ok(p.includes('_cptPassthru'), '래퍼 부재 시 원본 재탐색 폴백(zsh _cpt_passthru 등가)이 필요하다');
  assert.ok(p.includes("'C:\\Users\\u\\.codingpt\\bin;'"), 'PATH prepend 가 단일 인용으로 안전해야 한다');
});

// ── 계약 4: win32 shim 생성물 전체(mac 에서 직접 호출) ────────────────────────

test('ensureShimsWin32: 파일 세트·훅 7종·미설치 래퍼 미생성', () => {
  agents._internals.setSearchOverride([]); // 이 머신의 설치 상태와 무관하게 "아무것도 없음"
  try {
    const r = shim._win.ensureShimsWin32();
    const st = runtime.stateDir();
    assert.ok(fs.existsSync(path.join(st, 'bin', 'cpt.cmd')));
    assert.ok(fs.existsSync(path.join(st, 'bin', 'cpt-statusline.cmd')));
    assert.ok(fs.existsSync(path.join(st, 'shim', 'ps', 'cpt-profile.ps1')));
    assert.ok(fs.existsSync(path.join(st, 'shim', 'cmd', 'cpt-init.cmd')));
    assert.ok(!fs.existsSync(path.join(st, 'bin', 'claude.cmd')), '미설치 에이전트의 래퍼를 만들면 command not found 를 가로챈다');
    assert.ok(!fs.existsSync(path.join(st, 'bin', 'codex.cmd')));
    assert.deepStrictEqual(r.skipped.sort(), ['claude', 'codex']);
    const hooks = JSON.parse(fs.readFileSync(r.hooksFile, 'utf8'));
    assert.deepStrictEqual(Object.keys(hooks.hooks).sort(),
      ['Notification', 'PermissionRequest', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'UserPromptSubmit'],
      'darwin 과 같은 훅 7종이어야 한다(축소 모델 금지)');
    for (const [ev, arr] of Object.entries(hooks.hooks)) {
      const cmd = arr[0].hooks[0].command;
      assert.match(cmd, /^cmd\.exe \/d \/s \/c "/, `${ev} 훅 명령이 win32 문법이 아니다: ${cmd}`);
    }
    assert.match(hooks.statusLine.command, /cpt-statusline\.cmd/);
    // cpt.cmd 는 데몬 node 절대경로로 CLI 를 실행한다(터미널 PATH 에 node 불요)
    const cptCmd = fs.readFileSync(path.join(st, 'bin', 'cpt.cmd'), 'utf8');
    assert.ok(cptCmd.includes(process.execPath) && cptCmd.includes('%*'));
  } finally {
    agents._internals.setSearchOverride(null);
  }
});

test('ensureShimsWin32: 설치+배선 ON 이면 래퍼 생성(wired) — node 위임 본문', () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-winbin-'));
  // 감지는 **호스트 플랫폼 판정**으로 돈다 — darwin 은 실행 비트 있는 맨 이름, win32(실 CI)는
  //  PATHEXT 확장자(.cmd)로 설치를 흉내내야 findBin 이 잡는다(안 그러면 wired 가 비어 거짓 실패).
  if (process.platform === 'win32') fs.writeFileSync(path.join(fakeDir, 'claude.cmd'), '@echo off\r\n');
  else fs.writeFileSync(path.join(fakeDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  agents._internals.setSearchOverride([fakeDir]);
  try {
    const r = shim._win.ensureShimsWin32();
    assert.ok(r.wired.includes('claude'));
    const st = runtime.stateDir();
    const w = fs.readFileSync(path.join(st, 'bin', 'claude.cmd'), 'utf8');
    assert.ok(w.includes('win-agent-wrapper.js') && w.includes('claude %*'), '래퍼 로직은 배치가 아니라 node 에 있어야 한다');
    assert.ok(!fs.existsSync(path.join(st, 'bin', 'codex.cmd')), 'codex 는 미설치 — 래퍼 없음');
  } finally {
    agents._internals.setSearchOverride(null);
  }
});

// ── win 래퍼 인자 규칙(win-agent-wrapper) — darwin sh 래퍼와 1:1 등가 ─────────

test('win 래퍼: 훅 주입·무간섭 통과·CPT_HOOKS_DISABLED', () => {
  const b = wrapper._buildArgs;
  assert.strictEqual(b('claude', ['-p'])[0], '--settings', '기본은 훅 설정 주입');
  assert.deepStrictEqual(b('claude', ['--settings', 'x.json']), ['--settings', 'x.json'], '사용자 --settings 는 무간섭 통과');
  const c = b('codex', []);
  assert.strictEqual(c[0], '-c');
  assert.match(c[1], /^notify=\[".*cpt\.cmd","codex-notify"\]$/);
  assert.deepStrictEqual(b('codex', ['-c', 'notify=[]']), ['-c', 'notify=[]'], '사용자 notify 는 무간섭 통과');
  process.env.CPT_HOOKS_DISABLED = '1';
  try {
    assert.deepStrictEqual(b('claude', ['-p']), ['-p']);
    assert.deepStrictEqual(b('codex', []), []);
  } finally { delete process.env.CPT_HOOKS_DISABLED; }
});

// ── §D-4: Get-NetTCPConnection 파서(고정 샘플) ───────────────────────────────

test('parseWinListenRows: 배열 샘플 — 로컬 바인딩·dev 포트대·IGNORE 규칙(lsof 파서와 동일)', () => {
  const sample = JSON.stringify([
    { address: '0.0.0.0', port: 3000, pid: 100, command: 'node' },
    { address: '127.0.0.1', port: 5300, pid: 101, command: 'node' },
    { address: '::', port: 8081, pid: 102, command: 'java' },
    { address: '::1', port: 3400, pid: 107, command: 'node' },
    { address: '192.168.0.5', port: 3001, pid: 103, command: 'node' },   // 외부 인터페이스 바인딩 — 제외
    { address: '127.0.0.1', port: 5432, pid: 104, command: 'postgres' }, // IGNORE_PORTS
    { address: '127.0.0.1', port: 22000, pid: 105, command: 'x' },       // dev 포트대 밖
    { address: '127.0.0.1', port: 80, pid: 106, command: 'iis' },        // 1024 이하
  ]);
  const rows = proxy._parseWinListenRows(sample);
  assert.deepStrictEqual(rows.map((r) => r.port), [3000, 5300, 8081, 3400]);
  assert.deepStrictEqual(rows[0], { pid: 100, port: 3000, command: 'node' });
});

test('parseWinListenRows: ConvertTo-Json 단건 언랩·쓰레기 입력 무해', () => {
  const one = proxy._parseWinListenRows(JSON.stringify({ address: '127.0.0.1', port: 3400, pid: 1, command: 'node' }));
  assert.deepStrictEqual(one, [{ pid: 1, port: 3400, command: 'node' }]);
  assert.deepStrictEqual(proxy._parseWinListenRows(''), []);
  assert.deepStrictEqual(proxy._parseWinListenRows('garbage not json'), []);
  assert.deepStrictEqual(proxy._parseWinListenRows('null'), []);
});

// ── §D-4: 좀비 데몬 킬러 — 프로세스 목록 파서·판정(darwin/win32 공용) ─────────

test('isDaemonEntryCmd: darwin ps 형태(기존 판정 무회귀)', () => {
  const f = require('../cpt-server')._isDaemonEntryCmd;
  assert.ok(f('/usr/local/bin/node /Applications/CodingPT.app/Contents/Resources/daemon/index.js run'));
  assert.ok(f('node packages/daemon/index.js run'));
  assert.ok(!f('grep daemon/index.js run'), 'grep 이 경로 문자열을 들고 있어도 안 잡혀야 한다');
  assert.ok(!f('/usr/local/bin/node /x/other/index.js run'));
  assert.ok(!f('node packages/daemon/index.js status'));
});

test('isDaemonEntryCmd: win32 CommandLine(따옴표·역슬래시) 판정', () => {
  const f = require('../cpt-server')._isDaemonEntryCmd;
  assert.ok(f('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u u\\AppData\\Local\\CodingPT\\daemon\\index.js" run'));
  assert.ok(f('C:\\nodejs\\node.exe C:\\cpt\\packages\\daemon\\index.js run'));
  assert.ok(!f('"C:\\x\\node.exe" "C:\\y\\daemon\\index.jsx" run'), 'index.jsx 오탐 금지');
  assert.ok(!f('"C:\\x\\code.exe" "C:\\y\\daemon\\index.js" run'), 'node 토큰 없이 잡히면 에디터를 죽인다');
});

test('parseWinProcessJson: Get-CimInstance JSON — 단건 언랩·null CommandLine·쓰레기 무해', () => {
  const p = require('../cpt-server')._parseWinProcessJson;
  assert.deepStrictEqual(
    p(JSON.stringify([{ ProcessId: 5, CommandLine: 'x' }, { ProcessId: 0, CommandLine: 'y' }, { ProcessId: 7, CommandLine: null }])),
    [{ pid: 5, cmd: 'x' }, { pid: 7, cmd: '' }]);
  assert.deepStrictEqual(p(JSON.stringify({ ProcessId: 9, CommandLine: 'z' })), [{ pid: 9, cmd: 'z' }]);
  assert.deepStrictEqual(p('garbage'), []);
});

// ── 웨이브2: term-backend win32 스폰(Job 탈출)·파이프 정규화 — 순수 함수 검증 ─────────

test('term-backend: WMI 스폰 스펙(Job 탈출) — cmd set 체인·인용·ShowWindow=0·PS 이스케이프', () => {
  const tb = require('../term-backend');
  const spec = tb._buildWmiSpawnSpec({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entry: 'C:\\Users\\Ho Lee\\CodingPT\\term-host\\index.js',
    sockPath: '\\\\.\\pipe\\cpt-termhost-deadbeef',
    stateDir: 'C:\\Users\\Ho Lee\\.codingpt',
  });
  assert.strictEqual(spec.file, 'powershell.exe');
  assert.ok(spec.args.includes('-NoProfile') && spec.args.includes('-NonInteractive'));
  const script = spec.args[spec.args.length - 1];
  // WMI 생성 = WmiPrvSE 자식 → PC 앱 Job Object 밖(계약 1: 앱 종료에도 터미널 생존).
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(script, /Win32_ProcessStartup/, '콘솔 창 무표시(ShowWindow) 스타트업 정보가 필요하다');
  assert.match(script, /ShowWindow = 0/);
  assert.match(script, /CPT_TERMHOST_PID=/, '성공 판정(폴백 분기)의 파싱 마커');
  // cmd /d /s /c — 양끝 따옴표 제거 모드에서 내부 인용 보존(공백 경로 안전).
  assert.match(spec.cmdLine, /^cmd\.exe \/d \/s \/c "/);
  assert.ok(spec.cmdLine.includes('set "CPT_TERMHOST_SOCK=\\\\.\\pipe\\cpt-termhost-deadbeef"'), 'env 는 set 체인으로 전달(WMI 는 부모 env 를 안 물려준다 — 유령 호스트 방지 필수값)');
  assert.ok(spec.cmdLine.includes('set "CODINGPT_STATE_DIR=C:\\Users\\Ho Lee\\.codingpt"'));
  assert.ok(spec.cmdLine.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ho Lee\\CodingPT\\term-host\\index.js" run'), '공백 경로는 각각 인용돼야 한다');
  // PowerShell 단일 인용 — ' 는 '' 로(경로에 아포스트로피가 있어도 스크립트가 깨지지 않는다).
  const spec2 = tb._buildWmiSpawnSpec({ nodePath: "C:\\node's\\node.exe", entry: 'e.js', sockPath: 'p', stateDir: 's' });
  assert.ok(spec2.args[spec2.args.length - 1].includes("node''s"), "PS 인용 이스케이프('')가 빠졌다");
});

test('term-host paths: win32 파이프 정규화 — 파일 경로 오버라이드는 해시 파이프로, 파이프는 통과', () => {
  const hp = require('../../term-host/lib/paths');
  const n = hp.normalizeWinPipe('C:\\Users\\u\\AppData\\Local\\Temp\\x\\backend.sock');
  assert.match(n, /^\\\\\.\\pipe\\cpt-termhost-test-[0-9a-f]{8}$/, 'win32 net.listen 은 \\\\.\\pipe\\ 밖 경로에서 실패한다');
  assert.strictEqual(hp.normalizeWinPipe(n), n, '정규화는 멱등이어야 한다');
  assert.strictEqual(hp.normalizeWinPipe('\\\\.\\pipe\\abc'), '\\\\.\\pipe\\abc');
  assert.strictEqual(hp.normalizeWinPipe('\\\\?\\pipe\\abc'), '\\\\?\\pipe\\abc');
  // 같은 입력 = 같은 파이프(클라이언트 term-backend 와 호스트가 각자 계산해도 만나야 한다).
  assert.strictEqual(hp.normalizeWinPipe('C:\\t\\a.sock'), hp.normalizeWinPipe('C:\\t\\a.sock'));
});

test('term-host session: win32 기본 셸 스펙 — 프로필 주입은 defaultShellSpec 한 곳(계약 4)', () => {
  const sess = require('../../term-host/lib/session');
  // mac 에서는 win32 분기를 직접 못 돌리지만, 계약의 형태(함수 존재·posix 무인자)는 고정한다.
  assert.strictEqual(typeof sess.defaultShellSpec, 'function');
  const spec = sess.defaultShellSpec();
  if (process.platform !== 'win32') {
    assert.deepStrictEqual(spec.args, [], 'posix 기본 셸엔 인자가 없어야 한다(darwin 무회귀)');
  } else {
    // win32(실 CI): pwsh/powershell 이면 프로필 파일이 있을 때만 -Command 주입, cmd 는 /K.
    assert.ok(spec.shell, 'win32 기본 셸 해석 실패');
  }
  // 소스 계약: 프로필 규칙이 session.js 의 defaultShellSpec 에 있다(데몬 create 와 앱 create op 이
  //  자동으로 한 벌이 되는 유일 지점 — 다른 곳으로 옮기면 두 생성 주체가 갈라진다).
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'term-host', 'lib', 'session.js'), 'utf8');
  assert.match(src, /cpt-profile\.ps1/);
  assert.match(src, /cpt-init\.cmd/);
  assert.match(src, /-NoLogo/);
});
