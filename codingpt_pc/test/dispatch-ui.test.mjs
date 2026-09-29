// dispatch-ui.test.mjs — 한 줄 지시(automation-design §3.1·§3.4) 플랜 카드 판정 + 흐름 소스 계약.
//  DOM 시트(dispatch-sheet.js)는 state.js·xterm 에 닿아 node 에서 못 연다 → 판정은 순수 모듈(automations-model.js)
//  에서 직접 돌리고, 흐름(병렬 카탈로그·플래너 PC·폴링·origin/createdBy·opId 재사용)은 소스 계약으로 고정한다.
//  실제 화면은 sidebar-harness.html#main-tasks-dispatch(-fallback-catfail) 로 확인한다.
import fs from "node:fs";
import path from "node:path";

const PC = path.resolve("src/js");
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };
const M = await import(path.join(PC, "automations-model.js"));

const PLAN = {
  v: 1, planner: { agent: "claude", mode: "cli", fallbackReason: null }, summary: "s",
  tasks: [
    { host: 12, workspaceId: "ws_a", repo: "work/a", subdir: "back", base: "main", title: "t1", prompt: "p1", agents: [{ id: "claude", count: 2 }, { id: "cursor-agent", count: 1 }] },
    { host: 12, workspaceId: null, repo: "", base: "main", title: "t2", prompt: "p2", agents: [{ id: "codex", count: 1 }] },
  ],
  automations: [{ host: 12, draft: { trigger: { type: "schedule", cron: "0 9 * * *" }, actions: [] }, why: "w" }],
  questions: ["a", "b", "c", "d"],
};
{
  const p = M.normalizePlan(PLAN);
  ok(p.tasks[0].agents.claude === 2 && !("cursor-agent" in p.tasks[0].agents), "에이전트는 claude·codex·gemini 만(작업 선택지와 같다)");
  ok(p.automations[0].include === true, "자동화 항목은 기본 포함(§3.4)");
  ok(p.questions.length === 3, "질문은 3개까지");
  ok(M.planRunTotal(p) === 3, "합계 run 수");
  ok(M.planStartable(p) === false, "저장소 못 정한 항목(workspaceId:null)이 있으면 [시작] 불가");
  p.tasks[1].workspaceId = "ws_b";
  ok(M.planStartable(p) === true, "저장소를 고르면 [시작] 가능");
  p.tasks[1].agents.codex = 3;
  ok(M.planStartable(p) === false, "합계 run > 4 면 불가(TASK_LIMIT)");
  p.tasks[1].agents.codex = 1; p.tasks[1].prompt = "  ";
  ok(M.planStartable(p) === false, "빈 프롬프트면 불가");
  const onlyAuto = M.normalizePlan({ ...PLAN, tasks: [] });
  ok(M.planStartable(onlyAuto) === true, "자동화만 있어도 [시작] 가능");
  onlyAuto.automations[0].include = false;
  ok(M.planStartable(onlyAuto) === false, "아무것도 포함하지 않으면 불가");
}
{
  ok(M.fallbackKey({ mode: "cli" }) === null, "cli 모드 = pill 없음");
  ok(M.fallbackKey({ mode: "fallback", fallbackReason: "PLANNER_UNAVAILABLE" }) === "fallbackNoAgent"
    && M.fallbackKey({ mode: "fallback", fallbackReason: "PLANNER_TIMEOUT" }) === "fallbackTimeout"
    && M.fallbackKey({ mode: "fallback", fallbackReason: "BAD_PLAN" }) === "fallbackFailed"
    && M.fallbackKey({ mode: "fallback", fallbackReason: "PLANNER_FAILED" }) === "fallbackFailed", "폴백 사유 → 문구(§3.4)");
  ok(M.pickPlannerHost([11, 12], 12) === 12 && M.pickPlannerHost([11, 12], 99) === 11 && M.pickPlannerHost([], 1) === null, "플래너 PC = 활성 PC, 없으면 첫 PC(§3.1 3)");
}
// 흐름 소스 계약
{
  const src = fs.readFileSync(path.join(PC, "dispatch-sheet.js"), "utf8");
  ok(/hostHasDispatch\(d\.id\) !== false/.test(src), "대상 PC = 온라인 ∧ dispatch.v1(모름은 시도)");
  ok(/Promise\.all\(hs\.map\(async \(d\) =>[\s\S]{0,120}autoRpc\("dispatch\.catalog", \{\}, d\.id, 30000\)/.test(src), "카탈로그: PC 마다 병렬 dispatch.catalog(30초)");
  ok(/st\.failedHosts\.push/.test(src) && /catalogFailed/.test(src), "카탈로그 실패 PC 는 빼고 카드 위에 한 줄");
  ok(/PLAN_POLL_MS = 2000/.test(src) && /PLAN_DEADLINE_MS = 120000/.test(src) && /autoRpc\("dispatch\.get", \{ planId: st\.planId \}/.test(src), "dispatch.get 2초 폴링·120초 상한");
  ok(/export function onDispatchChanged/.test(src) && /pollNow/.test(src), "dispatch.changed 수신 즉시 다시 받기");
  ok(/origin: \{ kind: "dispatch", planId \}/.test(src) && /createdBy: \{ kind: "dispatch", deviceId:[^}]*planId \}/.test(src), "task.create origin / auto.create createdBy = dispatch + planId");
  ok(/st\.startOps\[t\.key\] \|\| \(st\.startOps\[t\.key\] = newOpId\(\)\)/.test(src) && /if \(!isUncertain\(code\)\) delete st\.startOps/.test(src), "결과 불명 실패 뒤 재시도는 같은 opId(중복 작업 방지)");
  ok(/st\.done\[t\.key\]/.test(src), "이미 만든 항목은 재시도 때 건너뛴다");
  ok(/INSTRUCTION_MAX_BYTES = 4000/.test(src), "지시 문장 ≤ 4000 바이트(§3.3)");
  ok(/openTasksDashboard\(\{ taskId: firstTask\.taskId, host: firstTask\.host \}\)/.test(src) && /openAutomations\(\{ id: firstAuto\.id, host: firstAuto\.host \}\)/.test(src), "[시작] 뒤: 첫 작업 진행 현황, 자동화만이면 자동화 장소");
  ok(!/[\u{1F300}-\u{1FAFF}]/u.test(src), "이모지 0");
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
