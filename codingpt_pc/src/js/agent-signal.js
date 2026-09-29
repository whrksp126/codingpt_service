// agent-signal.js — "이 터미널 탭에 AI 에이전트가 붙어 있는가" 판정의 **순수 코어**(TUI↔Chat 토글 노출).
//
// ★ 이 파일은 앱 `codingpt_app/src/workspace/agentPresence.ts` 의 **JS 미러**다. 사다리·경계·문구까지
//   같아야 하며, `test/agent-toggle.mjs` 가 **앱 소스에서 함수 본문을 오려내 실행해** 전 조합을 대조한다
//   (선례: test/e2ee-crossimpl.mjs §4). 한쪽만 고치면 그 테스트가 즉시 터진다 = 의도된 강제 장치다.
//   앱/PC 비대칭은 이 제품에서 반복된 사고 원인이라(같은 입력에 두 화면이 다른 그림) 규칙을 한 벌로 둔다.
//
// 왜 별 파일인가: 이 판정의 두 실패는 대칭이 아니다(진단서 13 §7 설계원칙).
//  · 잘못 뜬 토글 = 한 번의 무해한 오클릭.
//  · 잘못 사라진 토글 = 기능의 존재 자체가 사용자 인식에서 지워진다(에러·로그 0건이라 신고도 안 된다).
//  → **신호가 애매하면 켠다. 셸만 떠 있는 터미널이 유일한 항상-숨김 예외다.**
//  판정이 pane.js 안에 인라인이면 이 비대칭을 테스트로 고정할 수 없다(DOM 없이 못 부른다).
//
// ★ 2026-07-25 실측이 뒤집은 전제: 최신 Claude Code 의 `pane_current_command` 는 `claude` 도 `node` 도
//   아니고 **버전 문자열**이다(사용자 Mac: cmd=`2.1.219`, title=`✳ 히어로 아래에 고객 후기 섹션 추가`).
//   그래서 예전 `/^(claude|codex|gemini)$/` 단독 폴백은 **절대 매치되지 않았고**, push 가 비는 모든 순간
//   (caps `agentstate.v1` 미선언·구 데몬·채널 재접속 직후·15분 스테일·호스트 오프라인·데몬 재기동)에
//   토글이 사라졌다 — 사용자가 본 그 증상이다.
//
// 판정 근거는 데몬 `runner-core/agent-watch.js` 의 `isAgentPane()`/`titleStatus()` 와 **같은 규칙**이어야
// 한다(정본 2벌 = 이번 라운드가 잡은 사고). 아래 SHELL_CMDS / agentTitleStatus 는 의도된 미러다 —
// 데몬 쪽을 고치면 여기도 같이 고칠 것(test/agent-toggle.mjs 가 데몬 모듈을 직접 require 해 대조한다).

/**
 * 셸 목록 — 데몬 `agent-watch.js:47 SHELL_CMDS` 미러(문자열 그대로).
 *  에이전트가 끝난 뒤에도 pane_title 은 스테일하게 남으므로(실측: cmd=zsh + title=`⠹ …`)
 *  이 가드가 없으면 빈 셸 탭에 제목 글리프만으로 토글이 뜬다.
 */
export const SHELL_CMDS = new Set([
  "zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish", "login", "tcsh", "-tcsh",
]);
export function isShellCmd(cmd) {
  return SHELL_CMDS.has((cmd || "").trim());
}

/**
 * pane_title → 에이전트 상태. 데몬 `agent-watch.js:99 titleStatus()` 미러 — **확정 글리프만** 쓴다
 *  (경로·`user@host` 셸 제목은 null). 이름을 특정하진 못해도 "에이전트가 있다" 는 1급 근거다.
 */
export function agentTitleStatus(title) {
  const t = String(title || "");
  if (!t) return null;
  if (t.includes("✋")) return "permission";                 // ✋ (gemini)
  if (t.includes("✦") || t.includes("⏲")) return "working"; // ✦ ⏲ (gemini)
  if (t.startsWith("✳")) return "idle";                     // ✳ (claude idle)
  if (t.includes("◇")) return "idle";                       // ◇ (gemini idle)
  if (/[⠀-⣿]/.test(t)) return "working";                    // 점자 스피너(claude/codex 등)
  return null;
}

/**
 * ② 데몬 정규화 신호 → 3값(true=에이전트 / false=아님 / null=모름).
 *  ⚠ **null 과 false 를 절대 합치지 말 것**: 구 데몬은 필드를 아예 안 싣고(=모름 → 아래 칸으로 내려가야
 *   한다), 데몬이 `agent:null` 로 "아님"을 표현할 수도 있다. 둘을 구분할 수 없는 값(null·undefined·'')은
 *   전부 **모름**으로 접는다 — 여기서 "아님"으로 단정하면 구 데몬에서 토글이 영구 소멸한다.
 *  필드명은 데몬 담당 구현을 따르되 흔한 3가지 모양(agent 이름/부울, agentState 와이어값)을 모두 받는다.
 *  ★ `false` 는 **사다리에서 OFF 로 쓰지 않는다**(2026-07-25 교차실행으로 확정 — resolveAgentPresence
 *   주석 ★★ 참조). 3값을 유지하는 것은 진단·로그·미래 확장용이며 "긍정 근거 없음"과 구분해 두기 위함이다.
 */
export function normalizeDaemonAgentFlag(sig) {
  if (!sig) return null;
  const st = typeof sig.agentState === "string" ? sig.agentState.trim() : "";
  if (st) return st !== "gone";       // 와이어 state 를 실어 보내는 데몬 — 'gone' 만 부정
  const a = sig.agent;
  if (a === true) return true;
  if (a === false) return false;
  if (typeof a === "string") {
    const s = a.trim();
    if (!s) return null;              // 빈 문자열 = 모름(부정 아님)
    if (s === "none" || s === "null" || s === "false") return false;
    return true;
  }
  return null;                        // undefined | null = 모름
}

/**
 * ③ 구 CLI 이름 패턴 — **지우지 말 것**(계약 §1.5). 최신 claude 에는 사문이지만 구 CLI·gemini·
 *  `--settings` 직접 지정·cmux PATH 경합에서는 여전히 유효한 신호다.
 *  · 'node' 는 claude 를 node 스크립트로 띄운 경우(agent-watch 의 node 규칙 미러)라 **이미 chat 모드였던
 *    탭에서만** 인정한다 — 일반 node 프로세스에 토글이 뜨는 오검을 막는 기존 규칙 그대로.
 *  ※ 정규식은 chat-model.js 의 AGENT_CMD_RE 와 같은 값이지만 앱 `agentPresence.ts` 가 자기 파일에
 *    선언하고 있어(대조 대상이 이 파일 하나로 닫히게) 여기에 둔다.
 */
export const AGENT_CMD_RE = /^(claude|codex|gemini)$/i;
export function hasAgentCmd(sig) {
  if (!sig) return false;
  const cmd = (sig.cmd || "").trim();
  if (AGENT_CMD_RE.test(cmd)) return true;
  return cmd === "node" && sig.mode === "chat";
}

/**
 * 폴백 사다리(정본) — 위에서 아래로, 처음 결정된 칸이 답이다. 반환 = { on, from }(from = 진단용 근거).
 *
 *   ①  push(agent_state)                     : 있으면 정본. state!=='gone' = 부착(idle 도 부착).
 *   —  셸 확정(pane_current_command ∈ SHELL)  : 유일한 항상-숨김 예외.
 *   ②  데몬 정규화 신호(terminal.list.agent)  : 5~9초 주기 pull. 구 데몬이면 없다(모름).
 *   ③  구 CLI 이름 패턴(tab.cmd)              : 구 CLI·gemini 호환. 최신 claude 엔 안 맞는다.
 *   ③' 제목 글리프(tab.title)                 : automatic-rename 덕에 이미 도착해 있는 신호 →
 *                                              데몬/서버 배포 0으로도 최신 claude 를 잡는다.
 *   ④  전부 없음(데몬의 부정 포함)             : **켠다.** 근거 = 위 비대칭. cmd 가 `2.1.219` 같은 미상
 *                                              문자열이거나(=CLAUDE_CODE_DISABLE_TERMINAL_TITLE 로 제목이
 *                                              영구 부재인 환경) 목록이 아직 도착하지 않은 순간(cmd 미상,
 *                                              호스트 오프라인이면 영구)에도 토글은 살아 있어야 한다.
 *                                              대가는 빈 셸 탭 옆의 다른 프로세스(vim·npm 등)에도 토글이
 *                                              뜨는 것 = 무해한 오클릭.
 *
 * ★★ 데몬의 `agent:false` 를 OFF 로 쓰지 않는 이유(2026-07-25 교차실행으로 확정 — 결함 #2):
 *   데몬 `agent-watch.agentSignalOf` 는 **두 가지 다른 사실을 같은 `false` 로 접어 보낸다**:
 *   (i) 셸 확정(진짜 부정) (ii) "부착 레코드도 없고 제목 글리프도 못 봤다" = **모름**.
 *   (ii) 에는 claude 가 멀쩡히 도는 순간이 다수 들어간다 — `/resume`·`agents` 화면, 폴더 신뢰 확인,
 *   `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `showStatusInTerminalTab`(noPrefix), cursor-agent
 *   (제목 글리프 없음 + cmd=`2025.09.18-…`). 이걸 OFF 로 믿으면 **claude 가 도는 터미널에서 토글이
 *   사라진다 = 사용자 신고 증상 그 자체**다(실측: 데몬 행을 앱 사다리에 먹여 13 시나리오 중 8건 OFF).
 *   (i) 은 이 사다리가 이미 위 칸(셸 확정)에서 잡는다 — 목록 행은 `agent` 와 `cmd` 를 **같은 스냅샷**에서
 *   싣기 때문에 데몬이 부정할 때 cmd 도 항상 함께 온다. 그래서 부정 칸을 지워도 잃는 OFF 가 없다.
 *   부수 효과로 PC(Rust 목록 = agent 필드 구조적 부재 → 항상 '모름')와 앱(데몬 행)의 **최종 노출이
 *   같아진다** — 같은 터미널을 두고 PC 는 보이고 폰은 숨던 비대칭이 이 한 줄로 닫힌다.
 *
 * ★ 깜빡임 — 이 순서가 곧 안정성 보장이다:
 *   (a) ① 이 사라지는 사건(15분 스테일·채널 재접속 전량 폐기·호스트 오프라인·데몬 재기동)은 ②③③'④ 중
 *       어느 것도 건드리지 않는다. ④ 가 기본 ON 이므로 **①→② 하강 전이에서 OFF 가 나올 수 없다**
 *       (유일한 OFF 는 셸 확정 = "정말 에이전트가 없다"는 새 정보다).
 *   (b) ② 가 늦게 도착하는(구 데몬→신 데몬 배포) 상승 전이도 ON→ON 이라 무변화.
 *   (c) 셸 확정을 ① 보다 **아래**에 둔 이유도 깜빡임이다: 목록은 5~9초 스냅샷이라 claude 기동 직전/직후
 *       한 틱 동안 cmd=zsh 로 보일 수 있는데, 그때 push('working')를 셸로 덮으면 토글이 1틱 사라진다.
 *   (d) sticky("한 번 본 에이전트를 기억")는 **일부러 넣지 않았다** — ④ 가 기본 ON 이므로 기억이 필요한
 *       OFF 구간이 존재하지 않는다(sticky ⊂ 기본 ON). 렌더 경로에 상태를 더할 이유가 없다.
 */
export function resolveAgentPresence(input) {
  const push = (input && input.push) || null;
  const tab = (input && input.tab) || null;
  if (push) return { on: String(push.state || "") !== "gone", from: "push" };
  if (isShellCmd(tab && tab.cmd)) return { on: false, from: "shell" };
  const flag = normalizeDaemonAgentFlag(tab);
  if (flag === true) return { on: true, from: "daemon" };
  if (hasAgentCmd(tab)) return { on: true, from: "cmd" };
  if (agentTitleStatus(tab && tab.title) != null) return { on: true, from: "title" };
  // flag === false(데몬 부정)는 여기서 멈추지 않고 ④ 로 내려간다 — 위 ★★ 항 참조.
  return { on: true, from: "ambiguous" };
}

/**
 * 토글 노출 최종 판정 — 유지해야 하는 기존 규칙 3개를 그대로 담는다.
 *  · 혼합 탭(IDE/프리뷰)에서는 숨김 — 요구사항 자체가 "터미널 탭에서만"(의도된 동작).
 *  · win 미확정('new')이면 숨김 — chat 스냅샷 키 (cwd,tid) 가 아직 없다.
 *  · mode==='chat' 이면 에이전트가 사라져도 유지 — TUI 로 돌아갈 길을 사용자 의사 없이 없애지 않는다.
 *
 * ★ betaOn(2026-08-14) — 채팅 모드는 베타라 설정으로 끌 수 있다. **꺼짐이 가장 강한 규칙**이라
 *  맨 앞에 둔다(chat 모드로 열려 있던 탭도 예외가 아니다 — 본문 역시 함께 TUI 로 떨어지므로
 *  "토글은 없는데 채팅 화면만 남는" 상태가 생기지 않는다).
 *  ⚠ 이 판정은 앱 `agentPresence.resolveToggleVisible` 과 **같은 함수**여야 한다(test/agent-toggle.mjs
 *   가 두 구현을 조합 전수로 동치 고정한다). 한쪽에만 플래그를 넣으면 그 즉시 터진다.
 *  undefined(미지정)는 켜짐으로 본다 — 플래그를 모르는 호출부의 기존 동작을 바꾸지 않는다.
 */
export function resolveToggleVisible(input) {
  if (!input || !input.isTerm) return false;
  if (input.betaOn === false) return false;
  if (typeof input.win !== "number") return false;
  if (input.chatReady === false && !input.chatMode) return false;
  return !!(input.agentOn || input.chatMode);
}

export function resolveChatReady(input) {
  const brand = resolveAgentBrand(input);
  if (brand !== "claude" && brand !== "codex") return true;
  const push = (input && input.push) || null;
  const tab = (input && input.tab) || null;
  // Codex는 SessionStart 훅이 빠져도 prompt/stop/notification push가 정상 도착하는 버전이 있다.
  // 실제 에이전트 push가 있으면 프로젝트 신뢰 단계는 이미 지난 것이므로 채팅 진입을 허용한다.
  if (brand === "codex" && push && push.state !== "gone") return true;
  if (String((push && push.sessionId) || "").trim() || (tab && tab.agentReady === true)) return true;
  // PC 업데이트는 사이드카도 재시작한다. tmux 안의 에이전트는 계속 살아 있지만 메모리형 SessionStart
  // 장부만 비므로, 훅 신호만 요구하면 업데이트 직후 진행 중인 Codex/Claude의 토글이 사라진다.
  // 현재 프로세스로 브랜드가 확정된 경우에는 진입을 허용한다. 아직 첫 세션 파일이 없다면
  // ChatView의 기존 "대화를 준비하는 중" 상태가 안전하게 받는다.
  return brand === "codex" || brand === "claude";
}

/**
 * **어떤** 에이전트인가 — 탭 좌측 로고용(2026-07-27 요청). 'claude'|'codex'|'gemini'|null.
 *
 * `resolveAgentPresence`(있나?)와 일부러 분리했다. 두 판정의 실패 비대칭이 **반대**다:
 *  · 노출 판정은 애매하면 **켠다**(사라진 토글이 기능을 지운다).
 *  · 로고 판정은 애매하면 **모른다고 답한다** — 모양은 사실 주장이라, codex 터미널에 claude 로고를
 *    그리면 "표시 정직성 §2.7(거짓 색·거짓 자물쇠 금지)" 위반이다. null 이면 호출측이 터미널 글리프를 쓴다.
 *
 * 사다리(위에서 아래로, 처음 확정된 칸이 답):
 *  ① push(agent_state).agent      : 데몬 정규화 이름이 실려 오면 정본.
 *  ② 목록 행 tab.agent 문자열      : 위와 같은 이름 공간(구 데몬은 부재).
 *  ③ tab.cmd 이름 패턴            : 구 CLI·gemini(`claude`/`codex`/`gemini`)에서 유효.
 *  ④ 제목 글리프                  : ✳=claude, ✦/◇/✋=gemini(데몬 agent-watch 규칙 미러).
 *                                  점자 스피너는 claude/codex 공용이라 **이름을 특정하지 않는다**.
 *  ⑤ cmd 가 세마버 문자열          : 최신 Claude Code 의 pane_current_command 실측값(`2.1.219`).
 *                                  cursor-agent 는 날짜형(`2025.09.18-…`)이라 이 패턴에 안 걸린다.
 *  ⑥ 그 외                        : null(모름).
 */
export const AGENT_BRANDS = ["claude", "codex", "gemini"];
const SEMVER_CMD_RE = /^\d+\.\d+\.\d+$/;

export function resolveAgentBrand(input) {
  const push = (input && input.push) || null;
  const tab = (input && input.tab) || null;
  const named = (v) => {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    return AGENT_BRANDS.includes(s) ? s : null;
  };
  if (push) { const n = named(push.agent); if (n) return n; }
  if (tab) {
    // 데몬이 terminal.list 에 실어 보내는 정규화 이름 — push 다음으로 정확하다.
    const dn = named(tab.agentName); if (dn) return dn;
    const n = named(tab.agent); if (n) return n;
    const c = named(tab.cmd); if (c) return c;
    const t = String(tab.title || "");
    if (t.startsWith("✳")) return "claude";
    if (t.includes("✦") || t.includes("◇") || t.includes("✋")) return "gemini";
    if (SEMVER_CMD_RE.test(String(tab.cmd || "").trim())) return "claude";
  }
  return null;
}

export default {
  SHELL_CMDS, isShellCmd, agentTitleStatus, normalizeDaemonAgentFlag,
  AGENT_CMD_RE, hasAgentCmd, resolveAgentPresence, resolveToggleVisible, resolveChatReady,
  AGENT_BRANDS, resolveAgentBrand,
};
