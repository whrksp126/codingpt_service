/**
 * 에이전트 완료 감지 폴백(agent-watch) — 훅이 안 걸린 경우의 안전망.
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
 * 훅과의 중복 방지(핵심): 후보는 QUIET_MS 대기 후 발사하며, 같은 (cwd,win) 의 훅 이벤트가
 * 최근 HOOK_DEDUP_MS 안에 왔으면 폐기한다(훅이 정상 동작하면 이 모듈은 침묵). cpt-server 의
 * hook.event 처리부가 noteHook() 으로 알려준다.
 *
 * 대상은 전용 터미널 세션(<ns>--t-<tid>)만. tmux 서버가 없으면 조용히 쉰다.
 */
const path = require('path');

const POLL_MS = 2000;          // tmux 관찰 주기
const QUIET_MS = 3000;         // 후보 → 발사 대기(그 사이 훅이 오면 폐기 — Orca quiet window 모델)
const HOOK_DEDUP_MS = 15000;   // 이 시간 안의 훅 = 같은 턴으로 간주(폴백 침묵)
const REFIRE_MIN_MS = 8000;    // 같은 터미널 최소 재발사 간격(전이 플랩 노이즈 컷)

function pty() { return require('./pty'); }               // lazy — 순환 require 회피
function cptServer() { return require('./cpt-server'); }  // lazy — backFetch 사용

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

// 세션별 관찰 상태. key = 세션명("<ns>--t-<tid>").
//  { cmd, status, sawAgentTitle, lastFireAt, pendingTimer }
const states = new Map();
// (cwdRel|win) → 마지막 훅 수신 시각 — cpt-server hook.event 가 기록.
const recentHooks = new Map();
// 세션 → cwdRel 캐시(show-environment CPT_WS, 1회 조회).
const cwdCache = new Map();

let timer = null;

// cpt-server hook.event 에서 호출 — 훅이 살아있는 터미널에선 폴백을 침묵시킨다.
function noteHook(cwdRel, win) {
  recentHooks.set(`${cwdRel || ''}|${win == null ? '' : win}`, Date.now());
  // 무한 성장 방지(저빈도 청소).
  if (recentHooks.size > 200) {
    const cut = Date.now() - HOOK_DEDUP_MS * 2;
    for (const [k, ts] of recentHooks) if (ts < cut) recentHooks.delete(k);
  }
}

function hookSeenRecently(cwdRel, win) {
  const ts = recentHooks.get(`${cwdRel || ''}|${win == null ? '' : win}`);
  return !!ts && Date.now() - ts < HOOK_DEDUP_MS;
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

// 후보 발사 — QUIET_MS 뒤에 훅 중복 검사 후 서버에 알림 생성(fire-and-forget).
function scheduleFire(session, tid, agentName, kind, opts = {}) {
  const st = states.get(session);
  if (!st) return;
  if (st.pendingTimer) { clearTimeout(st.pendingTimer); st.pendingTimer = null; }
  if (Date.now() - (st.lastFireAt || 0) < REFIRE_MIN_MS) return;
  st.pendingTimer = setTimeout(async () => {
    st.pendingTimer = null;
    try {
      const cwdRel = await cwdRelOf(session);
      if (hookSeenRecently(cwdRel, tid)) return; // 훅이 이미 알림 — 폴백 침묵
      st.lastFireAt = Date.now();
      const wsName = cwdRel ? path.basename(cwdRel) : '';
      const payload = {
        source: 'watch',
        kind,
        title: agentName,
        subtitle: wsName ? (kind === 'done' ? `「${wsName}」에서 완료` : `「${wsName}」에서 승인 대기`) : undefined,
        body: opts.exited ? `${agentName} 프로세스가 종료되었습니다` : undefined,
        cwd: cwdRel || undefined,
        wsName: wsName || undefined,
        win: tid,
      };
      await cptServer().backFetch('POST', '/api/notifications', payload);
      console.log(`[agent-watch] 폴백 알림 발송: ${session} ${agentName} ${kind}${opts.exited ? '(exit)' : ''}`);
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
    if (!st) {
      // 첫 관찰 = 시드(이벤트 없음) — 데몬 재기동 직후 기존 idle 터미널에 오발사하지 않는다.
      st = { cmd, status: tStatus, sawAgentTitle: tStatus != null, lastFireAt: 0, pendingTimer: null };
      states.set(session, st);
      continue;
    }
    const isAgentCmd = AGENT_CMDS.has(cmd) || (cmd === 'node' && (tStatus != null || st.sawAgentTitle));
    const wasAgentCmd = AGENT_CMDS.has(st.cmd) || (st.cmd === 'node' && st.sawAgentTitle);
    const agentName = AGENT_CMDS.get(cmd) || AGENT_CMDS.get(st.cmd) || 'AI 에이전트';
    if (tStatus != null && isAgentCmd) st.sawAgentTitle = true;

    // ① title 전이: working → idle/permission (에이전트 프로세스 유지 중 = 턴 완료/승인 대기).
    if (st.status === 'working' && isAgentCmd && (tStatus === 'idle' || tStatus === 'permission')) {
      scheduleFire(session, tid, agentName, tStatus === 'permission' ? 'permission_request' : 'done');
    }
    // ② process-exit: 에이전트 → 셸 전이. 작업 중(working)이었을 때만(idle 종료 = 사용자 /exit).
    if (wasAgentCmd && SHELL_CMDS.has(cmd) && st.status === 'working') {
      scheduleFire(session, tid, agentName, 'done', { exited: true });
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
  }
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

module.exports = { start, stop, noteHook, observe, titleStatus, _states: states };
