// 자동 업데이트 스케줄러 — 조용한 순간 판정의 실행 검증 + 배선 핀.
//
// 지키는 불변식(2026-08-01 사용자 지적에서 도출):
//  이 제품은 원격 접속을 위해 PC 를 며칠씩 켜 둔다. 부팅 때만 확인하면 사실상 영원히 업데이트를
//  못 하고, 그렇다고 아무 때나 재시작하면 원격에서 일하던 사람을 끊는다. 그래서 판정 규칙 자체가
//  기능이다 — 여기서 못 박는다.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { judgeQuiet, remoteViewers, anyAgentWorking, AGENT_FRESH_MS } from "../src/js/update-policy.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
let fails = 0;
function ok(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + " " + name);
  if (!cond) fails++;
}
function eq(name, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log((pass ? "PASS" : "FAIL") + " " + name + (pass ? "" : `\n  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  if (!pass) fails++;
}

const QUIET = { agentWorking: false, approvals: 0, viewers: 0, focused: false };

// ── 판정 규칙 ──
eq("아무도 안 보고 아무것도 안 돌면 조용함(= 묻지 않고 적용)", judgeQuiet(QUIET), { quiet: true, reason: "idle" });
eq("에이전트가 작업 중이면 안 끊는다", judgeQuiet({ ...QUIET, agentWorking: true }), { quiet: false, reason: "agent" });
eq("승인 대기가 있으면 안 끊는다", judgeQuiet({ ...QUIET, approvals: 2 }), { quiet: false, reason: "approval" });
eq("원격에서 보고 있으면 안 끊는다", judgeQuiet({ ...QUIET, viewers: 1 }), { quiet: false, reason: "remote" });
eq("PC 앞에서 보고 있으면 안 끊는다(놀라게 하지 않는다)", judgeQuiet({ ...QUIET, focused: true }), { quiet: false, reason: "focus" });
eq("화면 목록을 모르면(조회 실패) 끊지 않는다 — 모름은 '없음'이 아니다",
  judgeQuiet({ ...QUIET, viewers: null }), { quiet: false, reason: "unknown" });
eq("여러 이유가 겹치면 가장 강한 것(작업 중)을 알린다",
  judgeQuiet({ agentWorking: true, approvals: 3, viewers: 2, focused: true }), { quiet: false, reason: "agent" });

// ── 원격 시청자 계산: 이 PC 자신은 시청자가 아니다 ──
eq("자기 자신(pc)만 붙어 있으면 원격 시청자 0", remoteViewers([{ kind: "pc" }]), 0);
eq("폰이 붙어 있으면 원격 시청자로 센다", remoteViewers([{ kind: "pc" }, { kind: "mobile" }]), 1);
eq("조회 실패(null)는 0 이 아니라 null 로 전파된다", remoteViewers(null), null);

// ── 에이전트 작업중 판정 ──
{
  const now = 1_700_000_000_000;
  const m = (rows) => new Map(rows.map((r, i) => [String(i), r]));
  ok("working 이 하나라도 있으면 작업 중",
    anyAgentWorking(m([{ state: "idle", recvAt: now }, { state: "working", recvAt: now }]), now) === true);
  ok("needsInput 은 작업 중이 아니다(사람이 자리를 비웠을 수 있다 — 승인은 따로 판정)",
    anyAgentWorking(m([{ state: "needsInput", recvAt: now }]), now) === false);
  ok("stale 한 working 은 근거로 쓰지 않는다(끊기지 못하고 영원히 막히는 것 방지)",
    anyAgentWorking(m([{ state: "working", recvAt: now - AGENT_FRESH_MS - 1 }]), now) === false);
  ok("상태가 아예 없으면 작업 중 아님", anyAgentWorking(m([]), now) === false && anyAgentWorking(null, now) === false);
}

// ── 배선 핀 ──
const read = (p) => fs.readFileSync(path.resolve(here, p), "utf8");
{
  const sch = read("../src/js/update-scheduler.js");
  ok("주기 확인은 24시간, 실패는 백오프", /CHECK_MS = 24 \* 60 \* 60 \* 1000/.test(sch) && /MAX_RETRY_MS/.test(sch));
  ok("다운로드와 설치가 분리돼 있다(사전 다운로드)", /api\.updateDownload\(\)/.test(sch) && /api\.updateInstall\(\)/.test(sch));
  ok("'나중에' 는 영구 무시가 아니라 유예다", /DEFER_MS/.test(sch) && /deferUntil/.test(sch));
  ok("판정은 순수 모듈(update-policy)에 위임한다", /from "\.\/update-policy\.js"/.test(sch));

  const api = read("../src/js/api.js");
  ok("Rust 커맨드 3종(check/download/install)+staged 노출", /update_download/.test(api) && /update_staged/.test(api) && /update_install/.test(api));
  ok("원격 시청자 판정용 화면 목록 조회 노출", /fetch_ui_clients/.test(api));

  const rs = read("../src-tauri/src/lib.rs");
  ok("Rust: 다운로드만 하고 설치는 안 하는 경로", /fn update_download/.test(rs) && /update\s*\n?\s*\.download\(/.test(rs));
  ok("Rust: 준비된 바이트가 있으면 재다운로드 없이 설치", /let staged = app[\s\S]{0,200}PendingUpdate/.test(rs) && /update\.install\(bytes\)/.test(rs));
  ok("Rust: 재시작 전 데몬 자식 정리(고아 방지)", /should_run\.lock\(\)\.unwrap\(\) = false/.test(rs));

  const main = read("../src/js/main.js");
  ok("main 이 스케줄러를 기동한다", /startUpdateScheduler\(renderUpdateBanner\)/.test(main));
  ok("배너 문구가 '작업 유지' 를 명시한다 — 없으면 사용자는 영원히 미룬다",
    /하던 터미널 작업은 그대로 유지/.test(main));
  ok("배너에 [나중에]/[지금 적용] 둘 다 있다(강제 아님)", /ubLater/.test(main) && /ubNow/.test(main));

  const html = read("../src/index.html");
  ok("배너 마운트 지점이 있다", /id="updateBanner"/.test(html));
  const css = read("../src/styles.css");
  ok("배너 CSS(하단 우측 고정)", /\.update-banner\s*\{/.test(css));
}

if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log("\nALL PASS");
