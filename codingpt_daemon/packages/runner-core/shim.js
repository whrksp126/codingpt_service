/**
 * cpt shim — 터미널에서 실행되는 `cpt`/`claude`/`codex` 를 자동 배선한다(cmux 의 claude 래핑 미러).
 *
 *  <stateDir>/bin/           cpt(CLI 진입), claude/codex(훅 주입 래퍼) — 0755
 *  <stateDir>/shim/claude-hooks.json   훅 7종(생명주기·프롬프트·승인·알림·종료)
 *      · 6종 = `cpt claude-hook <event>` (async fire-and-forget — 상태/알림 자기보고)
 *      · PermissionRequest = `cpt approval-hook` (동기 블로킹 — 원격 승인 결정을 stdout 으로 낸다)
 *
 * 원칙:
 *  · 사용자 전역 설정(~/.claude/settings.json, ~/.codex/config.toml) 무오염 — 래퍼가 실행 시에만
 *    추가 설정(--settings / -c notify)을 얹는다. 사용자가 --settings 를 직접 주면 무간섭 통과.
 *  · 자격증명 무접촉(ToS 경계) — 훅/설정 주입만, 크레덴셜은 다루지 않는다.
 *  · **설치된 것만 감싼다**(2026-07-27). 없는 바이너리의 래퍼를 만들면 OS 의 표준
 *    `command not found` 가 `cpt-shim: … 찾을 수 없습니다` 로 바뀌어 "우리가 망가뜨렸다"로 읽힌다
 *    (실제 제보). 감지·배선 여부의 단일 출처 = `agents.js`. 미설치/배선 OFF 면 래퍼를 **삭제**한다.
 *
 * ⚠ zdot/* 의 내용은 감지 결과에 따라 바뀌면 안 된다. `.zlogin` 의 mtime 이
 *  `healStaleTerminals`(pty.js) 의 낡음 판정 기준이라, 에이전트를 설치할 때마다 사용자의 유휴
 *  터미널이 전부 respawn 된다. 그래서 셸 함수는 **정적**으로 두고 `[ -x ]` 폴백을 함수 안에 넣는다
 *  (래퍼가 없으면 `command claude` 로 통과 → 표준 동작). 부수 효과로 나중에 설치해도 **이미 열려
 *  있던 터미널에서 즉시** 배선이 붙는다(재시작 불필요).
 *
 * PATH 주입은 pty.js injectPoolEnv 가 tmux 세션 env 로 수행. 셸 rc 가 PATH 를 재구성해 shim 이
 * 뒤로 밀리는 환경은 `cpt doctor`(후속)에서 감지·안내한다(자동 수정 금지).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const runtime = require('./runtime');
const agents = require('./agents');

function binDir() { return path.join(runtime.stateDir(), 'bin'); }
function shimDir() { return path.join(runtime.stateDir(), 'shim'); }

// "진짜" 바이너리 해석 — 다른 툴(cmux 등)의 래퍼를 건너뛰고 원본을 가리키게 한다.
//  데몬이 cmux 안에서 떠 있으면 process.env.PATH 선두가 cmux/bin 이라 단순 which() 는 cmux 래퍼를
//  잡는다. 그러면 우리 래퍼가 cmux 래퍼를 호출 → cmux 가 자기 훅을 다시 얹어 우리 훅이 무력화된다.
//  → 표준 설치 위치(~/.local/bin 등) 우선 + 우리 bin 제외를 `agents.js` 가 한 곳에서 담당한다.
function resolveReal(id) {
  return agents.resolveBinSync(id);
}

// 래퍼 제거 — 미설치이거나 사용자가 배선을 끈 에이전트. 남겨두면 그 에이전트의 표준 동작을
//  우리가 가로챈다(미설치일 때 OS 의 command not found 를 우리 에러로 바꿔치기하는 사고).
function removeExec(file) {
  try { fs.unlinkSync(file); return true; } catch (_) { return false; }
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
  # 이 래퍼는 "생성 시점에 ${name} 이 있었다"는 뜻이므로, 여기 도달했으면 그 사이에 사라진 것이다.
  #  (미설치 상태에서는 래퍼 자체를 만들지 않는다 — 그때는 OS 의 command not found 가 그대로 뜬다)
  echo "cpt-shim: ${name} 을 찾지 못했습니다 — 설치가 제거됐거나 PATH 에서 사라졌습니다" >&2
  exit 127
fi`;
}

function ensureShims() {
  const bin = binDir();
  const shim = shimDir();
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(shim, { recursive: true, mode: 0o700 });

  // 1) 훅 설정(claude --settings 로 주입 — 사용자 훅과 "추가 병합"됨. 실측 확인: 사용자/프로젝트
  //    settings.json 의 같은 이벤트 훅과 둘 다 발화한다 → 사용자 개인 훅 무오염).
  //
  //    상태 감지의 주력이 이 7종이다(agent-watch 폴링은 폴백으로 강등). 왜 이 조합인가:
  //     · SessionStart/SessionEnd  : 에이전트 생명주기(launching→idle, ended) — 폴링으론 최대 2초 늦다.
  //     · UserPromptSubmit         : working 진입의 정확한 시점(글리프 추측 불필요).
  //     · PermissionRequest        : 승인 대기를 "즉시" 안다. Notification(permission_prompt)은 claude 내부
  //                                  상수로 대화상자 표시 후 6초 뒤에야 오므로 그것만 쓰면 구조적으로 6초 늦다.
  //     · Notification             : PermissionRequest 유실 대비 + idle_prompt(60초 유휴=입력 대기) 신호.
  //     · Stop/StopFailure         : 턴 종료(완료/에러) — Stop.last_assistant_message 로 요약을 payload 에서
  //                                  바로 받는다(트랜스크립트 전체 읽기 폐기, 1.25GB 파일에서 실패하던 경로).
  //
  //    ⚠ PreToolUse/PostToolUse 는 넣지 않는다 — 상태머신에 불필요하고 도구 호출마다 node 프로세스가 뜬다.
  //    ⚠ SubagentStart/Stop 도 넣지 않는다 — 병렬 서브에이전트마다 발화해 "완료" 알림이 N건 된다.
  //    ⚠ PermissionRequest 만 동기 + 장시간 timeout — 이 훅이 **원격 승인 결정**(stdout JSON)을 낸다.
  //      `cpt approval-hook` 이 데몬에 요청을 걸고 사용자가 폰/PC 카드에서 답할 때까지 블로킹한다.
  //      결정을 못 받으면 무출력 + exit 0 → 평소처럼 TUI 대화상자가 뜬다(자동 허용 0 — 실측 확인).
  //      상태 보고(기능3)는 approval-hook 이 내부에서 hook.event 를 함께 자기보고하므로 유실 없다.
  //    ⚠ 이 파일은 claude 가 실행 시점에 --settings 로 읽는다 → 기존 셸에도 respawn 없이 소급 적용된다.
  //      (그래서 훅을 늘릴 때 zdot/* 를 건드릴 이유가 없다 — 건드리면 healStaleTerminals 가 사용자의
  //       유휴 터미널을 전부 respawn 한다. §shim mtime 계약)
  const hooksFile = path.join(shim, 'claude-hooks.json');
  const hook = (event, timeout, sync) => [{
    hooks: [{ type: 'command', command: `cpt claude-hook ${event}`, ...(sync ? {} : { async: true }), timeout }],
  }];
  // 승인 훅 예산의 단일 출처 = approvals.budget()(데몬 하드 타임아웃 < CLI 대기 < 훅 config timeout).
  //  실패해도 훅 배선 전체가 깨지지 않게 보수적 기본값으로 폴백한다.
  let ab = { cliWaitMs: 130000, hookTimeoutSec: 145 };
  try { ab = require('./approvals').budget(); } catch (_) { /* 기본값 유지 */ }
  // 절대경로 + 따옴표 — 옛 셸(PATH 에 <stateDir>/bin 이 없음)에서도 잡히고, 홈 경로에 공백이 있어도 안전.
  const approvalCmd = `"${path.join(bin, 'cpt')}" approval-hook --wait-ms ${ab.cliWaitMs}`;
  const hooks = {
    hooks: {
      SessionStart: hook('session-start', 5),
      UserPromptSubmit: hook('prompt', 5),
      PermissionRequest: [{
        hooks: [{
          type: 'command',
          command: approvalCmd,
          timeout: ab.hookTimeoutSec,
          statusMessage: 'CodingPT — 원격 승인 대기 중…',
        }],
      }],
      Notification: hook('notification', 5),
      Stop: hook('stop', 8),
      StopFailure: hook('stop-failure', 5),
      SessionEnd: hook('session-end', 5),
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
  //  ⚠ 이 심링크는 stateDir 밖(전역 PATH)을 건드리는 유일한 부작용이다. 격리 stateDir 로 이 함수를
  //   테스트하면 사용자의 라이브 `cpt` 링크가 임시 디렉토리를 가리키게 덮인다(실제로 겪음) →
  //   테스트/하네스는 CPT_SHIM_NO_GLOBAL_LINK=1 로 이 블록을 끈다.
  try {
    if (process.env.CPT_SHIM_NO_GLOBAL_LINK === '1') throw new Error('skip');
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
  //    ★ 설치돼 있고 배선이 켜져 있을 때만 만든다. 아니면 지운다(§파일 머리 주석).
  const wired = [];
  const skipped = [];
  const realClaude = resolveReal('claude');
  if (realClaude && agents.isWired('claude')) {
    writeExec(path.join(bin, 'claude'), `#!/bin/sh
REAL="${realClaude}"
${resolverSnippet('claude')}
if [ "\${CPT_HOOKS_DISABLED:-0}" = "1" ]; then exec "$REAL" "$@"; fi
case " $* " in
  *" --settings "*) exec "$REAL" "$@" ;;
esac
exec "$REAL" --settings "${hooksFile}" "$@"
`);
    wired.push('claude');
  } else {
    removeExec(path.join(bin, 'claude'));
    skipped.push('claude');
  }

  // 4) codex 래퍼 — notify 프로그램 주입(작업 종료/승인 알림).
  const realCodex = resolveReal('codex');
  if (realCodex && agents.isWired('codex')) {
    writeExec(path.join(bin, 'codex'), `#!/bin/sh
REAL="${realCodex}"
${resolverSnippet('codex')}
if [ "\${CPT_HOOKS_DISABLED:-0}" = "1" ]; then exec "$REAL" "$@"; fi
case " $* " in
  *" notify"*) exec "$REAL" "$@" ;;
esac
exec "$REAL" -c 'notify=["cpt","codex-notify"]' "$@"
`);
    wired.push('codex');
  } else {
    removeExec(path.join(bin, 'codex'));
    skipped.push('codex');
  }

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
  //  ⚠ 이 문자열은 **정적**이어야 한다(감지 결과를 넣지 말 것). 내용이 바뀌면 .zlogin mtime 이 변해
  //   healStaleTerminals 가 사용자의 유휴 터미널을 전부 respawn 한다. 그래서 "래퍼가 있으면 쓰고,
  //   없으면 원래대로"를 **함수 안의 런타임 분기**로 처리한다 — 래퍼 파일의 유무만 달라진다.
  //   `command <name>` 은 함수를 우회하지만 PATH 는 그대로라 우리 bin 이 앞에 있으면 재귀한다 →
  //   폴백에서는 PATH 에서 우리 bin 을 뺀 뒤 조회한다.
  const cptTail = `# CodingPT shim — 사용자 rc 이후 우리 배선을 확정(우리 터미널 전용).
export PATH="${bin}:$PATH"
_cpt_passthru() {  # $1=이름, 나머지=인자 — 우리 래퍼가 없을 때 원래 명령으로 통과
  _n="$1"; shift
  _p="$(echo "$PATH" | tr ':' '\\n' | grep -vx "${bin}" | tr '\\n' ':')"
  _r="$(PATH="$_p" command -v "$_n" 2>/dev/null)"
  if [ -n "$_r" ]; then "$_r" "$@"; else command "$_n" "$@"; fi
}
claude() { if [ -x "${bin}/claude" ]; then "${bin}/claude" "$@"; else _cpt_passthru claude "$@"; fi; }
codex()  { if [ -x "${bin}/codex" ];  then "${bin}/codex" "$@";  else _cpt_passthru codex "$@";  fi; }
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

  return { binDir: bin, hooksFile, zdotDir: zdot, wired, skipped };
}

/**
 * 감지를 **먼저** 끝낸 뒤 배선한다. 데몬은 PC 앱(Finder/launchd)이 띄우는 사이드카라 로그인 셸의
 *  PATH 를 물려받지 않는다 — 동기 경로만 쓰면 `~/.local/bin` 밖에 깐 에이전트를 놓칠 수 있다.
 *  `agents.list()` 가 로그인 셸 PATH 를 1회 조사해 캐시하므로, 이후 동기 해석이 정확해진다.
 */
async function ensureShimsAsync() {
  try { await agents.list({ version: false, refresh: true }); } catch (_) { /* 감지 실패 → 동기 폴백 */ }
  return ensureShims();
}

function zdotDir() { return path.join(shimDir(), 'zdot'); }

module.exports = { ensureShims, ensureShimsAsync, binDir, shimDir, zdotDir };
