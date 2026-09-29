#!/usr/bin/env node
/**
 * win-agent-wrapper.js — win32 `<stateDir>\bin\{claude,codex}.cmd` 래퍼의 본체.
 *
 * darwin 의 #!/bin/sh 래퍼(shim.js §3·§4)와 1:1 등가:
 *  · 원본 재탐색(자기 bin 제외 — agents.resolveBinSync 가 binDir 를 항상 제외한다)
 *  · CPT_HOOKS_DISABLED=1 → 무주입 통과
 *  · 사용자가 --settings(claude) / notify(codex) 를 직접 주면 무간섭 통과
 *  · 아니면 훅 설정을 얹어 원본 실행(자격증명 무접촉 — 훅/설정 주입만)
 *
 * 왜 배치(.cmd) 안에 로직을 안 두나: 배치의 인용·특수문자·`%*` 파싱 함정이 sh 보다 훨씬 깊다.
 *  .cmd 는 두 줄(node 이 파일 호출)로 고정하고, 판단은 전부 여기(node)서 한다 — 테스트도 가능해진다.
 *
 * 실행: "<데몬 node>" "<이 파일>" <claude|codex> [사용자 인자...]
 */
const path = require('path');
const agents = require('./agents');
const runtime = require('./runtime');
const { spawnCli } = require('./spawn-util');

function hooksFile() { return path.join(runtime.stateDir(), 'shim', 'claude-hooks.json'); }
function cptCmd() { return path.join(runtime.stateDir(), 'bin', 'cpt.cmd'); }

function buildArgs(id, args) {
  if (process.env.CPT_HOOKS_DISABLED === '1') return args;
  if (id === 'claude') {
    if (args.includes('--settings')) return args; // 사용자가 직접 지정 — 무간섭 통과(darwin 동일)
    return ['--settings', hooksFile(), ...args];
  }
  if (id === 'codex') {
    // darwin 래퍼의 `case " $* " in *" notify"*)` 등가 — notify 관련 인자가 보이면 통과.
    if (args.some((a) => String(a).includes('notify'))) return args;
    return ['-c', `notify=["${cptCmd()}","codex-notify"]`, ...args];
  }
  return args;
}

function main() {
  const id = process.argv[2];
  const args = process.argv.slice(3);
  const real = agents.resolveBinSync(id);
  if (!real) {
    // 이 래퍼는 "생성 시점에 설치돼 있었다"는 뜻 — 여기 도달했으면 그 사이 제거/PATH 이탈이다
    //  (미설치면 래퍼 자체를 만들지 않는다 — shim.js 첫 원칙).
    process.stderr.write(`cpt-shim: ${id} 을 찾지 못했습니다 — 설치가 제거됐거나 PATH 에서 사라졌습니다\n`);
    process.exit(127);
  }
  const child = spawnCli(real, buildArgs(id, args), { stdio: 'inherit' });
  child.on('error', () => process.exit(127));
  child.on('exit', (code, sig) => process.exit(code == null ? (sig ? 1 : 0) : code));
}

if (require.main === module) main();
module.exports = { _buildArgs: buildArgs };
