// chat-status.mjs — 에이전트 상태 표시 규칙(PC ↔ 앱 실행 대조).
//
// 배경(2026-08-03 재설계): 상태 원천이 **화면 스크랩 → 공식 채널**로 바뀌었다
//  (데몬 agent-status.js — claude statusLine 훅 / codex rollout). 사용자 확정 = "채팅 UI답게 새로 그리기".
//  그래서 문구·순서·포맷을 우리가 직접 만든다 → 두 플랫폼이 갈라지면 같은 세션이 폰과 PC에서
//  다르게 보인다. 여기서 **두 구현을 실제로 실행해** 같은 입력에 같은 출력을 내는지 대조한다.
//
// 고정하는 계약:
//  · 칩 순서 = 모델 → 컨텍스트 → 한도들(왼쪽이 더 중요, 좁으면 뒤부터 버린다).
//  · 값이 없는 항목은 **아예 만들지 않는다**(모름 ≠ 0 — "컨텍스트 0%"로 단정 금지).
//  · 리셋까지 남은 시간은 **그리는 시점**에 계산한다(데몬이 문자열을 만들면 화면에 굳는다).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import url from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PC = await import("../src/js/chat-model.js");

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 데몬 agent-status.js 가 실제로 내는 모양(그쪽 테스트가 이 값을 실캡처로 고정한다).
const CLAUDE = {
  agent: "claude", model: "Opus 5 (1M context)", effort: "high", thinking: true,
  contextPct: 31, contextUsed: 310000, contextMax: 1000000,
  limits: [
    { id: "five_hour", label: "5시간", pct: 2, resetsAt: 1785762600 },
    { id: "seven_day", label: "7일", pct: 12, resetsAt: 1786302000 },
  ],
  costUsd: 0.1375, linesAdded: 820, linesRemoved: 190, source: "hook",
};
const CODEX = {
  agent: "codex", model: "gpt-5.6-sol", effort: "low", planMode: true, approvalPolicy: "on-request",
  contextPct: 3, contextUsed: 8780, contextMax: 258400,
  limits: [{ id: "primary", label: "7일", pct: 12, resetsAt: 1786357362 }], source: "file",
};
// 세션 시작 직후 실측 — 값이 거의 없다. "0%" 로 단정하면 안 되는 그 상태.
const EARLY = { agent: "claude", model: "Opus 5 (1M context)", contextMax: 1000000, source: "hook" };
const NOW = 1785750000000;   // 고정 기준 시각(두 구현이 같은 값을 내야 한다)

// ── PC 단독 계약 ────────────────────────────────────────────────────────────────
eq("칩 순서 = 모델 → 컨텍스트 → 한도들", PC.statusChips(CLAUDE).map((c) => c.text),
  ["Opus 5 (1M context)", "컨텍스트 31%", "5시간 2%", "7일 12%"]);
eq("★ 값이 없으면 칩을 만들지 않는다(컨텍스트 0% 로 단정 금지)",
  PC.statusChips(EARLY).map((c) => c.key), ["model"]);
eq("상태가 없으면 빈 목록", PC.statusChips(null), []);
ok("hasStatus 는 그릴 게 있을 때만 참", PC.hasStatus(CLAUDE) && PC.hasStatus(EARLY) && !PC.hasStatus(null) && !PC.hasStatus({}));

eq("토큰 포맷", [PC.fmtTokens(820), PC.fmtTokens(310000), PC.fmtTokens(1000000), PC.fmtTokens(258400)],
  ["820", "310k", "1M", "258k"]);
eq("리셋까지 남은 시간", [
  PC.fmtReset(NOW / 1000 + 60 * 30, NOW),
  PC.fmtReset(NOW / 1000 + 3600 * 3 + 60 * 21, NOW),
  PC.fmtReset(NOW / 1000 + 3600 * 24 * 4, NOW),
  PC.fmtReset(NOW / 1000 - 10, NOW),
  PC.fmtReset(null, NOW),
], ["30분 후 리셋", "3시간 21분 후 리셋", "4일 후 리셋", "", ""]);

eq("상세 행(컨텍스트 → 한도 → 비용 → 설정)", PC.statusDetail(CLAUDE, NOW).map((r) => [r.label, r.value, r.sub]), [
  ["컨텍스트", "310k / 1M (31%)", ""],
  ["5시간 한도", "2%", "3시간 30분 후 리셋"],
  ["7일 한도", "12%", "6일 후 리셋"],
  ["이번 세션", "$0.14 · +820 / -190 줄", ""],
  ["설정", "추론 high", ""],
]);
eq("codex 는 승인 정책도 설정 행에 실린다",
  PC.statusDetail(CODEX, NOW).find((r) => r.label === "설정").value, "추론 low · 승인 on-request");
eq("★ 시간은 그리는 시점 기준이다(같은 상태라도 나중에 부르면 줄어든다)",
  PC.statusDetail(CLAUDE, NOW + 3600 * 1000).find((r) => r.label === "5시간 한도").sub, "2시간 30분 후 리셋");

// ── 앱 실행 대조(앱 TS 를 strip-types 로 진짜 실행) ─────────────────────────────
{
  const tsPath = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath).href)}).then((m) => {
       const CLAUDE = ${JSON.stringify(CLAUDE)}, CODEX = ${JSON.stringify(CODEX)}, EARLY = ${JSON.stringify(EARLY)};
       const NOW = ${NOW};
       console.log(JSON.stringify({
         chips: m.statusChips(CLAUDE).map((c) => [c.key, c.text]),
         chipsEarly: m.statusChips(EARLY).map((c) => c.key),
         detail: m.statusDetail(CLAUDE, NOW).map((x) => [x.key, x.label, x.value, x.sub]),
         detailCodex: m.statusDetail(CODEX, NOW).map((x) => [x.key, x.label, x.value, x.sub]),
         tokens: [m.fmtTokens(820), m.fmtTokens(310000), m.fmtTokens(1000000), m.fmtTokens(258400)],
         resets: [m.fmtReset(NOW/1000+1800, NOW), m.fmtReset(NOW/1000+3600*3+1260, NOW),
                  m.fmtReset(NOW/1000+86400*4, NOW), m.fmtReset(NOW/1000-10, NOW), m.fmtReset(null, NOW)],
         has: [m.hasStatus(CLAUDE), m.hasStatus(EARLY), m.hasStatus(null)],
       }));
     });`], { encoding: "utf8" });
  ok("앱 chatModel.ts 를 strip-types 로 실행할 수 있다", r.status === 0, (r.stderr || "").split("\n").slice(0, 3).join("\n"));
  let app = null;
  try { app = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch (_) { app = null; }

  eq("앱 칩 = PC 칩(키·문구까지)", app && app.chips, PC.statusChips(CLAUDE).map((c) => [c.key, c.text]));
  eq("앱도 값 없는 칩을 만들지 않는다", app && app.chipsEarly, PC.statusChips(EARLY).map((c) => c.key));
  eq("앱 상세 = PC 상세", app && app.detail,
    PC.statusDetail(CLAUDE, NOW).map((x) => [x.key, x.label, x.value, x.sub]));
  eq("앱 상세(codex) = PC 상세(codex)", app && app.detailCodex,
    PC.statusDetail(CODEX, NOW).map((x) => [x.key, x.label, x.value, x.sub]));
  eq("앱 토큰 포맷 동일", app && app.tokens,
    [PC.fmtTokens(820), PC.fmtTokens(310000), PC.fmtTokens(1000000), PC.fmtTokens(258400)]);
  eq("앱 리셋 문구 동일", app && app.resets, [
    PC.fmtReset(NOW / 1000 + 1800, NOW), PC.fmtReset(NOW / 1000 + 3600 * 3 + 1260, NOW),
    PC.fmtReset(NOW / 1000 + 86400 * 4, NOW), PC.fmtReset(NOW / 1000 - 10, NOW), PC.fmtReset(null, NOW),
  ]);
  eq("앱 hasStatus 동일", app && app.has, [PC.hasStatus(CLAUDE), PC.hasStatus(EARLY), PC.hasStatus(null)]);
}

console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
process.exit(fail ? 1 : 0);
