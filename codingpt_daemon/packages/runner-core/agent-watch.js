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
 *  · process-exit: pane_current_command 가 에이전트(claude/codex/…) → 셸로 전이.
 *    working 상태에서만 후보로 삼는다(idle 에서의 종료 = 사용자가 직접 /exit — 알림 무가치).
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

// 에이전트로 취급하는 pane_current_command → 알림 타이틀. node 는 npm 설치형 CLI(셔뱅 실행)
//  폴백으로, "에이전트 title 글리프를 실제로 본" 세션에서만 에이전트로 인정한다(오탐 방지).
const AGENT_CMDS = new Map([
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['gemini', 'Gemini CLI'],
]);
const SHELL_CMDS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', '-fish', 'login', 'tcsh', '-tcsh']);

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
    let st = states.get(session);
    const agentKey = AGENT_CMDS.has(cmd) ? cmd : undefined;
    if (!st) {
      // 첫 관찰 = 시드(이벤트 없음) — 데몬 재기동 직후 기존 idle 터미널에 오발사하지 않는다.
      st = { cmd, status: tStatus, sawAgentTitle: tStatus != null, pendingTimer: null };
      states.set(session, st);
      // 상태만 기록(알림 없음). 훅이 지배 중이면 agent-state 가 시드를 무시한다.
      void applyObservation(session, { tid, agent: agentKey, observedState: tStatus, shell: SHELL_CMDS.has(cmd), seed: true });
      continue;
    }
    const isAgentCmd = AGENT_CMDS.has(cmd) || (cmd === 'node' && (tStatus != null || st.sawAgentTitle));
    const wasAgentCmd = AGENT_CMDS.has(st.cmd) || (st.cmd === 'node' && st.sawAgentTitle);
    const agentName = AGENT_CMDS.get(cmd) || AGENT_CMDS.get(st.cmd) || 'AI 에이전트';
    if (tStatus != null && isAgentCmd) st.sawAgentTitle = true;

    // 관찰 결과를 상태 소유자에게 보고(폴백 권한은 agent-state 가 판정 — hookGoverned 면 관찰만).
    void applyObservation(session, {
      tid,
      agent: agentKey || (AGENT_CMDS.has(st.cmd) ? st.cmd : undefined),
      agentName,
      observedState: isAgentCmd ? tStatus : null,
      shell: SHELL_CMDS.has(cmd),
    });

    // ① title 전이: working → idle/permission (에이전트 프로세스 유지 중 = 턴 완료/승인 대기).
    if (st.status === 'working' && isAgentCmd && (tStatus === 'idle' || tStatus === 'permission')) {
      scheduleFire(session, tid, agentName, tStatus === 'permission' ? 'permission_request' : 'done', { agent: agentKey });
    }
    // ② process-exit: 에이전트 → 셸 전이. 작업 중(working)이었을 때만(idle 종료 = 사용자 /exit).
    if (wasAgentCmd && SHELL_CMDS.has(cmd) && st.status === 'working') {
      scheduleFire(session, tid, agentName, 'done', { exited: true, agent: AGENT_CMDS.has(st.cmd) ? st.cmd : undefined });
    }
    st.cmd = cmd;
    if (tStatus != null) st.status = tStatus;
    else if (SHELL_CMDS.has(cmd)) { st.status = null; st.sawAgentTitle = false; } // 셸 복귀 = 리셋
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

module.exports = { start, stop, noteHook, observe, titleStatus, statusOf, _states: states };
