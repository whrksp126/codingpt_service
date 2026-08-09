#!/usr/bin/env node
/**
 * run-tests.js — `npm test` 진입점(Windows 포팅 §D-6).
 *
 * 왜 필요한가: 기존 스크립트의 `CPT_SHIM_NO_GLOBAL_LINK=1 node --test …` 는 POSIX 셸 문법이라
 *  win32(cmd)에서 죽는다. cross-env 의존을 추가하는 대신(의존성 최소 원칙) node 래퍼로 env 를
 *  주입하고, 글롭(`test/*.test.js`)도 셸에 기대지 않고 직접 나열한다.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'packages', 'runner-core', 'test');
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testDir, f));

const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, CPT_SHIM_NO_GLOBAL_LINK: '1' }, // 테스트는 stateDir 밖 무접촉(전역 심링크/훅 병합 OFF)
});
process.exit(r.status == null ? 1 : r.status);
