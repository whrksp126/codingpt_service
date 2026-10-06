// automations-crossimpl.mjs — 자동화 번들(automation-design §9.3)의 **PC ↔ 앱 ↔ 계약 픽스처** 고정.
//
// 무엇이 조용히 망가지나:
//  ① 같은 자동화 목록에서 PC 와 폰이 다른 그룹·점·순서를 그린다 → auto-*.json 을 두 모델에 똑같이 먹인다.
//  ② 전송 배관이 빠진다 — ui_command 핸들러(automations/dispatch/power.changed)가 ok 로 회신하지 않으면 데몬이
//     UI_TIMEOUT 을 본다. Rust 울타리(auto_local)가 power.event 를 통과시키면 원격 기기가 잠자기를 주장할 수 있다.
//  ③ 로컬 소켓 게이트 거절(OUT_OF_CONTEXT)에서 원격 경로 폴백이 없거나, 도메인 실패를 평문으로 재전송한다(이중 실행).
//  ④ 알림 딥링크(codingpt://auto/…, codingpt://tasks?host=)가 엉뚱한 곳으로 간다.
// 규율: 데몬을 기동하지 않는다. 앱 파일이 없으면 SKIP(`CPT_CROSSIMPL_STRICT=1` 이면 실패로 승격).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PC = path.resolve("src/js");
const TAURI = path.resolve("src-tauri/src");
const APP = path.resolve("../../codingpt_app/src");
const FIX = process.env.CPT_AUTO_FIXTURES || path.resolve("../codingpt_daemon/docs/fixtures/automation");
const DOC = path.resolve("../codingpt_daemon/docs/automation-design.md");
const STRICT = /^(1|true|yes|on)$/i.test(String(process.env.CPT_CROSSIMPL_STRICT || ""));

let pass = 0, fail = 0;
const skipped = [];
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };
const skip = (n, why) => { skipped.push(n); console.log(`SKIP ${n}${why ? " — " + why : ""}`); };
const read = (p) => fs.readFileSync(p, "utf8");

const M = await import(path.join(PC, "automations-model.js"));

// ── 1. 모델 픽스처 — PC ─────────────────────────────────────────────────────────
const files = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((f) => /^auto-\d+.*\.json$/.test(f)).sort() : [];
ok(files.length >= 2, `자동화 모델 픽스처 ${files.length}개(auto-01·02, §8.2)`, FIX);
const fixtures = files.map((f) => ({ file: f, ...JSON.parse(read(path.join(FIX, f))) }));
for (const fx of fixtures) {
  const got = M.summarizeAuto(M.buildAutomations(fx.input));
  ok(JSON.stringify(got) === JSON.stringify(fx.expect), `PC ${fx.file} — ${fx.name}`,
    `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(fx.expect)}`);
}
// 규칙 자체(두 구현이 똑같이 틀리는 경우를 잡는다)
{
  const base = { now: 0, items: [
    { id: "a", name: "b", enabled: true, paused: false, trigger: { type: "schedule", cron: "0 9 * * *", tz: "Asia/Seoul" }, state: { nextRunAt: 5, inflight: 1, lastResult: { ok: false } } },
    { id: "b", name: "a", enabled: true, paused: false, trigger: { type: "git.commits", branch: "main" }, state: { nextRunAt: null } },
    { id: "c", name: "c", enabled: false, paused: false, trigger: { type: "schedule", at: 9 }, state: {} },
  ], paused: true, hostOnline: false };
  const out = M.buildAutomations(base);
  ok(out.rows[0].id === "a" && out.rows[0].dot === "error", "attention 이 spin 보다 먼저(점 error)");
  ok(out.rows.find((r) => r.id === "c").group === "paused", "enabled:false → paused 그룹");
  ok(out.rows.filter((r) => r.group === "active").length === 2, "전체 일시정지(input.paused)·hostOnline:false 는 행 그룹을 바꾸지 않는다");
  ok(M.triggerOf({ type: "github.issues", labels: ["bug", "p1"] }).vars.labels === "bug, p1", "이슈 라벨은 쉼표로");
  ok(M.triggerOf({ type: "schedule", at: 9 }).key === "trigOnce" && M.triggerOf({ type: "schedule", cron: "* * * * *" }).key === "trigSchedule", "schedule: cron → trigSchedule, at → trigOnce");
}

// ── 2. 모델 픽스처 — 앱(TS 원본 실행) ─────────────────────────────────────────────
const APP_MODEL = path.join(APP, "workspace/automations/automationsModel.ts");
let seq = 0;
function probe(modPath, body) {
  const tmp = path.join(os.tmpdir(), `autoprobe-${process.pid}-${seq++}.mjs`);
  fs.writeFileSync(tmp, `const m = await import(${JSON.stringify("file://" + modPath)});\n${body}`);
  try {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}
if (!fs.existsSync(APP_MODEL)) skip("앱 automationsModel 대조", "없음");
else {
  let appOut = null;
  try {
    appOut = probe(APP_MODEL, `const fx = ${JSON.stringify(fixtures.map((f) => f.input))};
      console.log(JSON.stringify(fx.map((i) => m.summarizeAuto((m.buildAutomationsModel || m.buildAutomations)(i)))));`);
  } catch (e) { skip("앱 automationsModel 대조", "실행 실패: " + String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l))); }
  if (appOut) fixtures.forEach((fx, i) => ok(JSON.stringify(appOut[i]) === JSON.stringify(fx.expect), `앱 ${fx.file} — PC 와 같은 요약`, JSON.stringify(appOut[i])));
}

// ── 3. 문구 사전 — §11 원문 그대로, 앱과 같은 필드·원문 ──────────────────────────────
{
  const AX = await import(path.join(PC, "text/automations.js"));
  const doc = fs.existsSync(DOC) ? read(DOC) : "";
  const block = doc.slice(doc.indexOf("**`text/automations.{js,ts}` — `AUTO_TEXT.ko`**"), doc.indexOf("**`text/tasks.{js,ts}` 추가분**"));
  const want = {};
  for (const m of block.matchAll(/^(\w+):\s+(.+?)\s+\|\s/gm)) want[m[1]] = m[2];
  if (!Object.keys(want).length) skip("AUTO_TEXT = §11 대조", "설계 문서 없음");
  else {
    const diff = Object.keys(want).filter((k) => AX.AUTO_TEXT.ko[k] !== want[k]);
    const extra = Object.keys(AX.AUTO_TEXT.ko).filter((k) => !(k in want));
    ok(diff.length === 0 && extra.length === 0, `AUTO_TEXT.ko = 설계 §11 (${Object.keys(want).length}개, 필드·원문)`,
      diff.slice(0, 4).map((k) => `${k}: ${AX.AUTO_TEXT.ko[k]} vs ${want[k]}`).join(" | ") + (extra.length ? " 남음=" + extra : ""));
  }
  const APP_TEXT = path.join(APP, "text/automations.ts");
  if (!fs.existsSync(APP_TEXT)) skip("앱 text/automations.ts 대조", "없음");
  else {
    const src = read(APP_TEXT);
    const a = {};
    for (const m of src.matchAll(/^\s{4}(\w+):\s*(?:\([^)]*\)\s*=>\s*i18n\.t\()?(['"])((?:(?!\2).)*)\2/gm)) a[m[1]] = m[3];
    const miss = Object.keys(AX.AUTO_TEXT.ko).filter((k) => a[k] === undefined);
    const diff = Object.keys(AX.AUTO_TEXT.ko).filter((k) => a[k] !== undefined && a[k] !== AX.AUTO_TEXT.ko[k]);
    ok(miss.length === 0 && diff.length === 0, "앱 AUTO_TEXT 와 PC 가 같은 필드·같은 원문", `빠짐=${miss.slice(0, 5)} 다름=${diff.slice(0, 5)}`);
  }
  // 에러 code 가 모두 문구로 풀린다(없는 code 는 errGeneric) — 데몬 rpc-errors-automation.json 전체.
  const TX = await import(path.join(PC, "text/tasks.js"));
  const errFx = path.join(FIX, "rpc-errors-automation.json");
  if (!fs.existsSync(errFx)) skip("rpc-errors-automation 대조", "없음");
  else {
    const j = JSON.parse(read(errFx));
    const codes = [...j.auto, ...j.dispatch, ...j.power, ...j.followup];
    const mapped = codes.filter((c) => TX.ERROR_KEY[c] || TX.AUTO_ERROR_KEY[c]);
    ok(["auto", "power", "followup"].every((k) => j[k].every((c) => TX.AUTO_ERROR_KEY[c])), "auto·power·followup 코드는 전부 AUTO_ERROR_KEY 에 있다",
      ["auto", "power", "followup"].flatMap((k) => j[k]).filter((c) => !TX.AUTO_ERROR_KEY[c]).join(","));
    ok(codes.every((c) => typeof TX.errText(c) === "string" && TX.errText(c).length > 0), `자동화 코드 ${codes.length}개 모두 문구로 풀린다(매핑 ${mapped.length})`);
  }
}

// ── 4. 전송 — createAutoApi(봉인 우선·평문은 /api/daemon/auto·로컬 게이트 폴백) ─────────────────
{
  const { createAutoApi } = await import(path.join(PC, "automations-api.js"));
  const mk = (over = {}) => {
    const calls = [];
    const d = {
      local: async (cmd, args) => { calls.push(["local", cmd, args && args.method]); return over.local ? over.local(cmd, args) : { items: [] }; },
      backApi: async (o) => { calls.push(["plain", o.path, o.body.method, o.body.hostDeviceId]); return over.plain ? over.plain(o) : { success: true, data: { via: "plain" } }; },
      e2ee: () => over.e2ee || { ready: false, policy: "preferred" },
      isLocalHost: (h) => h == null || h === 11,
      selfId: () => 11,
    };
    return { api: createAutoApi(d), calls };
  };
  { const { api, calls } = mk(); await api.autoRpc("auto.list", {}, 11);
    ok(calls.length === 1 && calls[0][0] === "local" && calls[0][1] === "auto.list", "이 PC → auto_local 직결"); }
  { const { api, calls } = mk(); const r = await api.autoRpc("auto.list", {}, 12);
    ok(calls[0][0] === "plain" && calls[0][1] === "/api/daemon/auto" && calls[0][3] === 12 && r.via === "plain", "다른 PC(봉인 불가) → 평문 POST /api/daemon/auto {hostDeviceId}"); }
  { const { api, calls } = mk({ local: (cmd) => { if (cmd === "auto.list") throw new Error("OUT_OF_CONTEXT: CodingPT 워크스페이스 밖입니다"); return { ok: true }; } });
    const r = await api.autoRpc("auto.list", {}, 11);
    ok(calls.length === 2 && calls[1][0] === "plain" && calls[1][3] === 11 && r.via === "plain", "★ 로컬 게이트 거절(OUT_OF_CONTEXT = 실행 전) → 같은 PC 를 원격 경로로 재시도", JSON.stringify(calls)); }
  { const { api, calls } = mk({ local: () => { throw new Error("AUTO_LOOP: 자동화가 만든 작업"); } });
    let code = ""; try { await api.autoRpc("auto.create", {}, 11); } catch (e) { code = e.code; }
    ok(code === "AUTO_LOOP" && calls.length === 1, "★ 로컬 도메인 실패는 code 보존·재전송 0회"); }
  { const { api, calls } = mk({ e2ee: { ready: true, policy: "preferred" }, local: (cmd, args) => { if (cmd === "e2ee.rpc") return { ok: false, code: "AUTO_BUSY", e: "busy" }; return {}; } });
    let code = ""; try { await api.autoRpc("auto.update", { id: "a" }, 12); } catch (e) { code = e.code; }
    ok(code === "AUTO_BUSY" && calls.length === 1 && calls[0][1] === "e2ee.rpc" && calls[0][2] === "auto.update", "★ 봉인 경로의 도메인 실패 → code 보존, 평문 재전송 0회"); }
  { const { api, calls } = mk({ e2ee: { ready: true, policy: "preferred" }, local: (cmd) => { if (cmd === "e2ee.rpc") throw new Error("E2EE_UNSUPPORTED: x"); return {}; } });
    await api.autoRpc("power.status", {}, 12);
    ok(calls.length === 2 && calls[1][0] === "plain" && calls[1][1] === "/api/daemon/auto", "봉인 구조적 미지원 → 평문 폴백(/api/daemon/auto)"); }
}

// ── 5. 배관 — ui_command 핸들러 · Rust 울타리 · 등록 ───────────────────────────────
{
  const ui = read(path.join(PC, "ui-channel.js"));
  for (const c of ["automations.changed", "dispatch.changed", "power.changed"]) {
    ok(new RegExp(`"${c.replace(".", "\\.")}": async \\(p\\) => \\{[\\s\\S]{0,200}return \\{ ok: true \\};`).test(ui), `ui-channel: ${c} 핸들러가 ok 로 회신`);
  }
  ok(/noteRunnerAwake\(msg\.event\)/.test(ui), "ui-channel: runner_status 의 awake 를 반영(sun 글리프)");
  ok(/api\.onPower\(/.test(ui) && /powerEvent\(kind\)/.test(ui) && /wirePower\(\);/.test(ui), "ui-channel: wirePower — cpt-power → power.event");
  const rs = read(path.join(TAURI, "cptsock.rs"));
  const lib = read(path.join(TAURI, "lib.rs"));
  ok(/pub async fn auto_local\(/.test(rs) && /spawn_blocking\(move \|\| cpt_request_timed\(&cmd, args, true, 35\)\)/.test(rs.slice(rs.indexOf("pub async fn auto_local"))), "cptsock.rs auto_local: async + spawn_blocking, 35초, with_code");
  ok(/m\.starts_with\("auto\."\) \|\| m\.starts_with\("dispatch\."\) \|\| m\.starts_with\("power\."\)\) && m != "power\.event"/.test(rs), "cptsock.rs 울타리: auto./dispatch./power. 만, power.event 제외(봉인 포함)");
  ok(/pub async fn power_local\([\s\S]{0,200}if cmd != "power\.event"/.test(rs), "cptsock.rs power_local: power.event 만");
  ok(/cptsock::auto_local,/.test(lib) && /cptsock::power_local,/.test(lib) && /power::install\(&handle\)/.test(lib) && /mod power;/.test(lib), "lib.rs: 두 커맨드 등록 + power::install");
  const pr = read(path.join(TAURI, "power.rs"));
  ok(/NSWorkspaceWillSleepNotification/.test(pr) && /NSWorkspaceDidWakeNotification/.test(pr) && /emit\("cpt-power"/.test(pr), "power.rs: willSleep/didWake 옵저버 → cpt-power");
  const api = read(path.join(PC, "api.js"));
  ok(/autoLocal: \(cmd, args\) => invoke\("auto_local"/.test(api) && /powerLocal: \(cmd, args\) => invoke\("power_local"/.test(api) && /onPower: \(cb\) => listen\("cpt-power"/.test(api), "api.js: autoLocal · powerLocal · onPower");
  const aa = read(path.join(PC, "automations-api.js"));
  ok(/api\.powerLocal\("power\.event"/.test(aa) && !/autoRpc\("power\.event"/.test(read(path.join(PC, "power-settings.js"))), "power.event 는 powerLocal 로만(릴레이·봉인 금지, §6.4)");
}

// ── 6. 장소 규칙 · 사이드바 · main 배선(소스 계약) ─────────────────────────────────────
{
  const sb = read(path.join(PC, "sidebar.js"));
  const autoRowSrc = sb.slice(sb.indexOf("function autoRow()"), sb.indexOf("function openPcSettings"));
  ok(/tt\("automations"\)/.test(autoRowSrc) && /icons\.repeat/.test(autoRowSrc), "sidebar autoRow(): tt(\"automations\") + repeat 아이콘");
  ok(/state\.view === "automations" \? " active" : ""/.test(autoRowSrc) && /if \(state\.view === "automations"\) return;/.test(autoRowSrc), "자동화 행: 들어가 있을 때만 배경, 토글 아님");
  ok(/hostHasAuto\(S\.activeDeviceId\(\)\) === false[\s\S]{0,120}pcNeedsUpdate/.test(autoRowSrc), "auto.v1 없는 PC: 행은 그리되 누르면 업데이트 안내");
  ok(!/list\.appendChild\(autoRow\(\)\)/.test(sb) && /"automations\.open"/.test(read(path.join(PC, "main.js"))), "`자동화` 행은 사이드바에 없다(2026-10-06 사용자 결정) — 단축키·팔레트로는 열린다");
  ok(/tasksN, autoN,/.test(sb) && /hostAwake\(d\.id\)\]\)/.test(sb), "sbSig 에 autoN·awake");
  ok(/autoNotifTarget\(n\)/.test(sb) && /pcNotifTarget\(n\)/.test(sb), "알림 점프: auto_* → 자동화 장소, pc_* → 진행 현황");
  const main = read(path.join(PC, "main.js"));
  ok(/updateAutomationsView\(\);/.test(main) && /wsViewEl\.hidden = mainPlace/.test(main), "main: 자동화 장소가 메인 영역을 대신 쓴다");
  ok(/\(state\.view === "tasks" \|\| state\.view === "automations"\) && commandById\(id\)\?\.scope !== "global"/.test(main), "main: 자동화 장소에서도 전역 명령만");
  ok(/\.automations-view:not\(\[hidden\]\)/.test(main), "main: 프리뷰 실드 셀렉터에 .automations-view");
  ok(/"automations\.open":/.test(main) && /"dispatch\.open":/.test(main), "main: 명령 2개 등록");
  const html = read(path.resolve("src/index.html"));
  ok(/id="automationsView" class="automations-view" hidden/.test(html), "index.html #automationsView");
  const tv = read(path.join(PC, "tasks-view.js"));
  ok(/hostHasAuto\(host\) === true/.test(tv) && /task\.run\.fix/.test(tv) && /task\.run\.followup\.dismiss/.test(tv), "[고치기][무시] 는 auto.v1 이 있다고 확인된 PC 만(없으면 [PR 열기] 만)");
  ok(/au-chip/.test(tv) && /origin\.kind === "automation"/.test(tv), "작업 카드 `자동` 칩");
}

// ── 7. 알림 딥링크 파서(notifications.js 는 api.js 를 import 해 node 에서 못 연다 → 함수만 오려 실행) ──
{
  const ns = read(path.join(PC, "notifications.js"));
  const cut = (a, b) => ns.slice(ns.indexOf(a), b ? ns.indexOf(b) : undefined);
  const src = cut("export function parseAutoDeeplink").replace(/export function/g, "function");
  const f = new Function(`${src}; return { parseAutoDeeplink, parseTasksHostDeeplink, autoNotifTarget, pcNotifTarget };`)();
  ok(JSON.stringify(f.parseAutoDeeplink("codingpt://auto/a_k3?host=12")) === JSON.stringify({ id: "a_k3", host: 12 })
    && f.parseAutoDeeplink("codingpt://task/t?host=1") === null, "codingpt://auto/<id>?host= 파서");
  ok(JSON.stringify(f.parseTasksHostDeeplink("codingpt://tasks?host=7")) === JSON.stringify({ host: 7 })
    && f.parseTasksHostDeeplink("codingpt://task/t_1") === null, "codingpt://tasks?host= 파서(작업 딥링크와 안 섞인다)");
  ok(JSON.stringify(f.autoNotifTarget({ kind: "auto_failed", hostDeviceId: 3 })) === JSON.stringify({ host: 3 })
    && f.autoNotifTarget({ kind: "task_ready" }) === null, "auto_* 알림(딥링크 없음) → 그 PC 의 자동화 장소");
  ok(JSON.stringify(f.pcNotifTarget({ kind: "pc_disconnected", deeplink: "codingpt://tasks?host=9" })) === JSON.stringify({ host: 9 }), "pc_disconnected → 그 PC 진행 현황");
}

if (skipped.length && STRICT) { fail += skipped.length; console.log(`STRICT: SKIP ${skipped.length}건을 실패로 센다`); }
console.log(`\n${fail === 0 ? "ALL CONFORMANT" : "NOT CONFORMANT"} — pass ${pass} / fail ${fail}${skipped.length ? ` / skip ${skipped.length}` : ""}`);
process.exit(fail === 0 ? 0 : 1);
