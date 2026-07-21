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
const os = require('os');
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

// "진짜" 바이너리 해석 — 다른 툴(cmux 등)의 래퍼를 건너뛰고 원본을 가리키게 한다.
//  데몬이 cmux 안에서 떠 있으면 process.env.PATH 선두가 cmux/bin 이라 which() 가 cmux 래퍼를 잡는다.
//  그러면 우리 래퍼가 cmux 래퍼를 호출 → cmux 가 자기 훅을 다시 얹어 우리 훅이 무력화된다.
//  → Anthropic 공식 설치 경로(~/.local/bin)를 우선하고, 없으면 PATH 탐색으로 폴백.
function resolveReal(name) {
  const local = path.join(os.homedir(), '.local', 'bin', name);
  try { fs.accessSync(local, fs.constants.X_OK); return local; } catch (_) { /* 없음 → 폴백 */ }
  return which(name);
}

function writeExec(file, content) {
  writeIfChanged(file, content, 0o755);
  try { fs.chmodSync(file, 0o755); } catch (_) { /* noop */ }
}

// 내용이 같으면 쓰지 않는다 — mtime 을 보존해 "shim 이 실제로 바뀐 시점"만 mtime 에 남긴다.
//  (healStaleTerminals 가 이 mtime 을 낡음 판정 기준으로 쓴다 — 매 부팅 불필요 respawn 방지)
function writeIfChanged(file, content, mode) {
  try { if (fs.readFileSync(file, 'utf8') === content) return; } catch (_) { /* 없음 → 쓴다 */ }
  fs.writeFileSync(file, content, mode != null ? { mode } : undefined);
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
  writeIfChanged(hooksFile, JSON.stringify(hooks, null, 2) + '\n');

  // 2) cpt — 번들/소스 CLI 를 데몬의 node 로 실행(터미널 PATH 에 node 가 없어도 동작).
  const cptCli = path.join(__dirname, '..', 'cpt-cli', 'bin', 'cpt.js');
  writeExec(path.join(bin, 'cpt'), `#!/bin/sh
exec "${process.execPath}" "${cptCli}" "$@"
`);
  // cpt 를 PATH 에 이미 있는 전역 bin 에도 심링크(best-effort). shim env(ZDOTDIR/PATH)가 붙기 전에
  //  시작된 "옛 셸"(persistent tmux window 등)에서는 ~/.codingpt/bin 이 PATH 에 없어 cpt 가 안 잡힌다.
  //  cpt 는 CPT_WS/CPT_SOCK 없이도 TMUX_PANE 자체조회 + 기본 소켓으로 동작하므로, 전역 bin 에만 있으면
  //  어느 셸에서든 실행된다. claude/codex 는 실제 바이너리와 충돌할 수 있어 cpt 만 링크한다.
  try {
    const cptShim = path.join(bin, 'cpt');
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        const link = path.join(dir, 'cpt');
        try { const st = fs.lstatSync(link); if (st) fs.unlinkSync(link); } catch (_) { /* 없으면 그냥 생성 */ }
        fs.symlinkSync(cptShim, link);
        break; // 한 곳만 성공하면 충분
      } catch (_) { /* 이 dir 는 쓰기불가/없음 — 다음 후보 */ }
    }
  } catch (_) { /* noop */ }

  // 3) claude 래퍼 — 훅 설정 주입. 사용자가 --settings 를 직접 주면 무간섭 통과.
  const realClaude = resolveReal('claude');
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
  const realCodex = resolveReal('codex');
  writeExec(path.join(bin, 'codex'), `#!/bin/sh
REAL="${realCodex || ''}"
${resolverSnippet('codex')}
if [ "\${CPT_HOOKS_DISABLED:-0}" = "1" ]; then exec "$REAL" "$@"; fi
case " $* " in
  *" notify"*) exec "$REAL" "$@" ;;
esac
exec "$REAL" -c 'notify=["cpt","codex-notify"]' "$@"
`);

  // 4.5) open 래퍼(macOS 전용) — `open http(s)://…` 를 워크스페이스 프리뷰로 라우팅한다(cmux 미러).
  //   PATH 선두에 bin 이 오므로 이 파일이 /usr/bin/open 보다 먼저 잡힌다. cpt 와 달리 전역 심링크·
  //   셸 함수는 만들지 않는다 — open 을 PATH 래핑하는 서드파티가 없어 함수 강제가 불필요하고, rc 가
  //   source 하는 스크립트의 open 호출까지 오염시킬 위험만 있다. 우리 터미널(PATH 주입된) 안에서만 동작.
  //   플래그(-a/-e/…) 하나라도 있거나 비 http(s) 인자가 섞이면 통째로 시스템 open 으로 통과(보수적).
  if (process.platform === 'darwin') {
    writeExec(path.join(bin, 'open'), `#!/bin/sh
# CodingPT open shim — http(s) URL 은 워크스페이스 프리뷰로, 그 외는 시스템 open 그대로.
REAL="/usr/bin/open"
BIN="$(cd "$(dirname "$0")" && pwd)"
[ "\${CPT_OPEN_PASSTHROUGH:-0}" = "1" ] && exec "$REAL" "$@"
for a in "$@"; do
  case "$a" in
    -*) exec "$REAL" "$@" ;;
  esac
done
[ $# -eq 0 ] && exec "$REAL"
for a in "$@"; do
  case "$a" in
    http://*|https://*) ;;
    *) exec "$REAL" "$@" ;;
  esac
done
ok=1
for a in "$@"; do
  "$BIN/cpt" preview open "$a" >/dev/null 2>&1 || ok=0
done
[ "$ok" = "1" ] || exec "$REAL" "$@"
exit 0
`);
  }

  // 5) zsh ZDOTDIR 체인 — tmux 세션 env 의 PATH 주입은 사용자 zshrc 가 PATH 를 재구성하면
  //    밀려난다(실측). ZDOTDIR 를 이 디렉토리로 바꿔 사용자 rc 를 그대로 source 한 뒤
  //    "마지막에" shim 을 얹는다(iTerm/cmux 류 shell integration 과 같은 패턴). 사용자 파일 무수정.
  //
  //    ⚠ PATH 선두 주입만으론 cmux 등 다른 툴이 자기 bin 을 "더 나중에" 앞세우면 진다(실측:
  //    워크스페이스 claude 가 cmux 래퍼로 실행돼 우리 Stop 훅이 안 걸림 → 알림 미생성). 그래서
  //    claude/codex/cpt 를 **셸 함수**로도 정의한다 — 함수는 PATH 조회보다 우선하므로 다른 툴의
  //    PATH 래핑을 무조건 이긴다. 이 ZDOTDIR 는 CodingPT 가 띄운 터미널에만 적용되므로 사용자
  //    개인 셸/기존 도구(그들 터미널)엔 전혀 영향이 없다("우리 터미널은 우리 방식대로").
  const zdot = path.join(shim, 'zdot');
  fs.mkdirSync(zdot, { recursive: true, mode: 0o700 });
  const orig = '"${CPT_ORIG_ZDOTDIR:-$HOME}"';
  // 사용자 rc 이후 마지막에 실행 — PATH 선두 주입 + claude/codex/cpt 셸 함수 강제(다른 툴의 PATH 래핑 우선).
  const cptTail = `# CodingPT shim — 사용자 rc 이후 우리 배선을 확정(우리 터미널 전용).
export PATH="${bin}:$PATH"
claude() { "${bin}/claude" "$@"; }
codex()  { "${bin}/codex" "$@"; }
cpt()    { "${bin}/cpt" "$@"; }`;
  writeIfChanged(path.join(zdot, '.zshenv'), `# CodingPT shim — 원래 zshenv 위임
_cpt_orig=${orig}
[ -f "$_cpt_orig/.zshenv" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zshenv"
ZDOTDIR="${zdot}"
`);
  writeIfChanged(path.join(zdot, '.zprofile'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zprofile" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zprofile"
ZDOTDIR="${zdot}"
`);
  writeIfChanged(path.join(zdot, '.zshrc'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zshrc" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zshrc"
ZDOTDIR="${zdot}"
${cptTail}
`);
  // 로그인 셸은 .zshrc 다음 .zlogin 이 "마지막"이라 여기서 한 번 더 확정(cmux 통합이 .zlogin/precmd 로
  //  뒤에 끼어드는 환경 대비). tmux 는 기본 로그인 셸(-l)로 pane 을 띄운다.
  //  이 파일의 mtime = "훅 배선 마지막 변경 시점" → healStaleTerminals 낡음 판정 기준.
  writeIfChanged(path.join(zdot, '.zlogin'), `_cpt_orig=${orig}
[ -f "$_cpt_orig/.zlogin" ] && ZDOTDIR="$_cpt_orig" source "$_cpt_orig/.zlogin"
ZDOTDIR="${zdot}"
${cptTail}
`);

  return { binDir: bin, hooksFile, zdotDir: zdot };
}

function zdotDir() { return path.join(shimDir(), 'zdot'); }

module.exports = { ensureShims, binDir, shimDir, zdotDir };
