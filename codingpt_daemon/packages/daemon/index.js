#!/usr/bin/env node
/**
 * CodingPT PC 에이전트(데몬) CLI
 *
 *   node index.js pair [--server <URL>]   앱에서 발급한 페어링 코드로 이 PC 를 계정에 연결
 *   node index.js run                     데몬 실행(서버와 상시 연결, 터미널 릴레이)
 *   node index.js setup                   초기 세팅 도우미(권장 폴더 생성 + macOS 권한 안내)
 *   node index.js status                  페어링/설정 상태 출력
 *   node index.js unpair                  로컬 설정 삭제(서버 revoke 는 앱에서)
 *
 * 이 프로그램은 어떤 AI 자격증명도 다루지 않는다 — 터미널/파일 릴레이 전용.
 */
const os = require('os');
const readline = require('readline');
const runnerCore = require('@codingpt/runner-core');
const configLib = runnerCore.config;
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
  // 데스크톱 앱(GUI)/스크립트용 비대화형 경로: --code 로 코드를 직접 넘기면 프롬프트 없이 진행.
  const codeArg = argValue('--code');
  let code;
  if (codeArg) {
    code = codeArg.trim().toUpperCase();
  } else {
    console.log('앱의 [마이페이지 → 내 PC 연결] 에서 페어링 코드를 발급하세요.');
    code = (await ask('페어링 코드 입력 (예: ABCD-2345): ')).trim().toUpperCase();
  }
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

// ── QR 페어링(넷플릭스 방식) — PC가 세션을 열고 QR 표시, 로그인된 앱이 스캔·승인 ──
// 1단계: 세션 생성 → QR 용 code/deepLink 를 stdout(JSON) 으로 반환. sessionSecret 은 이 PC 만 보관.
async function cmdPairSession() {
  const serverUrl = (argValue('--server') || DEFAULT_SERVER).replace(/\/+$/, '');
  const res = await fetch(`${serverUrl}/api/daemon/pair/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceName: os.hostname().replace(/\.local$/, ''),
      platform: process.platform,
      daemonVersion: pkg.version,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { process.stdout.write(JSON.stringify({ error: body.message || String(res.status) })); process.exit(1); }
  process.stdout.write(JSON.stringify(body)); // { code, sessionSecret, deepLink, expiresAt }
}

// 2단계(폴링 1회): code/secret 으로 claim. 아직이면 {pending:true}, 승인되면 config 저장 후 {paired,deviceId}.
//  폴링 루프는 프론트(GUI)가 담당 — 각 호출은 one-shot(기존 pair 아키텍처와 동일).
async function cmdPairClaim() {
  const serverUrl = (argValue('--server') || DEFAULT_SERVER).replace(/\/+$/, '');
  const code = (argValue('--code') || '').trim().toUpperCase();
  const secret = argValue('--secret') || '';
  if (!code || !secret) { process.stdout.write(JSON.stringify({ error: 'code/secret 누락' })); process.exit(1); }
  const res = await fetch(`${serverUrl}/api/daemon/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, sessionSecret: secret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { process.stdout.write(JSON.stringify({ error: body.message || String(res.status) })); process.exit(1); }
  if (body.pending) { process.stdout.write(JSON.stringify({ pending: true })); return; }
  const { deviceId, deviceToken } = body;
  configLib.save({
    serverUrl,
    deviceId,
    deviceToken,
    deviceName: os.hostname().replace(/\.local$/, ''),
  });
  process.stdout.write(JSON.stringify({ paired: true, deviceId }));
}

function cmdRun() {
  const config = configLib.load();
  if (!config || !config.deviceToken) {
    console.error('페어링이 필요합니다: node index.js pair --server <URL>');
    process.exit(1);
  }
  console.log(`CodingPT 데몬 v${pkg.version} — ${config.deviceName} → ${config.serverUrl}`);
  console.log(`로컬에서 같은 터미널 보기: tmux -L codingpt attach -t codingpt`);
  runnerCore.control.run({ ...config, daemonVersion: pkg.version });
}

function cmdStatus() {
  const config = configLib.load();
  if (!config) { console.log(`페어링 안 됨 (설정 파일 없음: ${configLib.configFile()})`); return; }
  console.log(`서버:     ${config.serverUrl}`);
  console.log(`deviceId: ${config.deviceId}`);
  console.log(`기기명:   ${config.deviceName}`);
  const tmux = runnerCore.pty.findTmux();
  console.log(`tmux:     ${tmux || '❌ 미설치 (brew install tmux)'}`);
}

function cmdUnpair() {
  if (configLib.remove()) console.log('로컬 설정을 삭제했습니다. (서버측 기기 해제는 앱에서)');
  else console.log('삭제할 설정이 없습니다.');
}

// 초기 세팅 도우미 — 권장 워크스페이스 폴더 생성 + macOS 권한(전체 디스크 접근) 안내/설정창 열기.
//  목적: 외부에서 모바일로 작업할 때 macOS 폴더 접근 프롬프트가 안 뜨도록 초기에 한 번 정리.
function cmdSetup() {
  const path = require('path');
  const fs = require('fs');
  const { execFile } = require('child_process');
  const wsLib = runnerCore.workspace;
  const dir = path.join(os.homedir(), wsLib.DEFAULT_ROOT_REL);
  try { fs.mkdirSync(dir, { recursive: true }); console.log(`✅ 권장 워크스페이스 폴더: ${dir}`); }
  catch (e) { console.error(`폴더 생성 실패: ${e.message}`); }
  console.log('   → 여기에 워크스페이스를 만들면 macOS 폴더 접근 프롬프트가 뜨지 않습니다(보호폴더 밖).');
  console.log('');
  console.log('📂 (선택) 어디서든 파일 접근 프롬프트를 아예 없애려면 — 지금 이 터미널 앱에 "전체 디스크 접근"을 켜세요:');
  console.log('   시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 → (터미널/iTerm 등) 켜기 → 터미널 재시작');
  console.log('   설정창을 엽니다…');
  if (process.platform === 'darwin') {
    execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], () => {});
  }
  console.log('');
  const tmux = runnerCore.pty.findTmux();
  console.log(`tmux: ${tmux || '❌ 미설치 → brew install tmux'}`);
  const cfg = configLib.load();
  console.log(`페어링: ${cfg && cfg.deviceToken ? '✅ 완료' : '❌ 아직 → node index.js pair --server <URL>'}`);
}

const cmd = process.argv[2];
(async () => {
  switch (cmd) {
    case 'pair': await cmdPair(); break;
    case 'pair-session': await cmdPairSession(); break;
    case 'pair-claim': await cmdPairClaim(); break;
    case 'run': cmdRun(); break;
    case 'status': cmdStatus(); break;
    case 'setup': cmdSetup(); break;
    case 'unpair': cmdUnpair(); break;
    default:
      console.log(`CodingPT PC 에이전트 v${pkg.version}`);
      console.log('사용법: node index.js <pair [--server URL] | run | status | setup | unpair>');
      process.exit(cmd ? 1 : 0);
  }
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
