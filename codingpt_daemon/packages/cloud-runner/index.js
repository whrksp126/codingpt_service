#!/usr/bin/env node
/**
 * CodingPT 클라우드 러너 부트스트랩 (M5 Slice0-C)
 *
 * 격리 컨테이너 안에서 runner-core 를 구동한다. 로컬 데몬(@codingpt/daemon)과 **같은 계약 구현**을
 * 쓰되, 페어링 CLI·홈 경로 대신 **env 로 주입된 설정**으로 부팅하고 back 으로 아웃바운드 연결한다
 * (인바운드 포트 0 — 데몬과 동일). back 이 컨테이너 기동 시 아래 env 를 주입한다(무인 페어링, Slice1).
 *
 *   RUNNER_SERVER_URL   릴레이(back) URL — 아웃바운드 대상. 필수.
 *   RUNNER_TOKEN        deviceToken(서버가 발급·주입). 필수. (컨테이너 안에만 존재)
 *   RUNNER_DEVICE_NAME  표시용 이름(기본 hostname)
 *   RUNNER_ROOT         fs jail 루트(기본 /workspace) — 사용자 코드/워크스페이스
 *   RUNNER_STATE_DIR    우리 상태(sessions/checkpoint tmp) 볼륨(기본 /var/lib/codingpt)
 *   CLAUDE_CONFIG_DIR   사용자 claude 크레덴셜/대화로그(~/.claude). 기본 $HOME/.claude.
 *                       (사용자가 컨테이너 터미널에서 직접 로그인 — BYO. 우리는 크레덴셜 무접촉.)
 *
 * 경계(ToS): 이 컨테이너는 "사용자 소유 공간"이다. claude 는 사용자 자신의 구독으로 컨테이너에서
 * 돌고, 크레덴셜은 이 컨테이너 CLAUDE_CONFIG_DIR 에만 존재한다. 릴레이로 전송하지 않는다.
 */
const os = require('os');
const path = require('path');
const { runtime, control } = require('@codingpt/runner-core');
const pkg = require('./package.json');

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`[cloud-runner] 필수 환경변수 누락: ${name}`); process.exit(1); }
  return v;
}

function main() {
  const serverUrl = required('RUNNER_SERVER_URL').replace(/\/+$/, '');
  const deviceToken = required('RUNNER_TOKEN');
  const deviceName = process.env.RUNNER_DEVICE_NAME || os.hostname();

  const root = process.env.RUNNER_ROOT || '/workspace';
  const stateDir = process.env.RUNNER_STATE_DIR || '/var/lib/codingpt';
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

  // 경로 루트/상태/클로드 홈을 컨테이너 기준으로 주입(지연 getter라 이후 lib 가 이 값을 읽는다).
  runtime.init({ root, stateDir, claudeHome, platform: process.platform });

  console.log(`CodingPT 클라우드 러너 v${pkg.version} — ${deviceName} → ${serverUrl}`);
  console.log(`  root=${root} state=${stateDir} claudeHome=${claudeHome} platform=${process.platform}`);

  // 데몬과 동일한 control.run — clientType:'cloud' 로 아웃바운드 연결(릴레이가 러너 종류로 라우팅).
  control.run({ serverUrl, deviceToken, deviceName, daemonVersion: pkg.version, clientType: 'cloud' });
}

main();
