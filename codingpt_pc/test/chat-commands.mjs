// 슬래시 명령 팔레트 — 3구현(데몬 카탈로그 · PC · 앱) 패리티 + 배관 핀.
//
// 사용자 요청(2026-08-02): "TUI 에서 `/` 를 치면 나오는 그 목록을 채팅에서도 보이고 고르기 쉽게".
// 확정 사항: 목록은 **전부 + 검색**, 고르면 **컴포저에 채워넣기**, 빌트인은 **실측 표**를 우리가 갱신.
//
// 왜 실행 대조인가: 여는 조건(slashQuery)과 정렬(filterCommands)이 폰/PC 로 갈리면 같은 글자를 쳤는데
//  다른 목록이 뜬다. 정규식으로 소스 모양만 확인하는 공허한 검증 대신 **양쪽 함수를 실행해** 맞춘다.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let fails = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS" : "FAIL") + " " + name + (cond || !detail ? "" : "\n  " + detail));
  if (!cond) fails++;
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)}\n  want=${JSON.stringify(want)}`);

const PC = await import("../src/js/chat-model.js");

// ── 여는 조건 ──────────────────────────────────────────────────────────────────
const QCASES = [
  ["/", ""],            // 막 `/` 를 친 순간 = 전체 목록
  ["/dep", "dep"],
  ["  /dep", "dep"],   // 앞 공백은 무시
  ["/dep ", null],     // 뒤 공백 = 인자 모드 → 닫는다(★ trim 으로 뭉개면 안 된다)
  ["/dep arg", null],
  ["hi /dep", null],    // 문장 중간의 슬래시는 명령이 아니다
  ["", null],
];
for (const [text, want] of QCASES) eq(`PC 여는 조건: ${JSON.stringify(text)}`, PC.slashQuery(text), want);

// ── 정렬(접두사 먼저) ──────────────────────────────────────────────────────────
const ITEMS = [
  { name: "/deploy", desc: "배포", chat: "ok", source: "project" },
  { name: "/model", desc: "모델", chat: "dialog", source: "builtin" },
  { name: "/compact", desc: "압축", chat: "ok", source: "builtin" },
  { name: "/exit", desc: "종료", chat: "tui", source: "builtin" },
];
eq("PC 정렬: 접두사 일치가 부분 일치보다 앞", PC.filterCommands(ITEMS, "de").map((c) => c.name), ["/deploy", "/model"]);
eq("PC 정렬: 빈 질의는 목록 순서 그대로", PC.filterCommands(ITEMS, "").map((c) => c.name), ITEMS.map((c) => c.name));
eq("PC 배지: 출처 + 제약", [
  PC.commandBadges(ITEMS[0]), PC.commandBadges(ITEMS[1]), PC.commandBadges(ITEMS[3]),
], [["프로젝트"], ["선택 화면"], ["터미널에서"]]);

// ── 앱 패리티(앱 TS 를 strip-types 로 실제 실행) ───────────────────────────────
{
  const tsPath = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath).href)}).then((m) => {
       const items = ${JSON.stringify(ITEMS)};
       console.log(JSON.stringify({
         q: ${JSON.stringify(QCASES.map(([t]) => t))}.map((t) => m.slashQuery(t)),
         de: m.filterCommands(items, 'de').map((c) => c.name),
         all: m.filterCommands(items, '').map((c) => c.name),
         badges: [m.commandBadges(items[0]), m.commandBadges(items[1]), m.commandBadges(items[3])],
       }));
     });`], { encoding: "utf8" });
  ok("앱 chatModel.ts 를 strip-types 로 실행할 수 있다", r.status === 0, (r.stderr || "").split("\n").slice(0, 3).join("\n"));
  let app = null;
  try { app = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch (_) { app = null; }
  eq("앱 여는 조건 = PC 와 동일", app && app.q, QCASES.map(([, w]) => w));
  eq("앱 정렬 = PC 와 동일", app && [app.de, app.all], [["/deploy", "/model"], ITEMS.map((c) => c.name)]);
  eq("앱 배지 = PC 와 동일", app && app.badges, [["프로젝트"], ["선택 화면"], ["터미널에서"]]);
}

// ── 데몬 카탈로그(실행) — 클라가 그릴 값이 실제로 온다 ────────────────────────
{
  const runtime = require("../../codingpt_daemon/packages/runner-core/runtime");
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cpt-cmd-"));
  runtime.init({ root: tmp, stateDir: path.join(tmp, ".codingpt") });
  const cat = require("../../codingpt_daemon/packages/runner-core/commands");
  const cl = cat.listCommands({ agent: "claude" }).items;
  ok("데몬 claude 표 = 실측 규모(60개 이상)", cl.length > 60, `len=${cl.length}`);
  ok("데몬 codex 표 = 실측 규모(30개 이상)", cat.listCommands({ agent: "codex" }).items.length > 30);
  ok("모든 항목이 팔레트가 기대하는 모양이다(name/desc/chat/source)",
    cl.every((c) => /^\/[A-Za-z0-9:_-]+$/.test(c.name) && typeof c.desc === "string"
      && ["ok", "dialog", "tui"].includes(c.chat) && ["builtin", "user", "project"].includes(c.source)));
  // 팔레트 정렬 함수에 데몬 실제 목록을 태워도 깨지지 않는다(빈 질의 = 목록 순서 유지).
  eq("데몬 목록 + PC 정렬 = 앞부분 보존", PC.filterCommands(cl, "").slice(0, 3).map((c) => c.name), cl.slice(0, 3).map((c) => c.name));
}

// ── 배관 핀 ────────────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(path.resolve(here, p), "utf8");
{
  const cs = read("../../codingpt_daemon/packages/runner-core/cpt-server.js");
  ok("데몬: chat.commands 디스패치(앱 내부용 — 컨텍스트 게이트 앞)", /cmd === 'chat\.commands'/.test(cs) && /async function chatCommands/.test(cs));
  const ctl = read("../../codingpt_daemon/packages/runner-core/control.js");
  ok("데몬: chat.commands 를 cpt-server 로 라우팅", /method === 'chat\.commands'/.test(ctl) && /cptServer\.chatCommands/.test(ctl));
  const cmdsSrc = read("../../codingpt_daemon/packages/runner-core/commands.js");
  ok("데몬: 빌트인 표 + 디스크 발견의 합성(디스크가 이긴다)", /CLAUDE_BUILTIN/.test(cmdsSrc) && /discoverClaude/.test(cmdsSrc));
  ok("데몬: 프론트매터 블록 스칼라(`>-`)를 이어 붙인다", /블록 스칼라/.test(cmdsSrc));

  const back = read("../../codingpt_back/routes/daemonRoutes.js");
  ok("back: POST /chat/commands 라우트", /\/chat\/commands/.test(back));
  const bc = read("../../codingpt_back/controllers/daemonController.js");
  ok("back: chat.commands rpc 프록시(얇은 래퍼)", /chatRpc\('chat\.commands'/.test(bc));

  const cv = read("../src/js/chat-view.js");
  ok("PC: `/` 를 치면 팔레트가 열린다(입력 이벤트에서 판정)", /_syncSlash\(\)/.test(cv) && /chat-cmds/.test(cv));
  ok("PC: ↑↓/Enter/Tab 은 목록 조작(Enter 는 전송이 아니라 채워넣기)", /_moveCmd\(/.test(cv) && /_pickCmd\(row\.name\)/.test(cv));
  ok("PC: 고르면 컴포저에 `/이름 ` 으로 채운다", /this\.inputEl\.textContent = n \+ " "/.test(cv));
  ok("PC: tui 분류는 고를 수 없다", /row\.classList\.contains\("off"\)/.test(cv) && /rows\[i\]\.chat !== "tui"/.test(cv));
  ok("PC: 로컬 터미널이면 사이드카 직결", /chatLocal\("chat\.commands"/.test(cv));
  const api = read("../src/js/api.js");
  ok("PC: api.chatCommands → /api/daemon/chat/commands", /chat\/commands/.test(api));
  const rs = read("../src-tauri/src/cptsock.rs");
  ok("PC: Rust 로컬 허용 목록에 chat.commands", /"chat\.commands"/.test(rs));
  const css = read("../src/styles.css");
  ok("PC: 팔레트 CSS", /\.chat-cmds\b/.test(css) && /\.chat-cmds-row\.off/.test(css));

  const app = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱: 팔레트 컴포넌트 + 컴포저 연결", /SlashPalette/.test(app("src/workspace/chat/ChatComposer.tsx")) && /slashQuery\(draft\)/.test(app("src/workspace/chat/ChatComposer.tsx")));
  ok("앱: 고르면 컴포저에 채워넣는다(즉시 실행 금지)", /onDraftChange\(`\$\{name\} `\)/.test(app("src/workspace/chat/ChatComposer.tsx")));
  ok("앱: tui 분류는 눌리지 않는다", /disabled=\{off\}/.test(app("src/workspace/chat/SlashPalette.tsx")));
  ok("앱: 목록은 `/` 를 칠 때 한 번만 요청", /onNeedCommands/.test(app("src/workspace/chat/ChatComposer.tsx")) && /cmdsOnceRef/.test(app("src/workspace/chat/ChatBody.tsx")));
  ok("앱: 서비스가 /chat/commands 를 친다", /chat\/commands/.test(app("src/services/chatService.ts")));
}

if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log("\nALL PASS");
