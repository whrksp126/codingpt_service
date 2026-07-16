/**
 * cpt shim — 터미널에서 실행되는 `cpt`/`claude`/`codex` 를 자동 배선한다(cmux 의 claude 래핑 미러).
 *
 *  <stateDir>/bin/           cpt(CLI 진입), claude/codex(훅 주입 래퍼) — 0755
 *  <stateDir>/shim/claude-hooks.json   Stop/Notification 훅 → `cpt claude-hook <event>`
 *
 * 원칙:
 *  · 사용자 전역 설정(~/.claude/settings.json, ~/.codex/config.toml) 무오염 — 래퍼가 실행 시에만
 *    추가 설정(--settings / -c notify)을 얹는다. 사용자가 --settings 를 직접 주면 무간섭 통과.
 *  · 자격증명 무접촉(ToS 경계) — 훅/설정 주입만, 크레덴셜은 다루지 않는다.
 *  · 실제 바이너리는 생성 시점에 해석해 절대경로로 박되, 없으면 런타임 재탐색 폴백(command -v).
 *
 * PATH 주입은 pty.js injectPoolEnv 가 tmux 세션 env 로 수행. 셸 rc 가 PATH 를 재구성해 shim 이
 * 뒤로 밀리는 환경은 `cpt doctor`(후속)에서 감지·안내한다(자동 수정 금지).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const runtime = require('./runtime');

function binDir() { return path.join(runtime.stateDir(), 'bin'); }
function shimDir() { return path.join(runtime.stateDir(), 'shim'); }

// PATH 에서 실제 바이너리 탐색 — shim 디렉토리 자신은 제외(자기재귀 방지).
function which(name) {
  try {
    const pathEnv = (process.env.PATH || '')
      .split(':')
      .filter((p) => p && p !== binDir())
      .join(':');
    const out = execFileSync('/usr/bin/which', [name], {
      encoding: 'utf8',
      env: { ...process.env, PATH: pathEnv },
    }).trim();
    return out || null;
  } catch (_) { return null; }
}

function writeExec(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  try { fs.chmodSync(file, 0o755); } catch (_) { /* noop */ }
}

// 래퍼 공통 꼬리 — 생성 시점 절대경로가 사라졌으면 런타임 재탐색(shim 디렉토리 제외).
function resolverSnippet(name) {
  return `
# 실제 ${name} 해석 — 생성 시점 경로가 사라졌으면 PATH 재탐색(자기 자신 제외)
if [ ! -x "$REAL" ]; then
  REAL="$(PATH="$(echo "$PATH" | tr ':' '\\n' | grep -vx "$(cd "$(dirname "$0")" && pwd)" | tr '\\n' ':')" command -v ${name} || true)"
fi
if [ -z "$REAL" ] || [ ! -x "$REAL" ]; then
  echo "cpt-shim: ${name} 실행 파일을 찾을 수 없습니다" >&2
  exit 127
fi`;
}

function ensureShims() {
  const bin = binDir();
  const shim = shimDir();
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(shim, { recursive: true, mode: 0o700 });

  // 1) 훅 설정(claude --settings 로 주입 — 사용자 훅과 "추가 병합"됨).
  const hooksFile = path.join(shim, 'claude-hooks.json');
  const hooks = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'cpt claude-hook stop' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'cpt claude-hook notification' }] }],
    },
  };
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + '\n');

  // 2) cpt — 번들/소스 CLI 를 데몬의 node 로 실행(터미널 PATH 에 node 가 없어도 동작).
  const cptCli = path.join(__dirname, '..', 'cpt-cli', 'bin', 'cpt.js');
  writeExec(path.join(bin, 'cpt'), `#!/bin/sh
exec "${process.execPath}" "${cptCli}" "$@"
`);

  // 3) claude 래퍼 — 훅 설정 주입. 사용자가 --settings 를 직접 주면 무간섭 통과.
  const realClaude = which('claude');
  writeExec(path.join(bin, 'claude'), `#!/bin/sh
REAL="${realClaude || ''}"
${resolverSnippet('claude')}
if [ "\${CPT_HOOKS_DISABLED:-0}" = "1" ]; then exec "$REAL" "$@"; fi
case " $* " in
  *" --settings "*) exec "$REAL" "$@" ;;
esac
exec "$REAL" --settings "${hooksFile}" "$@"
`);

  // 4) codex 래퍼 — notify 프로그램 주입(작업 종료/승인 알림).
  const realCodex = which('codex');
  writeExec(path.join(bin, 'codex'), `#!/bin/sh
REAL="${realCodex || ''}"
${resolverSnippet('codex')}
if [ "\${CPT_HOOKS_DISABLED:-0}" = "1" ]; then exec "$REAL" "$@"; fi
case " $* " in
  *" notify"*) exec "$REAL" "$@" ;;
esac
exec "$REAL" -c 'notify=["cpt","codex-notify"]' "$@"
`);

  // 5) zsh ZDOTDIR 체인 — tmux 세션 env 의 PATH 주입은 사용자 zshrc 가 PATH 를 재구성하면
  //    밀려난다(실측). ZDOTDIR 를 이 디렉토리로 바꿔 사용자 rc 를 그대로 source 한 뒤
  //    "마지막에" shim 을 PATH 선두에 얹는다(iTerm/cmux 류 shell integration 과 같은 패턴).
  //    사용자 파일은 일절 수정하지 않는다.
  const zdot = path.join(shim, 'zdot');
  fs.mkdirSync(zdot, { recursive: true, mode: 0o700 });
  const orig = '"${CPT_ORIG_ZDOTDIR:-$HOME}"';
  fs.writeFileSync(path.join(zdot, '.zshenv'), `# CodingPT shim — 원래 zshenv 위임
_cpt_orig=${orig}
[ -f "$_cpt_orig/.zshenv" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zshenv"
ZDOTDIR="${zdot}"
`);
  fs.writeFileSync(path.join(zdot, '.zprofile'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zprofile" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zprofile"
ZDOTDIR="${zdot}"
`);
  fs.writeFileSync(path.join(zdot, '.zshrc'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zshrc" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zshrc"
ZDOTDIR="${zdot}"
# 사용자 rc 이후에 shim 을 선두로 — claude/codex 훅 래핑과 cpt 를 항상 우선.
export PATH="${bin}:$PATH"
`);
  fs.writeFileSync(path.join(zdot, '.zlogin'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zlogin" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zlogin"
ZDOTDIR="${zdot}"
`);

  return { binDir: bin, hooksFile, zdotDir: zdot };
}

function zdotDir() { return path.join(shimDir(), 'zdot'); }

module.exports = { ensureShims, binDir, shimDir, zdotDir };
