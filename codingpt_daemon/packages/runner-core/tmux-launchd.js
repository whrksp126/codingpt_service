'use strict';
// macOS: tmux 서버를 launchd 작업으로 띄운다(앱 코얼리션 밖).
//
// 왜: tmux 서버는 앱을 ⌘Q 로 꺼도 일부러 살려 둔다(터미널·에이전트 작업 보존 — 사용자 확정). 그런데
//  데몬(앱 자식)이 `new-session` 으로 서버를 포크하면 서버와 그 아래 셸·에이전트 전부가 **앱의 코얼리션**에
//  남는다. macOS 는 코얼리션에 살아 있는 프로세스가 있으면 Dock 에 "백그라운드에서 실행 중" 을 띄운다
//  (2026-10-24 신고 — `lsappinfo list` 의 relatedCoalitionPIDs 에 tmux 서버·claude 들이 그대로 보였다).
//  launchd 가 띄운 프로세스는 자기 코얼리션을 가지므로, 서버를 launchd 로 먼저 띄워 두면 이후 모든
//  tmux 명령은 그 서버에 붙기만 한다.
//
// 규율:
//  · `tmux -D` = 데몬화하지 않고 전경에서 서버만 돈다(launchd 용). exit-empty 도 꺼진다 — 세션이 0개여도
//    서버가 남아 다음 터미널이 같은 코얼리션 밖 서버에 붙는다.
//  · 서버 환경 = 데몬이 tmux 에 넘기던 tmuxEnv() 그대로(plist EnvironmentVariables). 첫 셸의 PATH·LANG 이
//    종전과 같아야 한다 — launchd 기본 env(/usr/bin:/bin) 로 띄우면 셸이 조용히 달라진다.
//    plist 는 env 를 담으므로 0600.
//  · 실패해도 조용히 넘어간다 — 그러면 종전처럼 new-session 이 서버를 포크한다(동작은 같고 Dock 표시만 남음).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const LABEL_PREFIX = 'com.ghmate.codingpt.tmux.';

function sh(cmd, args, env, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function plistFor(label, argv, env) {
  const envXml = Object.entries(env)
    .filter(([k, v]) => k && typeof v === 'string' && !/[\0]/.test(k + v))
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

let inflight = null;

/**
 * 서버가 없으면 launchd 로 띄우고 소켓이 응답할 때까지(최대 ~2초) 기다린다. 이미 있으면 즉시 끝.
 * @param {{tmux:string, socket:string, confArgs:string[], env:object}} o
 */
function ensureServer(o) {
  //  격리 소켓(테스트·멀티 인스턴스 — CODINGPT_TMUX_SOCKET)은 launchd 에 작업을 남기지 않는다. 앱 실사용 소켓만.
  if (process.platform !== 'darwin' || process.env.CODINGPT_TMUX_LAUNCHD === '0' || process.env.CODINGPT_TMUX_SOCKET) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = (async () => {
    const alive = async () => (await sh(o.tmux, ['-L', o.socket, 'list-sessions', '-F', '#{session_name}'], o.env)).ok
      || (await sh(o.tmux, ['-L', o.socket, 'show-options', '-g', 'exit-empty'], o.env)).ok;
    if (await alive()) return true;
    const uid = process.getuid();
    const label = LABEL_PREFIX + o.socket.replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(os.homedir(), '.codingpt', 'launchd');
    const file = path.join(dir, label + '.plist');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, plistFor(label, [o.tmux, '-L', o.socket, ...(o.confArgs || []), '-D'], o.env), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch (_) { return false; }
    // 지난번 작업이 (서버가 죽은 채) 등록만 남아 있으면 bootstrap 이 거절한다 → 먼저 내린다.
    await sh('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], o.env);
    const r = await sh('/bin/launchctl', ['bootstrap', `gui/${uid}`, file], o.env);
    if (!r.ok) return false;
    for (let i = 0; i < 20; i++) {
      if (await alive()) return true;
      await new Promise((res) => setTimeout(res, 100));
    }
    return false;
  })().catch(() => false).finally(() => { setTimeout(() => { inflight = null; }, 0); });
  return inflight;
}

module.exports = { ensureServer, plistFor, LABEL_PREFIX };
