// ws-offline.test.mjs — 워크스페이스 목록 "오프라인" 판정: 느림≠끊김(2026-11-26 실사고) + state.js 배선 계약.
import fs from "node:fs";
import path from "node:path";

const PC = path.resolve("src/js");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
const M = await import(path.join(PC, "ws-offline.js"));

let d = M.staleDecision({ wasOnline: true, misses: 1 });
ok(!d.showOffline && d.retryMs === M.WS_GRACE_RETRY_MS, "온라인 중 1회 지연 → 오프라인 아님, 곧 재확인");
d = M.staleDecision({ wasOnline: true, misses: M.WS_STALE_GRACE });
ok(d.showOffline && d.retryMs === M.WS_OFFLINE_RETRY_MS, "연속 실패가 유예를 넘으면 오프라인 + 빠른 재확인");
d = M.staleDecision({ wasOnline: false, misses: 1 });
ok(d.showOffline, "부팅 직후(온라인 확인 전) 캐시는 바로 보여준다");
ok(M.WS_OFFLINE_RETRY_MS < 60000, "오프라인 재확인은 60초 주기보다 빠르다");

const src = fs.readFileSync(path.join(PC, "state.js"), "utf8");
ok(/import \{ staleDecision, WS_OFFLINE_RETRY_MS \} from "\.\/ws-offline\.js"/.test(src), "state.js 가 판정 모듈을 쓴다");
ok(/if \(!d\.showOffline\) return;/.test(src), "유예 중엔 목록/표시를 바꾸지 않는다");
ok(/_wsMisses = 0;\s*\n\s*_wsEverOnline = true;/.test(src), "정상 응답이면 실패 카운트 리셋");
ok(/scheduleWsRetry\(WS_OFFLINE_RETRY_MS\); \/\/ 캐시도 없는 실패/.test(src), "캐시 없는 실패도 빠른 재확인");
const rs = fs.readFileSync(path.resolve("src-tauri/src/bridge.rs"), "utf8");
ok(/api\/daemon\/workspaces[\s\S]{0,300}from_secs\(15\)/.test(rs), "Rust 목록 조회 타임아웃 15초");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
