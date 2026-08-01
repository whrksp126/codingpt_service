// update-policy — "지금 업데이트로 재시작해도 되는가" 의 순수 판정. 의존성 0(테스트 대상).
//
// 배경: 이 제품은 원격 접속을 위해 PC 를 며칠씩 켜 둔다. 그래서 재시작 시점을 사람이 고르길
// 기다리면 영원히 안 되고, 아무 때나 하면 원격에서 일하던 사람을 끊는다. 판정 규칙 자체가 기능이다.
//
// 실측 전제(중요): 터미널은 별도 tmux 서버가 들고 있어 **앱/데몬 재시작에도 죽지 않는다**.
// 그래서 재시작의 비용은 "작업 날림" 이 아니라 20~30초 연결 끊김이다 — 조용할 때 적용하면 무해하다.

// 에이전트 상태 push 가 이보다 오래되면 근거로 쓰지 않는다(state.js 의 stale 규칙과 같은 취지).
export const AGENT_FRESH_MS = 15 * 60 * 1000;

// 지금 작업 중인 에이전트가 있는가. 'working' 만 작업으로 본다 —
//  needsInput(사용자 입력 대기)은 오히려 사람이 자리를 비운 상태일 수 있어 작업 중이 아니다.
//  (승인 대기는 approvals 로 따로 판정한다.)
export function anyAgentWorking(agentStates, now = Date.now()) {
  if (!agentStates) return false;
  for (const v of agentStates.values()) {
    if (!v || String(v.state) !== "working") continue;
    if (now - (v.recvAt || 0) > AGENT_FRESH_MS) continue; // stale 은 근거로 쓰지 않는다
    return true;
  }
  return false;
}

// 원격에서 보고 있는 화면 수. 이 PC 자신(kind==='pc')은 시청자가 아니다.
//  ⚠ 조회 실패는 0 이 아니라 **null(모름)** 로 전파한다 — 모르면 끊지 않는다.
export function remoteViewers(clients) {
  if (!Array.isArray(clients)) return null;
  return clients.filter((c) => c && c.kind !== "pc").length;
}

// 판정. 이유를 함께 돌려준다(배너 문구·로그용). 우선순위 = 강한 방해 요인부터.
export function judgeQuiet({ agentWorking, approvals, viewers, focused }) {
  if (agentWorking) return { quiet: false, reason: "agent" };
  if ((approvals | 0) > 0) return { quiet: false, reason: "approval" };
  if (viewers === null || viewers === undefined) return { quiet: false, reason: "unknown" };
  if (viewers > 0) return { quiet: false, reason: "remote" };
  if (focused) return { quiet: false, reason: "focus" };
  return { quiet: true, reason: "idle" };
}
