// 에이전트 권한 모드(TUI shift+tab) 채팅 조작 — 카탈로그 3구현 패리티 + 배관 핀.
//
// 왜 이 파일이 필요한가
//  · 같은 "모드"가 데몬(파싱/드라이브) · PC(알약/목록) · 앱(알약/바텀시트) 세 곳에 있다. 한쪽만
//    고치면 폰과 PC 가 다른 라벨을 보이거나(사용자 혼란), 데몬이 모르는 id 를 클라가 보내 실패한다.
//  · 그래서 카탈로그를 **실행해서** 대조한다(정규식으로 소스 모양만 보는 공허한 검증 금지).
//  · 라벨은 TUI 원문 그대로여야 한다(사용자 확정 2026-08-01) — 번역이 섞이면 화면과 단어가 갈린다.
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

// ── PC 카탈로그(실행) ──
const PC = await import("../src/js/chat-model.js");
const pcCat = PC.AGENT_MODES.map((m) => ({ id: m.id, symbol: m.symbol, label: m.label, desc: m.desc, hidden: !!m.hidden }));
eq("PC 카탈로그 = 실측 5모드(순서 = TUI 순환 순서)", pcCat.map((m) => m.id),
  ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
eq("PC 라벨 = TUI 원문(번역 금지)", pcCat.map((m) => m.label),
  ["manual mode on", "accept edits on", "plan mode on", "auto mode on", "bypassing permissions"]);
eq("PC: bypass 는 지금 그 모드일 때만 목록에 낀다", [
  PC.agentModeChoices("auto").map((m) => m.id),
  PC.agentModeChoices("bypassPermissions").map((m) => m.id),
], [
  ["default", "acceptEdits", "plan", "auto"],
  ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
]);
eq("PC: 데몬이 준 label/symbol 이 카탈로그보다 우선(신 모드도 그대로 표시)",
  PC.agentModeView({ id: "auto", label: "auto mode on!", symbol: "»" }),
  { id: "auto", symbol: "»", label: "auto mode on!", desc: "안전한 작업은 자동 진행" });
eq("PC: 모르는 모드/빈 값 → null(알약 숨김)", [PC.agentModeView(null), PC.agentModeView({ id: "" })], [null, null]);

// ── 앱 카탈로그 패리티(앱 TS 소스를 strip-types 로 실제 실행) ──
{
  const tsPath = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath).href)}).then((m) => {
       console.log(JSON.stringify({
         cat: m.AGENT_MODES.map((x) => ({ id: x.id, symbol: x.symbol, label: x.label, desc: x.desc, hidden: !!x.hidden })),
         choices: m.agentModeChoices("auto").map((x) => x.id),
         view: m.agentModeView({ id: "plan" }),
       }));
     });`], { encoding: "utf8" });
  ok("앱 chatModel.ts 를 strip-types 로 실행할 수 있다", r.status === 0, (r.stderr || "").split("\n").slice(0, 3).join("\n"));
  let app = null;
  try { app = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch (_) { app = null; }
  eq("앱 카탈로그 = PC 카탈로그(라벨·설명·숨김까지 동일)", app && app.cat, pcCat);
  eq("앱 선택지 규칙도 동일", app && app.choices, ["default", "acceptEdits", "plan", "auto"]);
  eq("앱 표시값 규칙 동일", app && app.view, PC.agentModeView({ id: "plan" }));
}

// ── 데몬 파싱/조작(실행) — 클라 카탈로그 id 가 전부 데몬에서 유효해야 한다 ──
{
  const runtime = require("../../codingpt_daemon/packages/runner-core/runtime");
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cpt-cm-"));
  runtime.init({ root: tmp, stateDir: path.join(tmp, ".codingpt") });
  const sl = require("../../codingpt_daemon/packages/runner-core/status-line");
  eq("데몬이 아는 모드 id = 클라 카탈로그 id", sl.MODE_IDS.slice().sort(), pcCat.map((m) => m.id).sort());
  // 실캡처 푸터(40·48·60컬럼, 2026-08-01) → id 판별
  const CASES = [
    ["  -- INSERT --  ⏸ manual mode on · ← for agents", "default"],
    ["  -- INSERT ⏵⏵ accept edits on   · ← f…", "acceptEdits"],
    ["  -- INSERT ⏸ plan mode on           ·", "plan"],
    ["  -- INSERT ⏵⏵ auto mode on          ·", "auto"],
  ];
  for (const [line, id] of CASES) eq(`데몬 파싱: ${id}`, sl.parseMode(line).id, id);
  ok("데몬 파싱: 라벨이 없으면 null(추측 금지)", sl.parseMode("  ? for shortcuts") === null);
  // 라벨/심볼도 클라 카탈로그와 같은 문자열이어야 한다(데몬 값이 우선 표시되므로).
  for (const m of pcCat) {
    if (m.id === "bypassPermissions") continue; // 실캡처 없음(플래그 세션 전용) — 문자열만 아래에서 비교
    const parsed = sl.parseMode(`⏵⏵ ${m.label} (shift+tab to cycle)`);
    eq(`데몬 라벨/심볼 = 클라 카탈로그(${m.id})`, parsed && { label: parsed.label, symbol: parsed.symbol },
      { label: m.label, symbol: m.symbol });
  }
}

// ── 배관 핀(있어야 할 자리에 있는가) ──
const read = (p) => fs.readFileSync(path.resolve(here, p), "utf8");
{
  const sl = read("../../codingpt_daemon/packages/runner-core/status-line.js");
  ok("데몬: 감싸진 푸터 꼬리(--)를 미러하지 않는다(첫 표식부터 끝까지 = 푸터)", /JUNK_RE/.test(sl) && /footer != null\) continue/.test(sl));
  const cs = read("../../codingpt_daemon/packages/runner-core/cpt-server.js");
  ok("데몬: 모드 드라이브 = BTab 반복 + 화면 재확인", /driveMode/.test(cs) && /BTab/.test(cs));
  ok("데몬: 다이얼로그가 떠 있으면 조작 거부(MODE_BLOCKED)", /MODE_BLOCKED/.test(cs));
  ok("데몬: 도달 못 하면 실패(조용한 성공 금지)", /MODE_UNREACHABLE/.test(cs));
  const ctl = read("../../codingpt_daemon/packages/runner-core/control.js");
  ok("데몬: chat.mode 를 cpt-server 로 라우팅(transcript 는 읽기 전용)", /method === 'chat\.mode'/.test(ctl) && /cptServer\.chatMode/.test(ctl));
  const ts = read("../../codingpt_daemon/packages/runner-core/transcript.js");
  ok("데몬: chat.open 응답 + status_line push 에 모드 동봉", /statusMode/.test(ts) && /kind: 'status_line', lines, \.\.\.\(mode/.test(ts));

  const back = read("../../codingpt_back/routes/daemonRoutes.js");
  ok("back: POST /chat/mode 라우트", /\/chat\/mode/.test(back) && /chatMode/.test(back));
  const bc = read("../../codingpt_back/controllers/daemonController.js");
  ok("back: chat.mode rpc 프록시(얇은 래퍼)", /chatRpc\('chat\.mode'/.test(bc));

  const cv = read("../src/js/chat-view.js");
  ok("PC: 컴포저 컨트롤 행에 모드 알약", /chat-mode/.test(cv) && /this\.modeEl/.test(cv));
  ok("PC: 목록에서 고르면 chat.mode 호출", /api\.chatMode\(/.test(cv));
  ok("PC: 전환 중 push 로 되돌아가지 않는다", /_modeBusy/.test(cv));
  // ★ 2026-08-02 실사고: push 는 '변경 순간 1회'라 그때 끊겨 있으면 알약이 옛 모드로 굳는다.
  //  캐치업(chat.since)이 모드의 정본이어야 자가 치유가 된다 — 데몬·양 클라 3곳 전부 핀.
  ok("PC: 캐치업(chat.since) 응답의 모드로 화해한다", /r\.statusMode/.test(cv));
  // 즉시성(사용자 요청 2026-08-02): 폴링을 기다리지 않는 두 순간 — ① 우리 입력으로 shift+tab 이
  //  지나갈 때 ② TUI→채팅 토글. 둘 다 '그 순간의 화면'을 읽어야 알약이 바로 맞는다.
  ok("PC: 채팅으로 토글하면 즉시 캐치업한다", /if \(this\._chatId\) this\._catchUp\(\);/.test(cv));
  ok("데몬: shift\+tab(CSI Z)이 입력 경로를 지나가면 즉시 재확인", /onTerminalInput/.test(sl) && /CSI_Z/.test(sl));
  ok("데몬: pty 입력이 감시자에게 통지한다", /onTerminalInput\(/.test(read("../../codingpt_daemon/packages/runner-core/pty.js")));
  ok("데몬: chat.open 스냅샷은 캐시가 아니라 새로 읽는다", /await pollOne\(chatId\)/.test(sl) && !/w\.last == null && w\.lastMode == null/.test(sl));
  ok("PC: 실패를 배너로 알린다(조용한 실패 금지)", /MODE_UNREACHABLE/.test(cv) && /MODE_BLOCKED/.test(cv));
  const api = read("../src/js/api.js");
  const cv2 = read("../src/js/pane.js");
  const rs = read("../src-tauri/src/cptsock.rs");
  // PC 로컬 터미널은 tmux 직결이라 데몬이 그 키를 못 본다 → PC 가 직접 "다시 봐"를 알린다.
  ok("데몬: 로컬 PC 용 재확인 신호(status.poke) + 채팅 로컬 직결(open/since/mode)",
    /cmd === 'status\.poke'/.test(cs) && /cmd === 'chat\.mode'/.test(cs) && /cmd === 'chat\.open' \|\| cmd === 'chat\.since'/.test(cs));
  ok("PC: 로컬 shift+tab 을 보낼 때 데몬에 재확인을 알린다", /_pokeMode\(\)/.test(cv2) && /modePoke/.test(api));
  ok("PC: Rust 브리지(mode_poke/chat_local)가 소켓으로 위임",
    /fn mode_poke/.test(rs) && /status\.poke/.test(rs) && /fn chat_local/.test(rs) && /CHAT_LOCAL_OK/.test(rs));
  // 로컬 터미널이면 사이드카 직결(1~2ms), 원격이면 back 릴레이 — 이 분기가 사라지면 다시 느려진다.
  ok("PC: 로컬/원격에 따라 채팅 RPC 경로를 가른다", /isLocal\?\.\(\)/.test(cv) && /chatLocal\("chat\.open"/.test(cv) && /chatLocal\("chat\.since"/.test(cv));
  ok("PC: 모드 선택은 왕복을 기다리지 않는다(낙관 적용 후 실패 시 되돌림)",
    /_closeModeMenu\(\);\n\s*this\.modeEl\?\.classList\.add\("busy"\)/.test(cv) && /this\._setMode\(prev\)/.test(cv));
  ok("PC: 채팅으로 토글하면 모드를 '지금 화면'으로 다시 읽는다", /_refreshMode\(\)/.test(cv));
  ok("데몬: 모드 전환 직후 다른 기기도 즉시 갱신(감시자 깨움)", /driveMode\(io[\s\S]{0,400}pokeTermSession/.test(cs));
  ok("PC: api.chatMode → /api/daemon/chat/mode", /chat\/mode/.test(api));
  const css = read("../src/styles.css");
  ok("PC: 알약/목록 CSS", /\.chat-mode\b/.test(css) && /\.chat-mode-menu/.test(css));
  // 모드 심볼(⏸/⏵⏵)은 화면에 그리지 않는다 — 사용자 확정 2026-08-02(왼쪽 아이콘 제거).
  ok("PC: 모드 심볼을 그리지 않는다", !/chat-mode-row-sym/.test(cv) && !/chat-mode-sym/.test(cv));

  const app = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱: 컴포저 알약 + 바텀시트", /modeView/.test(app("src/workspace/chat/ChatComposer.tsx")) && /AgentModeSheet/.test(app("src/workspace/chat/ChatComposer.tsx")));
  ok("앱: 시트가 카탈로그 선택지를 그린다", /agentModeChoices/.test(app("src/workspace/chat/AgentModeSheet.tsx")));
  ok("앱: 모드 심볼을 그리지 않는다",
    !/\{m\.symbol\}/.test(app("src/workspace/chat/AgentModeSheet.tsx")) && !/modeView\.symbol/.test(app("src/workspace/chat/ChatComposer.tsx")));
  ok("앱: ChatBody 가 chat.mode 를 부르고 실패를 표시", /chatService\.chatMode/.test(app("src/workspace/chat/ChatBody.tsx")) && /modeErr/.test(app("src/workspace/chat/ChatBody.tsx")));
  ok("데몬: chat.since 가 현재 모드를 실어 준다(캡처 없이 캐시)", /statusMode/.test(ts) && /modeFor\(/.test(ts));
  ok("앱: 캐치업 응답의 모드로 화해한다", /statusMode\?: AgentMode/.test(app("src/workspace/chat/useChatStream.ts")));
  ok("앱: 스트림이 초기값+push 로 모드를 잇는다(에코 가드 포함)", /statusMode/.test(app("src/workspace/chat/useChatStream.ts")) && /MODE_ECHO_GUARD_MS/.test(app("src/workspace/chat/useChatStream.ts")));
  ok("앱: 서비스가 /chat/mode 를 친다", /chat\/mode/.test(app("src/services/chatService.ts")));
}

if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log("\nALL PASS");
