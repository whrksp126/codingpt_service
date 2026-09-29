// tasks-api.test.mjs — Agent Tasks 전송 래퍼(taskRpc)의 폴백 규칙 고정(설계 §3.2 · 부록 A3).
//
// 핵심 위험 = **이중 실행**. 봉인 요청이 타임아웃난 뒤 평문으로 같은 변이(머지·폐기)를 다시 보내면 호스트가 두 번 한다.
//  그래서 평문 폴백은 "봉투를 구조적으로 쓸 수 없다" 는 코드에서만 허용되고, 타임아웃·5xx·도메인 code·코드 없는 실패는
//  전부 throw 여야 한다. 이 파일은 가짜 전송(local/backApi)을 끼워 **평문 경로가 불렸는지**를 센다.
import fs from "node:fs";
import path from "node:path";

const { createTaskApi, parseCodedError, TASK_TIMEOUTS, TASK_READS, SEALED_FALLBACK_CODES, TaskError } =
  await import(path.resolve("src/js/tasks-api.js"));

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };

/** 가짜 배선 — calls 에 경로별 호출을 기록한다. */
function rig({ sealed, plain, local, ready = true, policy = "preferred", localHost = 1 } = {}) {
  const calls = { sealed: [], plain: [], local: [] };
  let t = 1_000_000;
  const api = createTaskApi({
    local: async (cmd, args) => {
      if (cmd === "e2ee.rpc") { calls.sealed.push(args); return sealed(args, calls.sealed.length); }
      calls.local.push([cmd, args]);
      return local ? local(cmd, args) : { ok: true };
    },
    backApi: async (o) => { calls.plain.push(o); return plain ? plain(o, calls.plain.length) : { success: true, data: { via: "plain" } }; },
    e2ee: () => ({ ready, policy }),
    isLocalHost: (h) => h === localHost,
    now: () => t,
  });
  return { api, calls, tick: (ms) => { t += ms; } };
}
const coded = (s) => { throw new Error(s); };
async function codeOf(p) { try { await p; return "(resolved)"; } catch (e) { return e instanceof TaskError ? e.code : "(not TaskError) " + e; } }

// ── 1. 이 PC 호스트 = 유닉스 소켓 직결(봉인·평문 안 탐) ─────────────────────────────
{
  const { api, calls } = rig({ local: (cmd) => (cmd === "git.push" ? coded("RUN_BUSY: 다른 작업이 진행 중") : { items: [1] }) });
  const r = await api.taskRpc("task.list", {}, 1);
  ok(r.items && calls.local.length === 1 && !calls.sealed.length && !calls.plain.length, "이 PC 호스트는 task_local 로만 간다");
  ok(await codeOf(api.taskRpc("git.push", { opId: "x" }, 1)) === "RUN_BUSY", "로컬 소켓 `CODE: msg` → TaskError.code");
}

// ── 2. 봉인 성공 · 호스트 실행 실패(ok:false) ─────────────────────────────────────
{
  const { api, calls } = rig({ sealed: () => ({ ok: true, r: { task: { id: "t" } } }) });
  const r = await api.taskRpc("task.get", { taskId: "t" }, 5);
  ok(r.task.id === "t" && calls.sealed.length === 1 && !calls.plain.length, "봉인 성공 → 결과(r) 반환, 평문 0회");
  const a = calls.sealed[0];
  ok(a.method === "task.get" && a.hostDeviceId === 5 && a.timeoutMs === 15000 && a.params.taskId === "t",
    "봉인 요청 = e2ee.rpc {method, params, hostDeviceId, timeoutMs(§3.3 표)}", JSON.stringify(a));
}
{
  const { api, calls } = rig({ sealed: () => ({ ok: false, e: "gh 로그인이 필요합니다", code: "GH_NOT_AUTHED" }) });
  ok(await codeOf(api.taskRpc("git.pr.create", { opId: "o" }, 5)) === "GH_NOT_AUTHED" && !calls.plain.length,
    "★ 호스트가 실행하고 실패(ok:false) → 도메인 code 로 throw, 평문 재전송 0회");
}
{
  const { api } = rig({ sealed: () => ({ ok: true, r: null }) });
  const r = await api.taskRpc("task.delete", { taskId: "t" }, 5);
  ok(r && typeof r === "object", "봉인 성공인데 결과가 비어도 null 을 돌려주지 않는다(폴백 오인 금지)");
}

// ── 3. ★ 타임아웃·결과 불명 = 폴백 금지 ───────────────────────────────────────────
for (const [msg, want, label] of [
  ["E2EE_RELAY_FAILED: 데몬이 응답하지 않습니다(RPC 타임아웃).", "TIMEOUT", "back 릴레이 타임아웃(데몬이 E2EE_RELAY_FAILED 로 접음)"],
  ["E2EE_RELAY_FAILED: 서버 오류", "E2EE_RELAY_FAILED", "back 5xx(뭉개진 RELAY_FAILED)"],
  ["응답 수신 실패: Resource temporarily unavailable (os error 35)", "TIMEOUT", "로컬 소켓 읽기 타임아웃(코드 없음)"],
  ["E2EE_EPOCH_MISMATCH: 세대 불일치", "E2EE_EPOCH_MISMATCH", "세대 불일치"],
  ["E2EE_DECRYPT_FAILED: 응답을 복호할 수 없습니다", "E2EE_DECRYPT_FAILED", "응답 복호 실패(호스트는 실행했을 수 있다)"],
]) {
  const { api, calls } = rig({ sealed: () => coded(msg) });
  const code = await codeOf(api.taskRpc("git.pr.merge", { opId: "o", method: "squash" }, 5));
  ok(code === want && calls.plain.length === 0 && calls.sealed.length === 1, `★ 변이 + ${label} → throw ${want}, 평문 0회 · 재시도 0회`,
    `code=${code} plain=${calls.plain.length} sealed=${calls.sealed.length}`);
}
{
  const { api, calls } = rig({ sealed: (a, n) => (n === 1 ? coded("E2EE_RELAY_FAILED: 데몬이 응답하지 않습니다(RPC 타임아웃).") : { ok: true, r: { items: [] } }) });
  const r = await api.taskRpc("task.list", {}, 5);
  ok(Array.isArray(r.items) && calls.sealed.length === 2 && calls.plain.length === 0, "읽기는 타임아웃에서 1회 재시도(같은 봉인 경로), 평문 0회");
}

// ── 4. 구조적 미지원 → 평문 폴백 + 호스트별 10분 네거티브 캐시 ──────────────────────────
for (const c of ["E2EE_UNSUPPORTED", "E2EE_DISABLED", "E2EE_SCOPE", "E2EE_NO_KEY", "E2EE_NO_ENVELOPE", "E2EE_BAD_METHOD", "E2EE_UNKNOWN_CMD"]) {
  const { api, calls } = rig({ sealed: () => coded(`${c}: 미지원`) });
  const r = await api.taskRpc("task.discard", { opId: "o", taskId: "t" }, 5);
  ok(r.via === "plain" && calls.plain.length === 1, `${c} → 평문 POST /api/daemon/task 로 폴백`);
}
{
  const { api, calls, tick } = rig({ sealed: () => coded("E2EE_UNSUPPORTED: 구 데몬") });
  await api.taskRpc("task.list", {}, 5);
  await api.taskRpc("task.list", {}, 5);
  ok(calls.sealed.length === 1 && calls.plain.length === 2, "미지원을 한 번 보면 그 호스트는 10분간 봉인을 건너뛴다");
  await api.taskRpc("task.list", {}, 6);
  ok(calls.sealed.length === 2, "네거티브 캐시는 호스트별이다(다른 PC 는 봉인 재시도)");
  tick(10 * 60 * 1000 + 1);
  await api.taskRpc("task.list", {}, 5);
  ok(calls.sealed.length === 3, "10분 뒤 다시 봉인을 시도한다");
}

// ── 5. 정책 required = 평문 금지(다운그레이드 차단) ─────────────────────────────────
{
  const { api, calls } = rig({ ready: false, policy: "required" });
  ok(await codeOf(api.taskRpc("task.list", {}, 5)) === "E2EE_REQUIRED" && !calls.plain.length, "required + 열쇠 없음 → throw, 평문 0회");
  const r2 = rig({ policy: "required", sealed: () => coded("E2EE_UNSUPPORTED: x") });
  ok(await codeOf(r2.api.taskRpc("task.list", {}, 5)) === "E2EE_REQUIRED" && !r2.calls.plain.length, "required + 구조적 미지원 → throw, 평문 0회");
}

// ── 6. 평문 경로 — 본문·타임아웃·에러 매핑 ─────────────────────────────────────────
{
  const { api, calls } = rig({ ready: false });
  await api.taskRpc("task.diff", { taskId: "t", runId: "r" }, 9);
  const o = calls.plain[0];
  ok(o.method === "POST" && o.path === "/api/daemon/task" && o.body.method === "task.diff" && o.body.hostDeviceId === 9
    && o.body.params.runId === "r" && o.timeoutSecs === 35, "평문 = POST /api/daemon/task {method, params, hostDeviceId}, 클라 타임아웃 = 표 + 5s", JSON.stringify(o));
}
for (const [err, want, retries, label] of [
  ["HTTP 500 GH_NOT_AUTHED: gh 로그인이 필요합니다", "GH_NOT_AUTHED", 1, "detail.code 도메인 코드"],
  ["HTTP 500 TIMEOUT: 데몬이 응답하지 않습니다(RPC 타임아웃).", "TIMEOUT", 1, "back 이 TIMEOUT 으로 매핑한 릴레이 타임아웃(변이 재시도 없음)"],
  ["HTTP 409 DAEMON_OFFLINE: PC 데몬이 연결되어 있지 않습니다.", "DAEMON_OFFLINE", 1, "대상 PC 오프라인"],
  ["HTTP 404", "SERVER_NEEDS_UPDATE", 1, "구 back(라우트 없음) → serverNeedsUpdate"],
  ["요청 실패: timed out reading response", "TIMEOUT", 1, "전송 계층 타임아웃"],
]) {
  const { api, calls } = rig({ ready: false, plain: () => coded(err) });
  const code = await codeOf(api.taskRpc("git.commit", { opId: "o", message: "m" }, 5));
  ok(code === want && calls.plain.length === retries, `평문 실패: ${label} → ${want}`, `code=${code} calls=${calls.plain.length}`);
}
{
  const { api } = rig({ ready: false, plain: () => ({ success: true, data: { accepted: true, opId: "o" } }) });
  const r = await api.taskRpc("git.push", { opId: "o" }, 5);
  ok(r.accepted === true && r.opId === "o", "평문 성공 = successResponse 의 data 를 돌려준다");
}

// ── 7. 실패 문자열 파서 ────────────────────────────────────────────────────────────
{
  const cases = [
    ["HTTP 500 GH_ERROR: gh 실패", { status: 500, code: "GH_ERROR", message: "gh 실패" }],
    ["HTTP 404", { status: 404, code: "", message: "HTTP 404" }],
    ["RUN_BUSY: 다른 작업", { status: 0, code: "RUN_BUSY", message: "다른 작업" }],
    ["cpt.sock 연결 실패(데몬 미기동?): x", { status: 0, code: "", message: "cpt.sock 연결 실패(데몬 미기동?): x" }],
  ];
  for (const [s, want] of cases) ok(JSON.stringify(parseCodedError(new Error(s))) === JSON.stringify(want), `parseCodedError(${JSON.stringify(s)})`,
    JSON.stringify(parseCodedError(s)));
}

// ── 8. 타임아웃 표 = §3.3 (그리고 back TASK_RPC_OK 가 있으면 그것과도) ───────────────────
{
  const DOC = {
    "task.list": 15000, "task.get": 15000, "task.create": 15000, "task.run.prompt": 20000, "task.run.trust": 15000,
    "task.run.reopen": 15000, "task.diff": 30000, "task.discard": 15000, "task.delete": 15000,
    "git.branches": 15000, "git.status": 15000, "git.commit": 15000, "git.push": 15000,
    "git.pr.create": 15000, "git.pr.status": 30000, "git.pr.merge": 15000, "git.merge.local": 15000, "git.gh.status": 15000,
  };
  ok(JSON.stringify(TASK_TIMEOUTS) === JSON.stringify(DOC), "PC 타임아웃 표 = 설계 §3.3 allow-list(18개)");
  ok([...TASK_READS].every((m) => DOC[m] != null) && !TASK_READS.has("git.pr.merge") && !TASK_READS.has("task.create"),
    "읽기 목록(재시도 허용)에 변이가 섞이지 않는다");
  ok(["E2EE_RELAY_FAILED", "E2EE_EPOCH_MISMATCH", "E2EE_DECRYPT_FAILED", "TIMEOUT", ""].every((c) => !SEALED_FALLBACK_CODES.has(c)),
    "폴백 허용 코드에 결과 불명 코드가 없다");
  const back = path.resolve("../codingpt_back/controllers/daemonController.js");
  const src = fs.existsSync(back) ? fs.readFileSync(back, "utf8") : "";
  const m = /const TASK_RPC_OK = new Map\(\[([\s\S]*?)\]\);/.exec(src);
  if (!m) console.log("SKIP back TASK_RPC_OK 대조 — 아직 없음");
  else {
    const entries = Object.fromEntries([...m[1].matchAll(/\['([\w.]+)',\s*(\d+)\]/g)].map((x) => [x[1], Number(x[2])]));
    ok(JSON.stringify(Object.keys(entries).sort()) === JSON.stringify(Object.keys(DOC).sort())
      && Object.keys(DOC).every((k) => entries[k] === DOC[k]), "back TASK_RPC_OK 와 PC 표가 같다(메서드·타임아웃)", JSON.stringify(entries));
  }
}

// ── 9. 데몬이 back 의 code/status 를 보존(e2ee-local rpc) — 501 구조적 코드는 평문 폴백, 409 는 DAEMON_OFFLINE ──
for (const [msg, label] of [
  ["E2EE_NO_KEY: 상대 PC 에 열쇠가 없습니다 (HTTP 501)", "상대 PC 열쇠 없음(501 E2EE_NO_KEY)"],
  ["E2EE_DISABLED: 꺼짐 (HTTP 501)", "상대 PC 정책 off(501 E2EE_DISABLED)"],
  ["E2EE_UNSUPPORTED: Not Found (HTTP 404)", "구 back(코드 없는 404 → E2EE_UNSUPPORTED)"],
]) {
  const { api, calls } = rig({ sealed: () => coded(msg) });
  const r = await api.taskRpc("task.list", {}, 7);
  ok(r && r.via === "plain" && calls.plain.length === 1, `${label} → 평문 폴백`);
  await api.taskRpc("task.list", {}, 7);
  ok(calls.sealed.length === 1, `${label} → 호스트별 네거티브 캐시(다음 호출은 봉인 시도 안 함)`);
}
{
  const { api, calls } = rig({ sealed: () => coded("DAEMON_OFFLINE: PC 데몬이 연결되어 있지 않습니다. (HTTP 409)") });
  ok(await codeOf(api.taskRpc("task.list", {}, 7)) === "DAEMON_OFFLINE" && !calls.plain.length,
    "409 → DAEMON_OFFLINE(호스트 오프라인 문구), 평문 재전송 없음");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
