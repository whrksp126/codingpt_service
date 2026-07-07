#!/usr/bin/env node
/**
 * CodingPT PC 에이전트(데몬) CLI
 *
 *   node index.js pair [--server <URL>]   앱에서 발급한 페어링 코드로 이 PC 를 계정에 연결
 *   node index.js run                     데몬 실행(서버와 상시 연결, 터미널 릴레이)
 *   node index.js status                  페어링/설정 상태 출력
 *   node index.js unpair                  로컬 설정 삭제(서버 revoke 는 앱에서)
 *
 * 이 프로그램은 어떤 AI 자격증명도 다루지 않는다 — 터미널/파일 릴레이 전용.
 */
const os = require('os');
const readline = require('readline');
const configLib = require('./lib/config');
const pkg = require('./package.json');

const DEFAULT_SERVER = 'https://codingpt-back.ghmate.com';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function cmdPair() {
  const serverUrl = (argValue('--server') || DEFAULT_SERVER).replace(/\/+$/, '');
  console.log(`서버: ${serverUrl}`);
  console.log('앱의 [마이페이지 → 내 PC 연결] 에서 페어링 코드를 발급하세요.');
  const code = (await ask('페어링 코드 입력 (예: ABCD-2345): ')).trim().toUpperCase();
  if (!code) { console.error('코드가 입력되지 않았습니다.'); process.exit(1); }

  const res = await fetch(`${serverUrl}/api/daemon/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName: os.hostname().replace(/\.local$/, ''),
      platform: process.platform,
      daemonVersion: pkg.version,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`페어링 실패: ${body.message || res.status}`);
    process.exit(1);
  }
  const { deviceId, deviceToken } = body;
  const file = configLib.save({
    serverUrl,
    deviceId,
    deviceToken,
    deviceName: os.hostname().replace(/\.local$/, ''),
  });
  console.log(`✅ 페어링 완료 (deviceId=${deviceId})`);
  console.log(`설정 저장: ${file}`);
  console.log('이제 `npm start` (또는 node index.js run) 으로 데몬을 실행하세요.');
}

function cmdRun() {
  const config = configLib.load();
  if (!config || !config.deviceToken) {
    console.error('페어링이 필요합니다: node index.js pair --server <URL>');
    process.exit(1);
  }
  console.log(`CodingPT 데몬 v${pkg.version} — ${config.deviceName} → ${config.serverUrl}`);
  console.log(`로컬에서 같은 터미널 보기: tmux -L codingpt attach -t codingpt`);
  require('./lib/control').run(config);
}

function cmdStatus() {
  const config = configLib.load();
  if (!config) { console.log(`페어링 안 됨 (설정 파일 없음: ${configLib.CONFIG_FILE})`); return; }
  console.log(`서버:     ${config.serverUrl}`);
  console.log(`deviceId: ${config.deviceId}`);
  console.log(`기기명:   ${config.deviceName}`);
  const tmux = require('./lib/pty').findTmux();
  console.log(`tmux:     ${tmux || '❌ 미설치 (brew install tmux)'}`);
}

function cmdUnpair() {
  if (configLib.remove()) console.log('로컬 설정을 삭제했습니다. (서버측 기기 해제는 앱에서)');
  else console.log('삭제할 설정이 없습니다.');
}

const cmd = process.argv[2];
(async () => {
  switch (cmd) {
    case 'pair': await cmdPair(); break;
    case 'run': cmdRun(); break;
    case 'status': cmdStatus(); break;
    case 'unpair': cmdUnpair(); break;
    default:
      console.log(`CodingPT PC 에이전트 v${pkg.version}`);
      console.log('사용법: node index.js <pair [--server URL] | run | status | unpair>');
      process.exit(cmd ? 1 : 0);
  }
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
