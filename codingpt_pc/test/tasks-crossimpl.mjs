// tasks-crossimpl.mjs — Agent Tasks 현황판 판정의 **PC ↔ 앱 ↔ 계약 픽스처** 고정(설계 §5·§7.3·§8.5).
//
// 무엇이 조용히 망가지나:
//  ① 같은 입력에서 PC 와 폰이 다른 그룹·다른 순서를 그린다("PC 에서는 입력 대기인데 폰에서는 대기 중").
//     → docs/fixtures/agent-tasks/model-*.json(기대값은 손으로 적은 값)을 PC 모델과 앱 모델에 똑같이 먹인다.
//  ② 에러 code → 문구 표(ERROR_KEY)가 기기마다 다르거나 §2.13 코드가 빠진다 → 한쪽에서만 "실패했어요".
//  ③ 작업 워크스페이스 술어가 갈려 한쪽 사이드바에만 worktree 가 보인다.
//  ④ 전송 배관(ui_command 핸들러·Rust 울타리)이 빠져 기능이 "조용히" 안 온다.
//
// 규율: 데몬을 기동하지 않는다. 형제 리포(앱)가 없거나 아직 그 파일이 없으면 SKIP 하되 세어서 남기고,
//  `CPT_CROSSIMPL_STRICT=1` 이면 SKIP 을 실패로 승격한다(e2ee-crossimpl 과 같은 규칙).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PC = path.resolve("src/js");
const TAURI = path.resolve("src-tauri/src");
const APP = path.resolve("../../codingpt_app/src");
const FIX = process.env.CPT_FIXTURES || path.resolve("../codingpt_daemon/docs/fixtures/agent-tasks");
const STRICT = /^(1|true|yes|on)$/i.test(String(process.env.CPT_CROSSIMPL_STRICT || ""));

let pass = 0, fail = 0;
const skipped = [];
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };
const skip = (n, why) => { skipped.push(n); console.log(`SKIP ${n}${why ? " — " + why : ""}`); };
const read = (p) => fs.readFileSync(p, "utf8");

const M = await import(path.join(PC, "tasks-model.js"));
const TX = await import(path.join(PC, "text/tasks.js"));

// ── 1. 모델 픽스처 — PC ─────────────────────────────────────────────────────────
const files = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => /^model-\d+.*\.json$/.test(f)).sort() : [];
ok(files.length >= 10, `모델 픽스처 ${files.length}개(필수 10개 이상, §8.5)`, FIX);
const fixtures = files.map((f) => ({ file: f, ...JSON.parse(read(path.join(FIX, f))) }));
for (const fx of fixtures) {
  const got = M.summarize(M.buildDashboard(fx.input));
  ok(JSON.stringify(got) === JSON.stringify(fx.expect), `PC ${fx.file} — ${fx.description || fx.name}`,
    `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(fx.expect)}`);
}

// §8.5 필수 케이스가 픽스처 안에 실제로 있는가(규칙마다 1개 이상) — 기대값 쪽에서 센다.
{
  const reasons = new Set(fixtures.flatMap((f) => Object.values(f.expect.reasons || {})));
  for (const r of ["failed", "promptNotDelivered", "interrupted", "trust", "terminalGone", "agentGone", "permission", "needsInput", "approval", "keptDirty", "opFailed"]) {
    ok(reasons.has(r), `§5.3 규칙 1 의 항목 '${r}' 을 다루는 픽스처가 있다`);
  }
  const groupsCovered = new Set(fixtures.flatMap((f) => Object.entries(f.expect.groups).filter(([, v]) => v.length).map(([g]) => g)));
  for (const g of M.GROUPS) ok(groupsCovered.has(g), `그룹 '${g}' 을 채우는 픽스처가 있다`);
  ok(fixtures.some((f) => (f.expect.offline || []).length), "오프라인 host 픽스처가 있다");
  ok(fixtures.some((f) => (f.input.agentSnaps || []).some((s) => s.host === 0)), "host 0 스냅 dedupe 픽스처가 있다");
}

// ── 2. 모델 픽스처 — 앱(같은 파일, 앱 TS 원본을 그대로 실행) ───────────────────────────
//  앱은 행에 `reason` 이 없다(카드가 그때그때 판정) → 대조는 그룹별 k 순서·오프라인 host·미읽음.
//  종결 작업 행 키는 두 구현 모두 픽스처 형 `${host}|task:${id}` — 접지 않고 그대로 비교한다(어긋나면 여기서 깨진다).
const APP_MODEL = path.join(APP, "workspace/tasks/tasksModel.ts");
let seq = 0;
function probe(modPath, body) {
  const tmp = path.join(os.tmpdir(), `tasksprobe-${process.pid}-${seq++}.mjs`);
  fs.writeFileSync(tmp, `const m = await import(${JSON.stringify("file://" + modPath)});\n${body}`);
  try {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}
if (!fs.existsSync(APP_MODEL)) {
  skip("앱 tasksModel 대조", "codingpt_app/src/workspace/tasks/tasksModel.ts 없음");
} else {
  let appOut = null;
  try {
    appOut = probe(APP_MODEL, `
      const fx = ${JSON.stringify(fixtures.map((f) => f.input))};
      const G = ${JSON.stringify(M.GROUPS)};
      const out = fx.map((input) => {
        const r = (m.buildTasksModel || m.buildDashboard)(input);
        const groups = {}; const unread = {};
        for (const g of G) { groups[g] = (r.groups[g] || []).map((x) => x.k); for (const x of r.groups[g] || []) if (x.unread) unread[x.k] = x.unread; }
        const offline = (r.offlineHosts || r.offline || []).map((h) => typeof h === 'object' ? h.id : h);
        return { groups, unread, offline };
      });
      console.log(JSON.stringify(out));`);
  } catch (e) {
    skip("앱 tasksModel 대조", "앱 모델을 실행하지 못함: " + String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l)));
  }
  if (appOut) {
    fixtures.forEach((fx, i) => {
      const a = appOut[i];
      const { groups, unread } = a;
      const want = { groups: fx.expect.groups, unread: fx.expect.unread, offline: fx.expect.offline };
      ok(JSON.stringify({ groups, unread, offline: a.offline }) === JSON.stringify(want), `앱 ${fx.file} — 그룹·순서·미읽음·오프라인이 PC 와 같다`,
        `\n   app  ${JSON.stringify({ groups, unread, offline: a.offline })}\n   want ${JSON.stringify(want)}`);
    });
  }
}

// ── 3. 작업 워크스페이스 술어(§4) ────────────────────────────────────────────────
ok(M.isTaskWorkspace({ localPath: ".codingpt/worktrees/app-x2m1qa-1" }), "술어: .codingpt/worktrees/ 아래 = 작업 워크스페이스");
ok(M.isTaskWorkspace({ localPath: ".codingpt/worktrees/app-x2m1qa-1/codingpt_back" }), "술어: 모노레포 subdir run.cwd 도 작업 워크스페이스");
ok(!M.isTaskWorkspace({ localPath: "work/.codingpt/worktrees/x" }) && !M.isTaskWorkspace({ localPath: ".codingpt/worktreesX" })
  && !M.isTaskWorkspace({ localPath: null }) && !M.isTaskWorkspace(null), "술어: 접두 일치만(중간 일치·유사 접두·null 아님)");
{
  const st = read(path.join(PC, "state.js"));
  ok(/export function sortedWorkspaces\(\)[\s\S]{0,400}\.filter\(\(w\) => !isTaskWorkspace\(w\)\)/.test(st),
    "PC 기본 셀렉터(sortedWorkspaces)가 작업 워크스페이스를 거른다(§4 — 개별 뷰가 아니라 셀렉터에서)");
  ok(/if \(tm && isTaskWorkspace\(tm\)\) return;/.test(st) && /opts && opts\.allowTask/.test(st),
    "setActive 는 작업 워크스페이스를 allowTask 없이 열지 않는다");
  ok(/export function listAgentSnaps\(\)/.test(st) && /host: v\.hostDeviceId \?\? 0/.test(st) && /since: v\.since \?\? null/.test(st),
    "listAgentSnaps: host 모름 = 0 · since 보존(§5.1)");
}
{
  // 앱은 술어를 services/taskService.ts 에 두고 WorkspaceShellContext 가 재노출한다 — 정의가 있는 파일을 찾아 본다.
  const cands = ["services/taskService.ts", "contexts/WorkspaceShellContext.tsx"].map((f) => path.join(APP, f)).filter((f) => fs.existsSync(f));
  const def = cands.map(read).find((src) => /function isTaskWorkspace|const isTaskWorkspace\s*=\s*\(/.test(src));
  if (!def) skip("앱 isTaskWorkspace 정규식", "정의 없음");
  else ok(/\^\\\.codingpt\\\/worktrees\\\//.test(def), "앱 isTaskWorkspace 도 같은 접두 정규식(^\\.codingpt\\/worktrees\\/)");
}

// ── 4. 주 행동 결정표(§6.7 B) — 7행 전부 ────────────────────────────────────────
{
  const gh = (i, a) => ({ ghInstalled: i, ghAuthed: a });
  const T0 = { repo: { github: null } };
  const T1 = { repo: { github: { owner: "o", repo: "r" } } };
  const pr = (state, mergeable = "MERGEABLE") => ({ number: 1, state, mergeable, checks: { status: "passing" } });
  const rows = [
    [T0, {}, gh(true, true), "mergeLocal", null],
    [T1, {}, gh(false, false), "mergeLocal", "ghMissing"],
    [T1, {}, gh(true, false), "ghLogin", null],
    [T1, {}, gh(true, true), "createPr", null],
    [T1, { pr: pr("open") }, gh(true, true), "mergePr", null],
    [T1, { pr: pr("closed") }, gh(true, true), "createPr", "prClosed"],
    [T1, { pr: pr("merged") }, gh(true, true), "none", null],
  ];
  const got = rows.map(([task, run, g]) => { const r = M.primaryAction({ task, run, gh: g }); return [r.primary, r.hint]; });
  ok(JSON.stringify(got) === JSON.stringify(rows.map((r) => [r[3], r[4]])), "결정표 7행의 주 행동·안내가 §6.7 B 와 같다", JSON.stringify(got));
  ok(M.primaryAction({ task: T1, run: { pr: pr("open", "CONFLICTING") }, gh: gh(true, true) }).mergeDisabled === true,
    "PR 이 mergeable 이 아니면 [PR 머지] 비활성");
  ok(M.runLocked({ live: { state: "working" }, run: { op: null } }) && M.runLocked({ live: null, run: { op: { opId: "x" } } })
    && !M.runLocked({ live: { state: "idle" }, run: { op: null } }), "변이 잠금 = 라이브 working 또는 op 진행 중(§6.0)");
}

// ── 5. 에러 code → 문구(§2.13 · §9 ERROR_KEY) ──────────────────────────────────
const CODES_213 = ["BAD_PARAMS", "PROMPT_TOO_LARGE", "TASK_NOT_FOUND", "RUN_NOT_FOUND", "TASK_CLOSED", "TASKS_DISABLED",
  "NOT_A_REPO", "BASE_NOT_FOUND", "BASE_MOVED", "TASK_LIMIT", "AGENT_NOT_INSTALLED", "GIT_MISSING", "GIT_CLT_MISSING",
  "GH_MISSING", "GH_NOT_AUTHED", "GH_ERROR", "NOT_GITHUB", "NO_REMOTE", "WORKTREE_ADD_FAILED", "WORKTREE_MISSING",
  "WORKTREE_REMOVE_FAILED", "AGENT_LAUNCH_FAILED", "LAUNCH_BUSY", "PROMPT_NOT_DELIVERED", "TERMINAL_GONE",
  "UNCOMMITTED_CHANGES", "UNMERGED_COMMITS", "NOTHING_TO_COMMIT", "NOTHING_TO_PR", "GIT_IDENTITY_MISSING", "GIT_LOCKED",
  "COMMIT_HOOK_FAILED", "GIT_SIGN_FAILED", "PUSH_REJECTED", "AUTH_FAILED", "PR_NOT_FOUND", "PR_NOT_MERGEABLE",
  "CHECKS_FAILING", "MAIN_DIRTY", "AGENT_BUSY", "MERGE_CONFLICT", "RUN_BUSY", "OP_INTERRUPTED", "TIMEOUT"];
{
  const keys = Object.keys(TX.ERROR_KEY).sort();
  ok(JSON.stringify(keys) === JSON.stringify([...CODES_213].sort()), `ERROR_KEY 의 code 집합 = §2.13 (${CODES_213.length}개)`,
    `빠짐=${CODES_213.filter((c) => !keys.includes(c))} 남음=${keys.filter((c) => !CODES_213.includes(c))}`);
  const bad = Object.entries(TX.ERROR_KEY).filter(([, f]) => TX.TASKS_TEXT.ko[f] == null);
  ok(bad.length === 0, "ERROR_KEY 의 모든 값이 문구 사전의 필드다", bad.map(([c, f]) => `${c}→${f}`).join(","));
  const rpcErr = path.join(FIX, "rpc-errors.json");
  if (fs.existsSync(rpcErr)) {
    const j = JSON.parse(read(rpcErr));
    const codes = new Set((Array.isArray(j) ? j : j.codes || (j.errors || []).map((e) => e.code) || []).map((c) => (typeof c === "string" ? c : c.code)));
    const missing = [...codes].filter((c) => c && !TX.ERROR_KEY[c]);
    ok(missing.length === 0, "데몬 rpc-errors.json 의 모든 code 가 ERROR_KEY 에 있다", missing.join(","));
  } else {
    skip("rpc-errors.json 대조", "데몬 픽스처 아직 없음");
  }
}
const APP_TEXT = path.join(APP, "text/tasks.ts");
if (!fs.existsSync(APP_TEXT)) skip("앱 text/tasks.ts 대조", "없음");
else {
  let app = null;
  try {
    app = probe(APP_TEXT, "console.log(JSON.stringify({ ko: (m.TASKS_TEXT && m.TASKS_TEXT.ko) || null, err: m.ERROR_KEY || null }));");
  } catch (e) { skip("앱 text/tasks.ts 대조", "실행 실패"); }
  if (app) {
    ok(JSON.stringify(app.err) === JSON.stringify(Object.fromEntries(Object.keys(app.err || {}).map((k) => [k, TX.ERROR_KEY[k]])))
      && Object.keys(app.err || {}).length === Object.keys(TX.ERROR_KEY).length, "앱 ERROR_KEY == PC ERROR_KEY(code → 필드명)");
    // 앱은 자리표시자 문구를 `(n) => i18n.t('파일 {n}개', { n })` 함수로 둔다 → 소스에서 원문을 오려 문자열 필드와 합친다.
    const appSrc = read(APP_TEXT);
    const fnSrc = {};
    for (const m of appSrc.matchAll(/^\s{4}(\w+):\s*\([^)]*\)\s*=>\s*i18n\.t\((['"])((?:(?!\2).)+)\2/gm)) fnSrc[m[1]] = m[3];
    const a = { ...fnSrc, ...Object.fromEntries(Object.entries(app.ko || {}).filter(([, v]) => typeof v === "string")) };
    const p = TX.TASKS_TEXT.ko;
    const diff = Object.keys(p).filter((k) => a[k] !== undefined && a[k] !== p[k]);
    const onlyPc = Object.keys(p).filter((k) => a[k] === undefined);
    ok(diff.length === 0, "앱·PC 문구 사전의 같은 필드는 원문이 같다(§9)", diff.slice(0, 4).map((k) => `${k}: ${a[k]} vs ${p[k]}`).join(" | "));
    ok(onlyPc.length === 0, "§9 필드가 앱 사전에도 전부 있다", onlyPc.join(","));
  }
}

// ── 6. 배관 — ui_command 핸들러 · Rust 울타리 · 알림 라우팅 ─────────────────────────
{
  const ui = read(path.join(PC, "ui-channel.js"));
  ok(/"tasks\.changed": async \(p\) => \{[\s\S]{0,200}return \{ ok: true \};/.test(ui),
    "ui-channel: tasks.changed 핸들러가 ok 로 회신한다(executor 무응답 = 데몬 UI_TIMEOUT, §2.8)");
  ok(/uiCmds: \[\.\.\.Object\.keys\(handlers\)/.test(ui), "ui-channel: uiCmds 는 핸들러 표에서 뽑는다(tasks.changed 가 자동 광고)");
  const rs = read(path.join(TAURI, "cptsock.rs"));
  const lib = read(path.join(TAURI, "lib.rs"));
  ok(/pub async fn task_local\(/.test(rs) && /spawn_blocking\(move \|\| cpt_request_timed\(&cmd, args, true, 35\)\)/.test(rs),
    "cptsock.rs task_local: async + spawn_blocking, 35초, with_code=true");
  ok(/!cmd\.starts_with\("task\."\) && !cmd\.starts_with\("git\."\) && !sealed_task/.test(rs)
    && /m\.starts_with\("task\."\) \|\| m\.starts_with\("git\."\)/.test(rs), "cptsock.rs task_local 울타리: task./git. + 봉인은 method 가 task./git. 일 때만");
  ok(/cptsock::task_local,/.test(lib), "lib.rs 핸들러 등록");
  // notifications.js 는 api.js(window.__TAURI__) 를 import 해 node 에서 못 연다 → 함수 소스만 오려 실행한다.
  const ns = read(path.join(PC, "notifications.js"));
  const fn = ns.slice(ns.indexOf("export function parseTaskDeeplink"), ns.indexOf("export function isTaskNotif"));
  const parse = new Function(`${fn.replace("export function", "function")}; return parseTaskDeeplink;`)();
  ok(JSON.stringify(parse("codingpt://task/t_abc?host=12&run=r_1")) === JSON.stringify({ taskId: "t_abc", host: 12, runId: "r_1" })
    && JSON.stringify(parse("codingpt://task/t_abc")) === JSON.stringify({ taskId: "t_abc", host: null, runId: null })
    && parse("codingpt://approval/x") === null && parse("") === null, "딥링크 파서 codingpt://task/<id>?host=&run=(§6.9 와 같은 모양)");
  const sb = read(path.join(PC, "sidebar.js"));
  ok(/const tgt = taskNotifTarget\(n\);\s*\n\s*if \(tgt\) \{\s*\n\s*openTasksDashboard\(tgt\)/.test(sb), "알림 점프: task_* 는 현황판으로(cwd/win 라우팅 아님, §4)");
}

// ── 회귀(2026-09-29 리뷰) — DOM 없이 소스 계약으로 고정 ─────────────────────────────
{
  const tv = read(path.join(PC, "tasks-view.js"));
  const td = read(path.join(PC, "task-detail.js"));
  const nts = read(path.join(PC, "new-task-sheet.js"));
  const sb = read(path.join(PC, "sidebar.js"));
  const uc = read(path.join(PC, "ui-channel.js"));
  const ta = read(path.join(PC, "tasks-api.js"));
  const mainJs = read(path.join(PC, "main.js"));
  const bridge = read(path.join(TAURI, "bridge.rs"));
  const lib = read(path.join(TAURI, "lib.rs"));
  // tasks.changed {host:null} — 유령 호스트 0 금지
  const oc = tv.slice(tv.indexOf("export function onTasksChanged"), tv.indexOf("// 60초 폴링"));
  const calls = [];
  const run = new Function("refreshAll", "refreshHost", "changedTimers", "setTimeout", "clearTimeout",
    `${oc.replace("export function", "function")}; return onTasksChanged;`)(
    () => calls.push("all"), (h) => calls.push(h), new Map(), (fn) => { fn(); return 0; }, () => {});
  try { run({ host: null }); run({ host: "" }); run({}); } catch (e) { calls.push("throw:" + e.message); }
  ok(calls.length === 3 && calls.every((c) => c === "all"), "tasks.changed host:null/''/없음 → 전체 새로고침(호스트 0 조회 금지)", JSON.stringify(calls));
  // 통째 재렌더 금지 — 목록/상세 분리 + 스크롤 보존 + 편집 중 상세 미룸
  ok(/detailBusy\(det\)/.test(tv) && /\.rv-cbox/.test(tv) && /fresh\.scrollTop = top/.test(tv) && /det\.scrollTop = top/.test(tv),
    "현황판: 목록·상세 따로 갱신, 스크롤 보존, 리뷰 코멘트 입력 중엔 상세를 다시 그리지 않는다");
  ok(!/Math\.floor\(\(Date\.now\(\) - r\.waitSince\) \/ 60000\)\]\)\)/.test(tv) && /r\.group === "needs_input" \? Math\.floor/.test(tv),
    "분 단위 시그니처는 입력 대기 행에만");
  ok(/openAppr/.test(tv), "승인 인라인 박스는 목록 재렌더 뒤에도 다시 연다");
  ok(/v\.gh\]/.test(tv) && /ghLiteOf\(sel\.host\)/.test(tv), "gh 상태가 시그니처에 있다([다시 확인] 후 갱신)");
  ok(/hostErrs/.test(tv) && /errText\(v\.error\.code\)/.test(tv), "task.list 실패는 호스트별 배너(빈 목록을 '작업 없음'으로 덮지 않는다)");
  ok(/\(tag === "BUTTON" \|\| tag === "SUMMARY" \|\| tag === "A"\) && \(e\.key === "Enter"/.test(tv), "버튼 위 Enter 는 가로채지 않는다");
  ok(/serverOff \|\| isLocalHostId|!serverOff \|\| isLocalHostId/.test(tv) && /serverHasTasks\(\) !== false \|\| isLocalHostId/.test(nts),
    "서버 킬스위치면 다른 PC 는 조회·선택 대상에서 뺀다(이 PC 는 로컬 소켓)");
  ok(/ui\.onFail\?\.\("TIMEOUT"\)/.test(td) && /reconcileOps\(task\)/.test(td), "op 대기 시간 초과 → 시트 재활성 + 뒤늦은 마감 정리");
  ok(/if \(!ghKnown\b/.test(td), "gh 상태 모름이면 'gh 없음' 안내를 단정하지 않는다");
  ok(/opId: st\.opId/.test(nts) && /isUncertain\(code\)/.test(nts), "새 작업: 결과 불명 실패 뒤 재시도는 같은 opId");
  ok(/my !== branchSeq/.test(nts) && /my !== agentSeq/.test(nts), "새 작업: 늦게 온 브랜치/에이전트 응답은 버린다");
  ok(/S\.isTaskWorkspace\(ws\)[\s\S]{0,400}openRunTerminal\(ws\.id/.test(sb), "작업 run 터미널의 일반 알림 → openRunTerminal(task:true)");
  ok((uc.match(/S\.setActive\([^)]*\{ allowTask: true \}\)/g) || []).length >= 4, "ui-channel requireWs/requireWsOrActive/wsSelect 는 allowTask");
  ok(/backApiAsync\(o\.method/.test(ta) && !/api\.backApi\("GET"/.test(ta), "작업 평문 경로·caps 조회는 비동기 back_api(메인 스레드 금지)");
  ok(/pub async fn back_api_async/.test(bridge) && /spawn_blocking\(move \|\| back_api\(/.test(bridge) && /bridge::back_api_async/.test(lib), "Rust back_api_async = spawn_blocking + 등록");
  ok(/if \(state\.paired\) startTasksBackground\(\); \}\);/.test(mainJs), "로그인/페어링 뒤에도 작업 배경 폴링 시작");
}

const sk = skipped.length;
if (STRICT && sk) fail += sk;
console.log(`\n${fail === 0 ? "ALL CONFORMANT" : "NOT CONFORMANT"} — pass ${pass} / fail ${fail}${sk ? ` (${sk} SKIPPED${STRICT ? " → STRICT 실패" : ""})` : ""}`);
process.exit(fail === 0 ? 0 : 1);
