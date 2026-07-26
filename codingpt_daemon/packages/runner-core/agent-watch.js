/**
 * 에이전트 완료 감지 폴백(agent-watch) — 훅이 안 걸린 경우의 안전망. **관찰 전용**.
 *
 * 2026-07-25 훅 주력화로 이 모듈은 "관찰자" 로 강등됐다: 상태 기록·알림 발사 결정은 전부
 * `agent-state`(단일 소유자)가 한다. 여기서는 tmux 스냅샷을 해석해 (a) 관찰된 상태와
 * (b) 발사 후보를 agent-state.applyWatch() 로 넘기기만 한다. 훅이 살아있는 터미널
 * (hookGoverned)에서는 agent-state 가 폴백 입력을 상태/알림에서 배제한다 — 즉 "훅 + 폴백
 * 동시 도착 = 알림 1건" 이 시각 휴리스틱이 아니라 소유권 구조로 보장된다.
 *
 * 1차 감지는 shim 이 주입하는 claude/codex 훅(hook.event → cpt-server)이다. 하지만 사용자가
 * 자기 --settings 로 실행하거나(CPT_HOOKS_DISABLED), 다른 툴이 래퍼를 가로채거나, 훅 미지원
 * 에이전트(gemini 등)를 쓰면 훅이 영영 안 온다. 이 모듈은 tmux 를 2s 주기로 관찰해 두 신호로
 * 완료를 폴백 감지한다(Orca 의 title/process-exit 폴백 모델 이식):
 *
 *  · title 전이: 에이전트 TUI 가 OSC 로 쏘는 pane_title 의 작업 표식이 사라짐
 *      working = 점자 스피너(U+2800–28FF) | ✦/⏲(gemini)
 *      idle    = "✳ " 프리픽스(claude) | ◇(gemini)
 *      permission = ✋(gemini)
 *    → working → idle/permission 전이 = 턴 완료/승인 대기 후보.
 *  · process-exit: pane_current_command 가 에이전트 → 셸로 전이.
 *    working 상태에서만 후보로 삼는다(idle 에서의 종료 = 사용자가 직접 /exit — 알림 무가치).
 *
 * ★ "에이전트 pane 이냐" 는 **프로세스 이름으로 판정하지 않는다**(2026-07-25 실측: 최신 Claude Code 의
 *   pane_current_command 는 `2.1.219` 같은 버전 문자열이다). 판정 정본은 isAgentPane() 주석 참조 —
 *   셸이 아니고 제목이 에이전트 글리프를 주면 에이전트다. 이름 화이트리스트를 되살리지 말 것.
 *
 * 훅과의 중복 방지(핵심): 후보는 QUIET_MS 대기 후 agent-state 에 발사를 "요청" 하며, 훅이 지배하는
 * 터미널이면 agent-state 가 억제한다(훅이 정상 동작하면 이 모듈은 침묵). 시각 기반 레거시 창구
 * (noteHook(cwdRel,win) / HOOK_DEDUP_MS)도 agent-state 로 위임돼 그대로 유지된다.
 *
 * 대상은 전용 터미널 세션(<ns>--t-<tid>)만. tmux 서버가 없으면 조용히 쉰다.
 */
const POLL_MS = 2000;          // tmux 관찰 주기
const QUIET_MS = 3000;         // 후보 → 발사 대기(그 사이 훅이 오면 폐기 — Orca quiet window 모델)

function pty() { return require('./pty'); }                 // lazy — 순환 require 회피
function agentState() { return require('./agent-state'); }  // 상태/알림 단일 소유자

// 이름으로 확실히 아는 에이전트 → 알림 타이틀. **이 목록은 판정의 필요조건이 아니다**(아래 참조).
const AGENT_CMDS = new Map([
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini CLI'],
]);
const SHELL_CMDS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh']);
const UNKNOWN_AGENT_NAME = 'AI 에이전트'; // 이름을 특정할 수 없을 때의 표시 문자열(agent-state.fire 와 동일 문구)

/**
 * 이 pane 을 에이전트로 볼지 — **프로세스 이름을 쫓지 않는다**(2026-07-25 실측으로 근거를 뒤집었다).
 *
 * 왜: 최신 Claude Code 의 `pane_current_command` 는 `claude` 도 `node` 도 아니고 **버전 문자열**이다
 *  (사용자 Mac 실측: cmd=`2.1.219`, title=`✳ 히어로 아래에 고객 후기 섹션 추가`). 이름 화이트리스트로
 *  판정하면 claude 가 멀쩡히 돌아도 `isAgentCmd=false` 가 되어 ① 상태 기록이 안 생기고(→ 와이어 방출 0건
 *  → 모바일 TUI↔Chat 토글 무발현) ② `wasAgentCmd` 도 항상 false 라 process-exit 폴백(훅 없는 에이전트의
 *  유일한 완료 신호)이 **영구히 발화하지 않는다**. 이름은 벤더가 언제든 바꾸므로 근거가 될 수 없다.
 *
 * 그래서 판정 근거는 "이름이 에이전트냐" → "**셸이 아니고 제목이 에이전트 신호를 주느냐**" 로 바뀐다.
 * 오검 방지 3중 장치(하나라도 빠지면 임의 프로세스에 토글·알림이 뜬다):
 *  ① 셸(SHELL_CMDS)은 어떤 제목이어도 절대 에이전트가 아니다 — 에이전트 종료 후 pane_title 은
 *     스테일하게 남으므로(실측: cmd=zsh + title=`⠹ …`) 이 가드가 없으면 셸에 기록이 생긴다.
 *  ② 제목 신호는 titleStatus() 의 **확정 글리프만**이다(경로/`user@host` 셸 타이틀은 null).
 *  ③ 과거 신호(sawAgentTitle)는 그 세션이 셸로 돌아오면 리셋된다(관찰 장부의 수명 = 에이전트 1생애).
 *
 * 버전 문자열 패턴(`/^\d+\.\d+\.\d+$/`)을 **독립 근거로 채택하지 않은 이유**: (a) 임의 프로그램이 그런
 *  이름일 수 있고, (b) 이 규칙 아래에선 정보량이 0이다 — 기록/알림이 나가는 모든 경로는 결국
 *  titleStatus() 가 non-null 이어야 하므로(status 는 제목에서만 만들어진다) 패턴을 더해도 감지력은
 *  늘지 않고 오검 표면만 넓어진다. 다시 추가하지 말 것.
 */
function isAgentPane(cmd, tStatus, sawAgentTitle) {
  if (SHELL_CMDS.has(cmd)) return false;      // ① 셸은 무조건 제외
  if (AGENT_CMDS.has(cmd)) return true;       // 이름으로 확실한 경우(구 CLI·gemini 등)
  return tStatus != null || !!sawAgentTitle;  // ②③ 제목 신호(현재/과거) = 1급 근거
}

// 제목 글리프로 **에이전트가 특정되는** 경우만 이름을 추론한다 — cmd 가 버전 문자열이면 이름 단서가
//  제목뿐이다. 점자 스피너는 claude/codex 공용이라 추론하지 않는다(틀린 제품명 표기 금지 → UNKNOWN).
function titleAgent(title) {
  const t = String(title || '');
  if (t.includes('✋') || t.includes('✦') || t.includes('⏲') || t.includes('◇')) return 'gemini';
  if (t.startsWith('✳')) return 'claude';
  return null;
}

// pane_title → 에이전트 상태. 확실한 글리프 신호만 쓴다(경로/셸 타이틀 오탐 차단 — Orca 휴리스틱 축약).
function titleStatus(title) {
  const t = String(title || '');
  if (!t) return null;
  if (t.includes('✋')) return 'permission';                       // ✋ (gemini)
  if (t.includes('✦') || t.includes('⏲')) return 'working';  // ✦ ⏲ (gemini)
  if (t.startsWith('✳')) return 'idle';                           // ✳ (claude idle)
  if (t.includes('◇')) return 'idle';                             // ◇ (gemini idle)
  if (/[⠀-⣿]/.test(t)) return 'working';                     // 점자 스피너(claude/codex 등)
  return null;
}

/**
 * 목록(terminal.list)용 **정규화된 에이전트 신호** — 판정을 데몬이 하고 클라는 받아 쓴다.
 *
 * 왜 여기 있는가: 클라이언트(앱 `PaneView.hasAgentCmd`, PC `pane.js _agentOn` 2순위)가
 *  `command` 를 이름 패턴(`/^(claude|codex|gemini)$/`)으로 매칭하던 구조가 이번 사고의 원인이다 —
 *  최신 Claude Code 의 pane_current_command 는 `2.1.219` 라 **영구 미매치**다. push(agent_state)가
 *  비는 순간(스테일·재접속 공백·데몬 재기동·서버 cap 미선언)엔 그 폴백이 유일한 근거였으므로 토글이
 *  사라졌다. 목록은 5~9초마다 무조건 다시 오므로, 같은 판정을 목록에 실으면 그 구멍이 구조적으로 닫힌다.
 *  판정 규칙 정본은 **isAgentPane/titleStatus 한 벌**이어야 한다(2벌 = 이번 라운드가 잡은 사고의 재발).
 *
 * 근거 우선순위(설계 원칙: 애매하면 켠다 — 잘못 사라진 토글은 기능의 존재를 인식에서 지운다):
 *  ① 셸(SHELL_CMDS) = **유일한 하드 OFF**. 다른 어떤 근거(스테일 제목·남아 있는 상태 레코드)가 있어도
 *     ON 이 되지 않는다 — 빈 셸 탭에 토글이 굳는 것이 직전 라운드의 blocker 였다(실측: cmd=zsh +
 *     title=`⠹ …` 조합이 실제로 존재한다).
 *  ② agent-state 부착(훅 자기보고 + 관찰이 화해된 결과). `gone` 이면 미부착.
 *  ③ 제목 신호(현재 글리프 / 이 세션에서 과거에 본 글리프 sticky). 데몬 재기동 직후처럼 레코드가
 *     0건인 순간에도 **첫 목록 조회부터** 신호가 살아나는 경로다(관찰 폴링 2s 를 기다리지 않는다).
 *
 * ★★ 반환 `on` 은 **3값**이다(2026-07-25 3패키지 합성 교차검증이 잡은 blocker):
 *    `true` = 에이전트 / `false` = **셸 확정(하드 OFF)** / `null` = **근거 0 = 모름**.
 *  "근거 없음" 을 `false` 로 접어 와이어에 실으면 클라 사다리가 그것을 **명시적 부정**으로 읽어
 *  (앱 `agentPresence.ts` · PC `agent-signal.js` 의 `normalizeDaemonAgentFlag`) "애매하면 켠다" 칸이
 *  무력화된다. 근거 0 에는 claude 가 멀쩡히 도는 순간이 다수 들어간다 — `/resume`·`agents` 화면,
 *  폴더 신뢰 확인, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `showStatusInTerminalTab`(noPrefix),
 *  cursor-agent(제목 글리프 없음 + cmd=`2025.09.18-…`) 이며 그 전부가 훅 미주입과 겹치면 **영구**다.
 *  실측 결과가 "같은 pane 에서 PC 는 ON / 모바일은 OFF"(PC 는 Rust 목록이라 이 필드를 아예 안 받는다)
 *  였고, 사용자 요구("pc·android·ios 다 항상")가 정확히 절반만 충족됐다. `null` 은 클라 두 벌이
 *  이미 "필드 부재" 와 같게 접으므로 **클라 수정 0**으로 경계가 닫힌다.
 *
 * 반환은 불리언/이름/상태 수준만이다 — pane_title 원문(사용자 프롬프트가 들어 있다)은 절대 싣지 않는다.
 */
function agentSignalOf(session, cmd, title) {
  const c = String(cmd || '').trim();
  const t = String(title || '');
  // 근거 0 = 모름. 부정으로 단정할 수 있는 것은 셸 확정 하나뿐이다(★★ 참조).
  const unknown = { on: null, agent: null, state: null, source: null };
  if (SHELL_CMDS.has(c)) return { on: false, agent: null, state: null, source: 'shell' }; // ① 셸 = 하드 OFF
  let att = { attached: false, known: false, agent: null, state: null, source: null };
  try { att = agentState().attachmentOf(session) || att; } catch (_) { /* 로드 실패 = 제목 판정만 */ }
  const st = states.get(session) || null;               // 관찰 장부(sticky sawAgentTitle/agent)
  const tStatus = titleStatus(t);
  const titleOn = isAgentPane(c, tStatus, st && st.sawAgentTitle);   // ③ 규칙 공유(정본 1개)
  if (!att.attached && !titleOn) return unknown;        // 근거 0 → 클라 사다리를 ④(애매하면 켠다)로 내려보낸다
  const agent = att.agent || (st && st.agent) || (AGENT_CMDS.has(c) ? c : null) || titleAgent(t) || null;
  return {
    on: true,
    agent,
    // 부착 레코드가 있으면 그 상태(와이어 도메인)를, 없으면 제목이 주는 상태를 쓴다. 제목이 글리프 없는
    //  구간(claude 의 /resume·agents 화면 등)이면 'idle' — 상태는 몰라도 **부착은 켠다**.
    state: att.attached ? att.state : (tStatus || 'idle'),
    source: att.attached ? (att.source || 'hook') : 'title',
  };
}

// 세션별 관찰 상태(에이전트 상태 아님 — tmux 스냅샷 해석용 지역 장부).
//  key = 세션명("<ns>--t-<tid>"). { cmd, status, sawAgentTitle, pendingTimer }
const states = new Map();
// 세션 → cwdRel 캐시(show-environment CPT_WS, 1회 조회).
const cwdCache = new Map();

let timer = null;

// cpt-server hook.event 에서 호출(호환 유지) — 훅 생존 신고는 agent-state 가 집행한다.
function noteHook(cwdRel, win) {
  try { agentState().noteHook(cwdRel, win); } catch (_) { /* 로드 실패 시에도 폴백은 계속 돈다 */ }
}

// 세션의 워크스페이스 경로(cwdRel) — 세션 env CPT_WS 가 정본(세션명은 sanitize 로 비가역).
async function cwdRelOf(session) {
  if (cwdCache.has(session)) return cwdCache.get(session);
  let rel = null;
  try {
    const out = await pty().runTmux(['show-environment', '-t', '=' + session, 'CPT_WS']);
    const m = /^CPT_WS=(.*)$/m.exec(String(out).trim());
    if (m) rel = m[1];
  } catch (_) { /* 레거시 세션 등 — cwd 미상으로 발송 */ }
  cwdCache.set(session, rel);
  return rel;
}

// 후보 발사 요청 — QUIET_MS 뒤에 agent-state 에 넘긴다(억제·dedup·REFIRE 판정은 전부 agent-state).
//  대기 창을 여기 두는 이유: cwdRel 해석(tmux show-environment)과 타이머가 tmux 의존이라
//  agent-state 를 순수 스토어(타이머 없음)로 유지하기 위함.
function scheduleFire(session, tid, agentName, kind, opts = {}) {
  const st = states.get(session);
  if (!st) return;
  if (st.pendingTimer) { clearTimeout(st.pendingTimer); st.pendingTimer = null; }
  st.pendingTimer = setTimeout(async () => {
    st.pendingTimer = null;
    try {
      const cwdRel = await cwdRelOf(session);
      await agentState().applyWatch(session, {
        tid,
        cwdRel: cwdRel || undefined,
        agent: opts.agent || undefined,
        agentName,
        fire: kind,
        exited: !!opts.exited,
      });
    } catch (_) { /* 서버 미가용 등 — 다음 기회 */ }
  }, QUIET_MS);
}

// 1회 관찰 — 전용 터미널 세션의 (cmd,title) 스냅샷을 받아 상태 전이를 판정한다.
//  스냅샷 주입이 가능하게 분리(테스트에서 rows 를 직접 먹인다).
function observe(rows) {
  const alive = new Set();
  for (const r of rows) {
    const session = r.session;
    const tidM = /--t-(\d+)$/.exec(session);
    if (!tidM) continue;
    const tid = parseInt(tidM[1], 10);
    alive.add(session);
    const cmd = String(r.cmd || '').trim();
    const tStatus = titleStatus(r.title);
    const shell = SHELL_CMDS.has(cmd);
    let st = states.get(session);
    if (!st) {
      // 첫 관찰 = 시드(이벤트 없음) — 데몬 재기동 직후 기존 idle 터미널에 오발사하지 않는다.
      //  ⚠ 시드도 isAgentPane 게이트를 지난다: 셸 pane 에 스테일 제목이 남아 있으면 그걸 그대로
      //  status 로 굳혀 이후 전이 판정이 셸을 에이전트처럼 다루게 된다(구 코드가 tStatus 무조건 채택).
      const agentPane = isAgentPane(cmd, tStatus, false);
      const seedAgent = agentPane ? (AGENT_CMDS.has(cmd) ? cmd : titleAgent(r.title)) : null;
      st = {
        cmd,
        status: agentPane ? tStatus : null,
        sawAgentTitle: agentPane && tStatus != null,
        agent: seedAgent || null,
        pendingTimer: null,
      };
      states.set(session, st);
      // 상태만 기록(알림 없음). 훅이 지배 중이면 agent-state 가 시드를 무시한다.
      void applyObservation(session, {
        tid,
        agent: seedAgent || undefined,
        agentName: AGENT_CMDS.get(seedAgent) || UNKNOWN_AGENT_NAME,
        observedState: agentPane ? tStatus : null,
        shell,
        seed: true,
      });
      continue;
    }
    const isAgent = isAgentPane(cmd, tStatus, st.sawAgentTitle);
    const wasAgent = isAgentPane(st.cmd, null, st.sawAgentTitle);
    // 에이전트 아이덴티티는 세션에 **끈적하게** 붙인다 — cmd 가 버전 문자열이면 이름 단서는 제목뿐이고
    //  제목은 매 틱 바뀐다(working 은 점자 스피너 = 무단서). 한 번 알면 셸 복귀까지 유지한다.
    if ((isAgent || wasAgent) && !st.agent) {
      st.agent = (AGENT_CMDS.has(cmd) ? cmd : null) || (AGENT_CMDS.has(st.cmd) ? st.cmd : null) || (isAgent ? titleAgent(r.title) : null) || null;
    }
    const agentKey = st.agent || undefined;
    const agentName = AGENT_CMDS.get(agentKey) || UNKNOWN_AGENT_NAME;
    if (tStatus != null && isAgent) st.sawAgentTitle = true;

    // 관찰 결과를 상태 소유자에게 보고(폴백 권한은 agent-state 가 판정 — hookGoverned 면 관찰만).
    void applyObservation(session, {
      tid,
      agent: agentKey,
      agentName,
      observedState: isAgent ? tStatus : null,
      shell,
    });

    // ① title 전이: working → idle/permission (에이전트 프로세스 유지 중 = 턴 완료/승인 대기).
    if (st.status === 'working' && isAgent && (tStatus === 'idle' || tStatus === 'permission')) {
      scheduleFire(session, tid, agentName, tStatus === 'permission' ? 'permission_request' : 'done', { agent: agentKey });
    }
    // ② process-exit: 에이전트 → 셸 전이. 작업 중(working)이었을 때만(idle 종료 = 사용자 /exit).
    //  버전 문자열 cmd 에서도 wasAgent 가 참이 되므로 이 폴백이 되살아난다(훅 없는 에이전트의 유일한 신호).
    if (wasAgent && shell && st.status === 'working') {
      scheduleFire(session, tid, agentName, 'done', { exited: true, agent: agentKey });
    }
    st.cmd = cmd;
    //  status 갱신도 에이전트 pane 에서만 — 셸의 스테일 제목이 'working' 을 되살리면 다음 셸 복귀가
    //  또 한 번 종료 알림을 낸다(구 코드의 조용한 반복 발사 경로).
    if (tStatus != null && isAgent) st.status = tStatus;
    else if (shell) { st.status = null; st.sawAgentTitle = false; st.agent = null; } // 셸 복귀 = 리셋
  }
  // 사라진 세션(터미널 닫힘) 정리 — 닫힘은 알림 대상이 아니다(대기 중 후보도 폐기).
  for (const [session, st] of states) {
    if (alive.has(session)) continue;
    if (st.pendingTimer) clearTimeout(st.pendingTimer);
    states.delete(session);
    cwdCache.delete(session);
    try { agentState().forget(session); } catch (_) { /* noop */ }
  }
}

// 관찰 보고(상태만) — applyWatch 의 관찰 경로는 await 지점이 없어 동기적으로 반영된다
//  (observe() 직후 statusOf 가 최신값을 보장). 실패는 폴링 다음 틱에서 자연 복구.
//  cwdRel 은 캐시에 있으면 같이 실어 보낸다 — 훅이 한 번도 안 온 터미널은 cwdRel 이 null 로 남아
//  snapshot(cwdRel) 스코프 조회(`cpt agent status`·hooks.doctor)에서 통째로 누락되기 때문이다.
//  캐시가 비었을 때만 1회 해석(tmux show-environment)하고 이후는 캐시 히트 — 폴링당 서브프로세스 없음.
function applyObservation(session, obs) {
  const cached = cwdCache.has(session) ? cwdCache.get(session) : undefined;
  if (cached === undefined) {
    // 최초 1회만: cwdRel 해석 후 보고(비동기). 해석 실패도 null 로 캐시돼 재시도 폭주 없음.
    return cwdRelOf(session)
      .then((rel) => applyObservationNow(session, { ...obs, cwdRel: rel || undefined }))
      .catch(() => applyObservationNow(session, obs));
  }
  return applyObservationNow(session, cached ? { ...obs, cwdRel: cached } : obs);
}

function applyObservationNow(session, obs) {
  try {
    const p = agentState().applyWatch(session, obs);
    return p && typeof p.catch === 'function' ? p.catch(() => {}) : Promise.resolve();
  } catch (_) { return Promise.resolve(); }
}

async function poll() {
  let out;
  try {
    out = await pty().runTmux(['list-windows', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{pane_title}']);
  } catch (_) { return; } // tmux 서버 없음 = 관찰할 것 없음
  const rows = [];
  const seen = new Set();
  for (const l of String(out).split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean)) {
    const [session, cmd, ...rest] = l.split('\t');
    if (!session || !/--t-\d+$/.test(session)) continue;
    if (seen.has(session)) continue; // 세션당 첫 window 만(listTerminals 와 동일 규칙)
    seen.add(session);
    rows.push({ session, cmd, title: rest.join('\t') });
  }
  observe(rows);
}

function start() {
  if (timer) return;
  timer = setInterval(() => { poll().catch(() => { /* noop */ }); }, POLL_MS);
  if (timer.unref) timer.unref();
  console.log('[agent-watch] 에이전트 완료 폴백 감지 시작(2s 관찰)');
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  for (const [, st] of states) if (st.pendingTimer) clearTimeout(st.pendingTimer);
  states.clear();
}

// 세션의 현재 에이전트 상태 조회 — terminal.wait(cpt-server) 폴링용. **agent-state 위임 얇은 래퍼**.
//  훅이 걸린 터미널이면 폴링 지연(2s) 없이 훅 시점의 상태를 그대로 본다.
//  반환 도메인은 레거시 3값(working|idle|permission) 유지 — needsInput/ended/launching 은 idle 로 접힌다
//  (호출자 cpt-server terminal.wait 의 for 값이 idle|permission|any 라, 신규 상태를 그대로 내보내면
//   `--for idle` 대기가 영원히 안 끝난다).
function statusOf(session) {
  try { return agentState().legacyStatusOf(session); } catch (_) { return 'idle'; }
}

module.exports = { start, stop, noteHook, observe, titleStatus, titleAgent, isAgentPane, agentSignalOf, statusOf, _states: states };
