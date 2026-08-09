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
 *    유일한 예외 = codex 원격 승인 훅(§4.7): codex 는 실행 인자 훅 주입이 없어 ~/.codex/hooks.json
 *    **비파괴 병합**만이 경로다(자기-스코핑 + 언와이어 시 회수 — 해당 절 주석 참조).
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
  // win32 는 병렬 생성 경로(계약 4) — 아래 darwin/POSIX 본문은 무수정 보존(macOS 무회귀 최우선).
  if (process.platform === 'win32') return ensureShimsWin32();
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
  // 훅 커맨드는 **절대경로**다(approval-hook 과 동일 규칙). 맨 이름 `cpt` 는 PATH 조회라
  //  ① 전역 심링크에 배선이 묶이고(심링크는 이제 옵션 — 아래 §전역 링크) ② 워킹트리에 굴러온
  //  동명 실행파일이 훅 페이로드를 가로챌 수 있다(Orca 가 절대경로를 쓰는 이유와 동일).
  const cptAbs = path.join(bin, 'cpt');
  const hook = (event, timeout, sync) => [{
    hooks: [{ type: 'command', command: `"${cptAbs}" claude-hook ${event}`, ...(sync ? {} : { async: true }), timeout }],
  }];
  // 승인 훅 예산의 단일 출처 = approvals.budget()(데몬 하드 타임아웃 < CLI 대기 < 훅 config timeout).
  //  실패해도 훅 배선 전체가 깨지지 않게 보수적 기본값으로 폴백한다.
  let ab = { cliWaitMs: 130000, hookTimeoutSec: 145 };
  try { ab = require('./approvals').budget(); } catch (_) { /* 기본값 유지 */ }
  // 절대경로 + 따옴표 — 옛 셸(PATH 에 <stateDir>/bin 이 없음)에서도 잡히고, 홈 경로에 공백이 있어도 안전.
  const approvalCmd = `"${cptAbs}" approval-hook --wait-ms ${ab.cliWaitMs}`;
  // ★ statusLine 중계(2026-08-03) — 채팅 UI 의 상태 표시를 **화면 스크랩이 아니라 공식 채널**로
  //  받는다. claude 는 값이 바뀌는 순간에만 이 명령을 실행하며 stdin 으로 JSON 을 준다(모델·컨텍스트·
  //  5h/7d 한도·비용). 실측: shift+tab 을 누르면 즉시 1회 발화한다.
  //  ⚠ 슬롯은 **1개뿐**이라 우리가 지정하면 사용자 설정이 밀린다 → 중계기가 사용자 명령을 찾아
  //   같은 stdin 으로 실행하고 그 stdout 을 그대로 내보낸다(터미널 화면 무변경). statusline-relay.js.
  const statusRelay = path.join(bin, 'cpt-statusline');
  const relayJs = path.join(__dirname, 'statusline-relay.js');
  writeExec(statusRelay, `#!/bin/sh
exec "${process.execPath}" "${relayJs}"
`);
  const hooks = {
    statusLine: { type: 'command', command: `"${statusRelay}"`, padding: 1 },
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
  // §전역 링크(옵션, 기본 OFF — 2026-07-29 강등). 과거엔 부팅마다 /opt/homebrew/bin 등에 cpt 를
  //  무조건 심링크했는데, 그 결과 **CodingPT 와 무관한 터미널/프로젝트에서도** cpt 가 실행 가능해져
  //  전역 스킬 스텁과 결합해 다른 도구의 에이전트가 사용자 화면을 조작하는 유출 경로가 됐다(실사고).
  //  훅은 이제 절대경로라(§훅 커맨드) 심링크가 배선의 필수 요건이 아니고, CodingPT 터미널은
  //  spawn env PATH + 셸 함수(§zdot)로 cpt 가 잡힌다. 남는 용도는 "옛 셸에서의 수동 실행" 편의뿐 —
  //  원하는 사용자만 CPT_GLOBAL_LINK=1 로 켠다.
  //  · 기본(OFF): 과거 버전이 만든 **자기 소유** 링크(우리 stateDir 의 bin/cpt 를 가리키는 심링크)를
  //    회수한다(sweep) — 스킬 opt-out 과 같은 원칙(끄면 기설치분도 걷는다).
  //  · ON: 그 자리가 비었거나 자기 소유일 때만 만든다 — 남의 파일/링크는 절대 덮지 않는다
  //    (Orca "Refusing to replace" 와 동일 규율. 과거엔 lstat 후 무조건 unlink 했다 — 금지).
  //  ⚠ stateDir 밖(전역 PATH)을 건드리는 유일한 블록 — 테스트/하네스는 CPT_SHIM_NO_GLOBAL_LINK=1 로 끈다.
  try {
    if (process.env.CPT_SHIM_NO_GLOBAL_LINK === '1') throw new Error('skip');
    const cptShim = path.join(bin, 'cpt');
    // "자기 소유" 판정 — 심링크이고 대상이 어떤 CodingPT stateDir 의 bin/cpt 형태면 우리 것으로 본다
    //  (과거 설치·다른 홈 경로 잔재까지 회수 대상). 일반 파일/타 도구 링크는 소유 아님.
    const ownedBy = (link) => {
      try {
        if (!fs.lstatSync(link).isSymbolicLink()) return false;
        const target = fs.readlinkSync(link);
        return target === cptShim || /[\\/]\.codingpt[\\/]bin[\\/]cpt$/.test(target);
      } catch (_) { return false; }
    };
    const enabled = process.env.CPT_GLOBAL_LINK === '1';
    let linked = false;
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]) {
      const link = path.join(dir, 'cpt');
      try {
        if (!enabled || linked) {
          // OFF(또는 이미 한 곳에 링크함): 자기 소유 잔재만 회수.
          if (ownedBy(link)) fs.unlinkSync(link);
          continue;
        }
        fs.accessSync(dir, fs.constants.W_OK);
        if (fs.existsSync(link) || ownedBy(link)) {
          if (!ownedBy(link)) continue; // 남의 파일 — 덮지 않는다(다음 후보로)
          fs.unlinkSync(link);
        }
        fs.symlinkSync(cptShim, link);
        linked = true;
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
exec "$REAL" -c 'notify=["${cptAbs}","codex-notify"]' "$@"
`);
    wired.push('codex');
  } else {
    removeExec(path.join(bin, 'codex'));
    skipped.push('codex');
  }

  // 4.7) codex 원격 승인 훅 — **~/.codex/hooks.json 비파괴 병합**(2026-07-29).
  //   codex 는 claude 의 `--settings` 같은 실행 인자 훅 주입이 없다(실측: hooks.json 파일이 유일한
  //   등록 경로, `-c` 는 config.toml 키만). 그래서 "개인 설정 파일 무수정" 원칙(agents.js 헤더,
  //   2026-07-27)의 예외를 여기 한 곳만 둔다 — 그 원칙의 세 가지 근거를 전부 구조로 해소했기 때문:
  //   ① 남의 파일 수정   → 우리 항목만 마커로 식별해 추가/갱신/제거(다른 도구 항목 무접촉),
  //                        배선 OFF/미설치면 우리 항목을 걷는다(래퍼 삭제와 같은 규율).
  //   ② CodingPT 밖 발화 → 명령 자체가 자기-스코핑: CPT_SOCK(CodingPT 터미널에만 주입되는 env)이
  //                        없으면 stdin 만 비우고 무출력 종료(cpt 전역 유출 근본수정 라운드와 같은 원칙).
  //   ③ 앱 제거 후 잔재  → Orca 와 같은 가드형 명령([ -x cpt ] 실패 시 cat) — cpt 가 사라져도
  //                        에러 없이 무동작. "cpt 를 못 찾겠다" 사고가 구조적으로 불가능.
  //   ⚠ codex 는 훅을 **사용자가 TUI 에서 1회 신뢰**해야 실행한다(Hooks need review → Trust all).
  //     신뢰 전에는 훅이 비활성 = 기존 notify 경로 그대로(원격 승인만 없음, 회귀 0).
  //   ⚠ CPT_SHIM_NO_GLOBAL_LINK=1(테스트/하네스의 "stateDir 밖 무접촉" 선언)이면 병합/회수 모두 스킵.
  //   ⚠ 첫 인자는 cpt **CLI JS 경로**다(래퍼 아님) — 명령이 Node 원라이너로 바뀌면서(§4.7 명령 주석)
  //     node 가 직접 실행할 파일을 가리켜야 한다.
  if (process.env.CPT_SHIM_NO_GLOBAL_LINK !== '1') {
    ensureCodexApprovalHook(cptCli, ab, !!(realCodex && agents.isWired('codex')));
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

// ── codex 훅 병합/회수(§4.7) ──────────────────────────────────────────────
//  우리 항목 식별자 — 명령 문자열에 이 마커가 있으면 우리 것이다(경로가 바뀐 과거 설치 잔재 포함).
const CODEX_HOOK_MARKER = 'approval-hook --agent codex';

function codexHooksFile() { return path.join(os.homedir(), '.codex', 'hooks.json'); }

// cptCliJs = cpt CLI 의 **JS 파일** 절대경로(node 로 직접 실행된다 — 셸 래퍼가 아님).
function ensureCodexApprovalHook(cptCliJs, ab, enabled, fileOverride) {
  const file = fileOverride || codexHooksFile();
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { raw = null; }
  let root = null;
  if (raw != null) {
    try { root = JSON.parse(raw); } catch (_) {
      // 파일이 있는데 파싱이 안 되면 **무접촉** — 우리가 재작성하면 타 도구의 항목(내용은 있는데
      //  형식만 깨진 경우)을 통째로 날릴 수 있다. codex 원격 승인만 비활성으로 남는다.
      return;
    }
  }
  const existed = root != null;
  if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) root.hooks = {};
  const list = Array.isArray(root.hooks.PermissionRequest) ? root.hooks.PermissionRequest : [];
  const isOurs = (m) => { try { return JSON.stringify(m).includes(CODEX_HOOK_MARKER); } catch (_) { return false; } };
  const others = list.filter((m) => !isOurs(m));

  if (!enabled) {
    // 배선 OFF/미설치 — 우리 항목만 걷는다. 파일이 없거나 우리 항목이 없으면 아무것도 쓰지 않는다
    //  (~/.codex 디렉토리를 우리가 만들지 않는다).
    if (!existed || others.length === list.length) return;
    if (others.length) root.hooks.PermissionRequest = others;
    else delete root.hooks.PermissionRequest;
    writeCodexHooks(file, root);
    return;
  }

  // 자기-스코핑 가드형 명령(§4.7 ①②③) — **Node 원라이너**(2026-08-10, Windows 포팅 계약 4).
  //  이전의 sh 조건문은 win32 에 sh 가 없어 못 쓴다 → 양 플랫폼 동일 코드로 치환:
  //   · 자기-스코핑: CPT_SOCK 없으면 stdin 만 드레인하고 무출력 종료(② 동일)
  //   · 가드형: cpt CLI(js) 부재 시에도 드레인 후 exit 0 — "cpt 못 찾음" 에러가 구조적으로 불가(③)
  //   · 마커 호환: `approval-hook --agent codex` 리터럴을 인자 문자열로 통째로 실어 기존 설치본
  //     항목 식별(CODEX_HOOK_MARKER)이 그대로 동작한다.
  //  ⚠ JS 코드에 큰따옴표·$·%·역슬래시를 넣지 말 것 — 이 한 줄이 sh("…")/cmd("…") 어느 셸에서
  //    문자열로 감싸여도 원형이 보존되는 교집합 문법이다.
  //  ⚠ 이 문자열이 바뀌면 codex 가 "훅이 변경됐다"며 재신뢰를 요구한다 — 꼭 필요할 때만 바꿀 것.
  //  ⚠ 알려진 트레이드오프: node 실행 파일(process.execPath)이 앱 제거로 사라지면 이 명령 자체가
  //    실패한다(옛 sh 가드는 sh 가 항상 있어 무에러였다). §최종 보고 TODO 참조.
  const guardJs = "var fs=require('fs'),cp=require('child_process');var cli=process.argv[1];var a=(process.argv[2]||'').split(' ');"
    + "if(!process.env.CPT_SOCK||!fs.existsSync(cli)){process.stdin.resume();process.stdin.on('end',function(){process.exit(0)});process.stdin.on('error',function(){process.exit(0)})}"
    + "else{var c=cp.spawn(process.execPath,[cli].concat(a),{stdio:'inherit'});c.on('error',function(){process.exit(0)});c.on('exit',function(n){process.exit(n||0)})}";
  const cmd = `"${process.execPath}" -e "${guardJs}" "${cptCliJs}" "approval-hook --agent codex --wait-ms ${ab.cliWaitMs}"`;
  const entry = {
    hooks: [{
      type: 'command',
      command: cmd,
      timeout: ab.hookTimeoutSec,
      statusMessage: 'CodingPT — 원격 승인 대기 중…',
    }],
  };
  const next = [...others, entry];
  let same = false;
  try { same = JSON.stringify(list) === JSON.stringify(next); } catch (_) { same = false; }
  if (same) return;                                     // 무변경 — 재신뢰 유발 금지
  root.hooks.PermissionRequest = next;
  writeCodexHooks(file, root);
}

// 원자적 쓰기(tmp→rename) — codex 가 읽는 도중의 반쪽 JSON 을 만들지 않는다.
function writeCodexHooks(file, root) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.cpt-tmp';
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (_) { /* 실패 = codex 원격 승인만 비활성(기존 notify 경로 유지) — 데몬을 세우지 않는다 */ }
}

// ── win32 shim(계약 4) — darwin 경로와 완전 병렬(공유 함수: writeIfChanged·removeExec·훅 구조) ──
//
//  <stateDir>\bin\{cpt.cmd, claude.cmd, codex.cmd, cpt-statusline.cmd}   (sh 래퍼의 등가물)
//  <stateDir>\shim\claude-hooks.json                                     (훅 7종 — 명령만 win32 문법)
//  <stateDir>\shim\ps\cpt-profile.ps1    pwsh 프로필(사용자 $PROFILE dot-source → PATH → 함수 3종)
//  <stateDir>\shim\cmd\cpt-init.cmd      cmd.exe 선택 시 초기화(PATH prepend)
//
//  래퍼 로직(원본 재탐색·--settings/notify 무간섭·훅 주입)은 배치가 아니라 node(win-agent-wrapper.js)
//  에 둔다 — 배치 인용 함정 회피 + mac 에서 유닛테스트 가능.
//
//  ★ claude 훅 command 의 win32 문법(2026-08-10 웹 조사 결론 — claude-code-guide):
//   네이티브 Windows claude 는 훅/셸 명령을 **PowerShell**(Git Bash 설정 시 bash)로 실행한다.
//   `.cmd` 직접 호출(`"C:\…\cpt.cmd" args`)은 PowerShell 문자열 파싱(& 호출 연산자 필요)에서 깨질
//   수 있다 → PowerShell·Git Bash·cmd **3셸 교집합에서 동일 동작**하는 `cmd.exe /d /s /c "…"` 형태를
//   쓴다(첫 토큰이 무인용 실행파일명이라 어느 셸에서도 명령으로 해석된다).
//   ⚠ 한계: 내부 명령은 인용을 겹칠 수 없어 **경로에 공백이 있으면 깨진다**(예: C:\Users\Ho Lee\…).
//   실기 검증(웨이브 3)에서 확정 전까지 이 빌더 한 곳만 고치면 되게 격리해 둔다.
function winHookCommand(inner) {
  return `cmd.exe /d /s /c "${inner}"`;
}

/** PowerShell 단일 인용 — ' 는 '' 로 이스케이프(PS 인용 규칙의 전부다). */
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// pwsh 프로필 — ① 사용자 $PROFILE dot-source ② PATH prepend ③ claude/codex/cpt 함수(zsh 함수 등가).
//  함수는 PATH 조회보다 우선하므로 타 도구의 PATH 래핑을 이긴다(§zdot 과 같은 원리). 래퍼(.cmd)가
//  없으면(미설치/배선 OFF) 자기 bin 을 제외하고 원본을 재탐색해 통과시킨다(_cpt_passthru 등가).
//  ⚠ darwin §zdot 과 같은 계약: 이 내용은 **정적**이어야 한다 — 감지 결과를 넣지 말 것.
function buildPsProfile(bin) {
  const q = psQuote;
  return `# CodingPT shim profile — 사용자 프로필을 먼저 위임한 뒤 우리 배선을 확정(우리 터미널 전용).
if (($null -ne $PROFILE) -and (Test-Path $PROFILE)) { . $PROFILE }
$env:Path = ${q(bin + ';')} + $env:Path
function global:_cptPassthru {
  param([string]$name, [object[]]$rest)
  $cand = Get-Command -Name $name -CommandType Application -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -and -not $_.Source.StartsWith(${q(bin)}, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if ($cand) { & $cand.Source @rest }
  else { Write-Error ($name + ': command not found') }
}
function global:claude { if (Test-Path ${q(path.win32.join(bin, 'claude.cmd'))}) { & ${q(path.win32.join(bin, 'claude.cmd'))} @args } else { _cptPassthru 'claude' $args } }
function global:codex  { if (Test-Path ${q(path.win32.join(bin, 'codex.cmd'))}) { & ${q(path.win32.join(bin, 'codex.cmd'))} @args } else { _cptPassthru 'codex' $args } }
function global:cpt    { & ${q(path.win32.join(bin, 'cpt.cmd'))} @args }
`;
}

function ensureShimsWin32() {
  const bin = binDir();
  const shim = shimDir();
  const psDir = path.join(shim, 'ps');
  const cmdDir = path.join(shim, 'cmd');
  // 0700 등 POSIX mode 는 win32 에서 무의미(%USERPROFILE% 기본 ACL = 소유자 전용) — mode 미지정.
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(psDir, { recursive: true });
  fs.mkdirSync(cmdDir, { recursive: true });

  const cptCli = path.join(__dirname, '..', 'cpt-cli', 'bin', 'cpt.js');
  const wrapperJs = path.join(__dirname, 'win-agent-wrapper.js');
  const relayJs = path.join(__dirname, 'statusline-relay.js');
  const cptCmd = path.join(bin, 'cpt.cmd');
  const statuslineCmd = path.join(bin, 'cpt-statusline.cmd');

  // 1) cpt.cmd / cpt-statusline.cmd — 데몬의 node 로 실행(터미널 PATH 에 node 불요, darwin §2 동일).
  //    배치는 두 줄 고정 — 로직은 전부 node 쪽(cpt.js / relay)에 있다. CRLF(cmd.exe 관례).
  writeIfChanged(cptCmd, `@echo off\r\n"${process.execPath}" "${cptCli}" %*\r\n`);
  writeIfChanged(statuslineCmd, `@echo off\r\n"${process.execPath}" "${relayJs}"\r\n`);

  // 2) 훅 설정 — 구조는 darwin §1 과 동일(훅 7종 + statusLine 중계), 명령 문자열만 win32 문법.
  const hooksFile = path.join(shim, 'claude-hooks.json');
  let ab = { cliWaitMs: 130000, hookTimeoutSec: 145 };
  try { ab = require('./approvals').budget(); } catch (_) { /* 기본값 유지 */ }
  const hook = (event, timeout, sync) => [{
    hooks: [{ type: 'command', command: winHookCommand(`${cptCmd} claude-hook ${event}`), ...(sync ? {} : { async: true }), timeout }],
  }];
  const hooks = {
    // ⚠ 알려진 상류 이슈: claude 2.1.34 에서 win32 statusLine command 미실행(#23994) — 설정은
    //  구조 동일하게 심어 두고, 수정 릴리스에서 자동으로 살아난다(우리 쪽 무해).
    statusLine: { type: 'command', command: winHookCommand(`${statuslineCmd}`), padding: 1 },
    hooks: {
      SessionStart: hook('session-start', 5),
      UserPromptSubmit: hook('prompt', 5),
      PermissionRequest: [{
        hooks: [{
          type: 'command',
          command: winHookCommand(`${cptCmd} approval-hook --wait-ms ${ab.cliWaitMs}`),
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

  // 3) 에이전트 래퍼 — darwin §3·§4 와 같은 규율: 설치돼 있고 배선 ON 일 때만 만들고, 아니면 지운다.
  const wired = [];
  const skipped = [];
  for (const id of ['claude', 'codex']) {
    const real = resolveReal(id);
    const file = path.join(bin, `${id}.cmd`);
    if (real && agents.isWired(id)) {
      writeIfChanged(file, `@echo off\r\n"${process.execPath}" "${wrapperJs}" ${id} %*\r\n`);
      wired.push(id);
    } else {
      removeExec(file);
      skipped.push(id);
    }
  }

  // 4) codex 원격 승인 훅 — darwin §4.7 과 **같은 함수/같은 명령**(Node 원라이너, 플랫폼 무분기).
  if (process.env.CPT_SHIM_NO_GLOBAL_LINK !== '1') {
    ensureCodexApprovalHook(cptCli, ab, wired.includes('codex'));
  }

  // 5) 셸 프로필 — pwsh(기본 셸, 계약 4)·cmd.exe(선택) 초기화. 사용자 프로필 파일 무수정 원칙 유지.
  writeIfChanged(path.join(psDir, 'cpt-profile.ps1'), buildPsProfile(bin));
  writeIfChanged(path.join(cmdDir, 'cpt-init.cmd'), `@echo off\r\nset "PATH=${bin};%PATH%"\r\n`);

  // (win32 는 zdot·open 래퍼·전역 심링크 없음 — zdot 등가물은 위 ps 프로필, open 라우팅은 후속 TODO)
  return { binDir: bin, hooksFile, zdotDir: null, wired, skipped };
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

module.exports = {
  ensureShims, ensureShimsAsync, binDir, shimDir, zdotDir,
  // 테스트 전용 — codex 훅 병합을 파일 단위로 검증한다(ensureShims 전체 실행 없이).
  _codexHooks: { ensureCodexApprovalHook, codexHooksFile, CODEX_HOOK_MARKER },
  // 테스트 전용(win32) — mac 에서 win32 생성물을 검증한다(플랫폼 게이트 밖에서 직접 호출).
  _win: { ensureShimsWin32, buildPsProfile, psQuote, winHookCommand },
};
