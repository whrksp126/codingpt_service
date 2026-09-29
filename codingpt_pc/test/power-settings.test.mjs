// power-settings.test.mjs — PC 깨어 있기 카드(automation-design §6.6) 상태 줄 판정 + 설정 흐름 소스 계약.
import fs from "node:fs";
import path from "node:path";

const PC = path.resolve("src/js");
let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (e ? "  " + e : "")); } };
const M = await import(path.join(PC, "automations-model.js"));
const keys = (st) => M.powerStatusKeys(st).map((l) => l.key || l.code);

ok(JSON.stringify(keys({ active: false })) === '["asleepAllowed"]', "유휴 → 지금: 잠자기 허용");
ok(JSON.stringify(M.powerStatusKeys({ active: true, reasons: ["task:t_1", "task:t_2", "automation:a_1"] })[0].vars) === '{"n":2}', "활성 → 작업 수는 task: 사유만 센다");
ok(M.powerStatusKeys({ active: true, reasons: ["automation:a_1"] })[0].vars.n === 1, "작업 없이 자동화만 활성이면 사유 수");
ok(keys({ active: true, lidClosed: true, lidBlocked: "battery" }).includes("onBattery"), "배터리 → 덮개 닫힘 유지 꺼짐 안내");
ok(keys({ setup: "pending" }).includes("setupPending"), "설정 중 → 암호 창 확인 안내");
ok(keys({ lidClosed: true, lidBlocked: "sudo" }).includes("POWER_SUDO_MISSING"), "sudo 규칙 사라짐 → 에러 줄");
ok(keys({ setup: "failed", setupError: { code: "POWER_SETUP_CANCELLED" } }).includes("POWER_SETUP_CANCELLED"), "설정 취소 → 사유 코드");
ok(!keys({ lidClosed: false, lidBlocked: "battery" }).includes("onBattery"), "덮개 닫힘을 안 켰으면 배터리 안내 없음");

const TX = await import(path.join(PC, "text/tasks.js"));
for (const c of ["POWER_SUDO_MISSING", "POWER_SETUP_CANCELLED", "POWER_SETUP_FAILED", "POWER_NO_GUI", "POWER_UNSUPPORTED"]) {
  ok(TX.AUTO_ERROR_KEY[c] && TX.errText(c) !== TX.TASKS_TEXT.ko.errGeneric, `${c} → 전용 문구`);
}

const src = fs.readFileSync(path.join(PC, "power-settings.js"), "utf8");
ok(/remote && !remove && !window\.confirm\(at\("setupRemoteHint"\)\)/.test(src), "원격 PC 설정은 '그 PC 화면에 창이 뜬다' 확인을 먼저(§6.2 5)");
ok(/if \(tg\.checked && !done\) \{ tg\.checked = false; void setup\(\{ then: \(\) => set\(\{ lidClosed: true \}\) \}\)/.test(src), "미설정에서 덮개 토글 → 설정 흐름 먼저, 끝나면 켠다");
ok(/autoRpc\("power\.setup", remove \? \{ remove: true \} : \{\}, h\)/.test(src) && /SETUP_DEADLINE_MS = 185000/.test(src), "power.setup → status.setup 폴링(데몬 180초 + 여유)");
ok(/POLL_MS = 30000/.test(src) && /export function onPowerChanged/.test(src), "30초 폴링 + power.changed 즉시 갱신");
ok(/at\("powerCaveat"\)/.test(src) && /at\("powerUnsupported"\)/.test(src) && /tt\("pcNeedsUpdate"\)/.test(src), "주의 문구·미지원·업데이트 필요 분기");
ok(!/password|암호를 입력/.test(src.replace(/\/\/.*$/gm, "")), "암호를 다루는 코드가 없다(macOS 창에 사용자가 직접)");
const st = fs.readFileSync(path.join(PC, "settings.js"), "utf8");
ok(/renderPowerCard\(ph, state\.daemon\?\.deviceId \?\? null, \{ remote: false \}\)/.test(st) && /IS_WINDOWS \? "" : `[\s\S]{0,80}keepAwake/.test(st), "설정 > 시스템: 이 PC 카드(비 Windows)");
const sb = fs.readFileSync(path.join(PC, "sidebar.js"), "utf8");
ok(/addEventListener\("contextmenu"[\s\S]{0,200}pcSettings/.test(sb), "PC 행 우클릭 메뉴 `PC 설정`");
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
