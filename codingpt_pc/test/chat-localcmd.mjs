// chat-localcmd.mjs — 로컬 명령 출력(슬래시 결과 · `!` 셸 결과) 표시 규칙.
//
// 배경(2026-08-03 사용자 신고): 채팅에 `<local-command-stdout>Set model to ␛[1mOpus 5 (1M
//  context)␛[22m …</local-command-stdout>` 가 태그·ANSI 까지 원문 그대로 사람 말풍선으로 떴다
//  ("깨지는 느낌"). TUI 는 같은 것을 `⎿ Set model to Opus 5 (1M context) …` 로 그린다.
//  진범은 데몬 정규화(transcript.js — 그쪽 테스트가 정본)였고, **표시 쪽 후속 결함 2건**을 여기서 막는다:
//   ① PC 가 고아 tool_result 라벨을 '도구 결과'로 **하드코딩**해, 데몬이 준 title('명령 결과')을
//      쓰는 앱(chatModel.toolLabel)과 글자가 갈렸다.
//   ② PC 는 도구 출력을 `white-space: pre`(가로 스크롤)로 그려서 산문 한 줄이 잘렸다. TUI 도 앱도
//      감싼다 → 로컬 명령 출력만 감싸는 클래스를 둔다(셸 출력의 열 정렬은 그대로 지킨다).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const M = await import("../src/js/chat-model.js");
const VIEW = readFileSync(path.join(here, "../src/js/chat-view.js"), "utf8");
const CSS = readFileSync(path.join(here, "../src/styles.css"), "utf8");

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 데몬 transcript.normalize 가 실제로 내보내는 모양(그쪽 테스트가 이 값을 고정한다).
const CMD_OUT = {
  seq: 1000, role: "user", kind: "tool_result",
  text: "Set model to Opus 5 (1M context) and saved as your default for new sessions",
  tool: { name: "local-command", title: "명령 결과" },
  result: { toolUseId: null, ok: true, preview: "Set model to Opus 5 (1M context) and saved as your default for new sessions", bytes: 75, lines: 1, truncated: false, images: 0 },
};
const SHELL_OUT = { ...CMD_OUT, tool: { name: "bash", title: "셸 결과" } };

// ── 1. 라벨은 데몬이 준 title (앱과 같은 규칙) ────────────────────────────────
eq("명령 결과 라벨", M.toolLabel(CMD_OUT), "명령 결과");
eq("셸 결과 라벨", M.toolLabel(SHELL_OUT), "셸 결과");
eq("tool 이 없으면 폴백", M.toolLabel({ text: "x" }), "x");
ok("★ 고아 tool_result 라벨을 하드코딩하지 않는다(앱과 갈라지는 자리)",
  !/chat-tool-label">도구 결과</.test(VIEW) && /chat-tool-label">\$\{escapeHtml\(m\.tool \? toolLabel\(m\)/.test(VIEW));

// ── 2. 산문 출력만 감싼다 ────────────────────────────────────────────────────
ok("로컬 명령 출력에 wrap 을 건다", /wrap: !!\(m\.tool && m\.tool\.name === "local-command"\)/.test(VIEW));
ok(".chat-out.wrap 이 pre-wrap 이다", /\.chat-out\.wrap\s*\{[^}]*pre-wrap/.test(CSS));
ok("기본 .chat-out 은 여전히 pre(셸 출력 열 정렬 보존)",
  /\.chat-out\s*\{[^}]*white-space:\s*pre;/.test(CSS));

// ── 3. 빈 출력은 그리지 않는다 ────────────────────────────────────────────────
// 데몬이 hidden 으로 보내고(취소한 /model), 표시 판정도 독립적으로 같은 답을 내야 한다.
ok("빈 tool_result 는 표시 대상이 아니다",
  !M.isVisible({ ...CMD_OUT, text: "", hidden: true, result: { ...CMD_OUT.result, preview: "", bytes: 0, lines: 0 } }));

console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
process.exit(fail ? 1 : 0);
