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
  // lines 도 mode 와 같은 "모를 땐 필드를 뺀다" 규칙으로 바뀌었다(2026-08-03) — 빈 배열을 실으면
  //  클라가 statusline 을 지웠고 pull 이 없어 되살아나지 않았다. 핀도 그 모양을 따라간다.
  ok("데몬: chat.open 응답 + status_line push 에 모드 동봉",
    /statusMode/.test(ts) && /kind: 'status_line', \.\.\.\(lines \? \{ lines \} : \{\}\), \.\.\.\(mode/.test(ts));

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
  ok("데몬: pty 입력이 감시자에게 통지한다", /onTerminalInput\(/.test(read("../../codingpt_daemon/packages/runner-core/pty-v3.js")));
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


// ── 대화가 참조한 미디어(`![라벨](경로)`) 표현 규칙 — 3구현 패리티 + 배관 핀 ──────────────────
// 규칙(사용자 확정 2026-08-02): 의도 판별은 **마크다운 문법**이 한다. `![]()` = 그린다,
//  `[]()`·맨 경로 = 칩. 어느 쪽이든 경로는 화면에 남는다(오판 비용 0).
{
  const cases = [
    ["/var/folders/x/screenshot-7.jpg", { via: "path", kind: "image", name: "screenshot-7.jpg" }],
    ["docs/demo.mp4", { via: "path", kind: "video", name: "demo.mp4" }],
    ["report.md", { via: "path", kind: "file", name: "report.md" }],
    ["https://a.com/b/c.png?v=2", { via: "url", kind: "image", name: "c.png" }],
  ];
  for (const [target, want] of cases) {
    const got = PC.mediaRefOf(target);
    eq(`PC 미디어 분류: ${target}`, { via: got.via, kind: got.kind, name: got.name }, want);
  }
  ok("PC: 빈 값은 null", PC.mediaRefOf("") === null && PC.mediaRefOf(null) === null);

  const tsPath = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath).href)}).then((m) => {
       const t = ${JSON.stringify(cases.map(([t]) => t))};
       console.log(JSON.stringify(t.map((x) => { const g = m.mediaRefOf(x); return { via: g.via, kind: g.kind, name: g.name }; })));
     });`], { encoding: "utf8" });
  let app = null;
  try { app = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch (_) { app = null; }
  eq("앱 미디어 분류 = PC 와 동일", app, cases.map(([, w]) => w));

  const md = read("../src/js/chat-md.js");
  ok("PC 마크다운: 이미지 문법 → 미디어 자리, 링크형 경로 → 칩",
    /class="chat-media"/.test(md) && /class="chat-file"/.test(md));
  const cv3 = read("../src/js/chat-view.js");
  ok("PC: 화면에 들어올 때 로드(IntersectionObserver) + 캡션에 경로", /IntersectionObserver/.test(cv3) && /chat-media-cap/.test(cv3));
  ok("PC: 로컬은 직접 읽고 원격은 데몬 chat.file", /filePreviewB64/.test(cv3) && /chatFile\(/.test(cv3));
  const ts2 = read("../../codingpt_daemon/packages/runner-core/transcript.js");
  ok("데몬: chat.file 은 그 대화가 내보낸 경로만 서빙(권한 = 트랜스크립트)",
    /case 'chat\.file'/.test(ts2) && /not_referenced/.test(ts2) && /noteMediaRefs/.test(ts2));
  ok("데몬: 크기 상한과 형식 allowlist", /MEDIA_IMAGE_CAP/.test(ts2) && /MEDIA_VIDEO_CAP/.test(ts2) && /MEDIA_MIME/.test(ts2));
  const back2 = read("../../codingpt_back/routes/daemonRoutes.js");
  ok("back: POST /chat/file 라우트", /\/chat\/file/.test(back2));
  const appf = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱: 이미지/링크 규칙 + 미디어 컴포넌트", /ChatMedia/.test(appf("src/workspace/chat/ChatMarkdown.tsx")) && /image:/.test(appf("src/workspace/chat/ChatMarkdown.tsx")));
  ok("앱: 영상은 캐시 파일로 떨어뜨려 재생(데이터 URI 재생 회피)", /writeFile/.test(appf("src/workspace/chat/ChatMedia.tsx")) && /react-native-video/.test(appf("src/workspace/chat/ChatMedia.tsx")));
  ok("앱: 실패 사유를 화면에 적는다(조용한 빈 자리 금지)", /reasonText/.test(appf("src/workspace/chat/ChatMedia.tsx")));
  // ★ 2026-08-02 실사고 2건(안드로이드): ① 리스트 갱신마다 이미지가 다시 그려짐 ② 고정 박스 배치.
  //  ①의 방어는 **모듈 캐시(경로→캐시 파일 URI) + 리스트 문맥 memo** 둘 다여야 한다(하나만으론 샌다).
  ok("앱: 미디어는 캐시 파일 URI 로 재사용한다(리마운트해도 재다운로드 없음)",
    /mediaCache/.test(appf("src/workspace/chat/ChatMedia.tsx")) && /cachePut\(/.test(appf("src/workspace/chat/ChatMedia.tsx")));
  ok("앱: 리스트에 넘기는 미디어 문맥이 memo 로 고정(인라인 객체 금지)",
    /const mediaCtx = useMemo/.test(appf("src/workspace/chat/ChatBody.tsx")) && /media=\{mediaCtx\}/.test(appf("src/workspace/chat/ChatBody.tsx")));
  ok("앱: 원본 비율로 그린다(고정 높이 박스 금지, PC max-height 420 미러)",
    /MAX_H = 420/.test(appf("src/workspace/chat/ChatMedia.tsx")) && /aspect/.test(appf("src/workspace/chat/ChatMedia.tsx"))
    && !/height: 220/.test(appf("src/workspace/chat/ChatMedia.tsx")));
}


// ── TUI 패리티: 편집 diff 표시 + 끝난 도구 묶기(2026-08-02 사용자 요청) ────────────────────────
{
  // 묶음 라벨 규칙 3구현 동일(PC 는 이름 배열, 앱은 행 배열을 받는다 — 결과 문자열이 같아야 한다).
  const names = ["mcp__claude-in-chrome__navigate", "mcp__claude-in-chrome__computer", "Bash", "Bash", "Edit"];
  eq("PC 묶음 라벨", PC.toolRunLabel(names), "claude-in-chrome 2 · 셸 2 · 편집 1");
  const tsPath2 = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r2 = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath2).href)}).then((m) => {
       const rows = ${JSON.stringify(names)}.map((n, i) => ({ key: String(i), msg: { seq: i, kind: 'tool_use', tool: { id: 't'+i, name: n } }, result: { ok: true } }));
       const patchRows = [{ key: 'p', msg: { seq: 99, kind: 'tool_use', tool: { id: 'p', name: 'Edit' } }, result: { ok: true, patch: { hunks: [] } } }];
       const grouped = m.groupToolRuns([...rows]);
       const withPatch = m.groupToolRuns([...rows.slice(0,4), ...patchRows]);
       const pl = m.patchLines({ hunks: [{ oldStart: 10, newStart: 10, lines: [' a', '-b', '+c'] }] });
       console.log(JSON.stringify({ label: m.toolRunLabel(rows), groupedLen: grouped.length, isGroup: !!grouped[0].group,
         patchNotGrouped: withPatch[withPatch.length-1].group === undefined, lines: pl.lines }));
     });`], { encoding: "utf8" });
  let app2 = null;
  try { app2 = JSON.parse((r2.stdout || "").trim().split("\n").pop()); } catch (_) { app2 = null; }
  eq("앱 묶음 라벨 = PC 와 동일", app2 && app2.label, PC.toolRunLabel(names));
  ok("앱: 연속 도구 5개가 한 행으로 묶인다", app2 && app2.groupedLen === 1 && app2.isGroup);
  ok("앱: diff 가 붙은 편집 행은 묶지 않는다(TUI 도 Update 는 펼쳐 둔다)", app2 && app2.patchNotGrouped);
  eq("앱 patchLines = PC 와 동일(줄번호·부호)", app2 && app2.lines, PC.patchLines({ hunks: [{ oldStart: 10, newStart: 10, lines: [" a", "-b", "+c"] }] }).lines);

  const ts3 = read("../../codingpt_daemon/packages/runner-core/transcript.js");
  ok("데몬: 편집 결과에서 structuredPatch 를 뽑고 상투 문구는 비운다",
    /summarizePatch/.test(ts3) && /preview: patch \? '' :/.test(ts3));
  const cv4 = read("../src/js/chat-view.js");
  ok("PC: diff 렌더 + 묶기 후처리 + 편집행 제외", /_patchHtml/.test(cv4) && /_regroupTools/.test(cv4) && /!el\.querySelector\("\.chat-diff"\)/.test(cv4));
  const css2 = read("../src/styles.css");
  ok("PC: diff 는 자기 박스 안에서만 가로 스크롤(아래 줄을 덮지 않게)", /\.chat-diff \{[\s\S]{0,200}overflow-x: auto/.test(css2));
  const appf2 = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱: diff 뷰 + 도구 묶음 행", /DiffView/.test(appf2("src/workspace/chat/ChatRow.tsx")) && /ToolGroup/.test(appf2("src/workspace/chat/ChatRow.tsx")));
  ok("앱: 이미지 전체화면은 핀치 확대/이동 가능(사진 뷰어 관례)",
    /Gesture\.Pinch/.test(appf2("src/workspace/chat/ImageViewer.tsx")) && /Gesture\.Pan/.test(appf2("src/workspace/chat/ImageViewer.tsx")));
}

// ── codex 모드 패리티(2026-08-03 개정) ────────────────────────────────────────
// ★ 사용자 확정: 알약은 **shift+tab 이 바꾸는 것만** 담는다. codex 의 shift+tab 은 Default ↔ Plan
//  두 상태이고, 권한 3종(`/permissions`)은 다른 축이라 섞지 않는다(섞으면 체크가 둘 켜져
//  "중복 선택"처럼 보인다 — 사용자 지적). 권한은 팔레트 → 선택 화면 카드에서 고른다.
{
  const codexCat = PC.CODEX_MODES.map((m) => ({ id: m.id, symbol: m.symbol, label: m.label, desc: m.desc }));
  eq("PC codex 카탈로그 = shift+tab 두 상태뿐", codexCat.map((m) => m.id), ["codexDefault", "codexPlan"]);
  eq("PC codex 라벨 = TUI 가 쓰는 단어", codexCat.map((m) => m.label), ["Default mode", "Plan mode"]);
  ok("PC: 권한 항목은 알약 카탈로그에 없다",
    !PC.CODEX_MODES.some((m) => /Approval|Approve|Full Access|Ask for/.test(m.label)));
  eq("PC: 지금 모드 id 로 카탈로그가 갈린다(에이전트를 따로 몰라도 된다)", [
    PC.agentModeChoices({ id: "codexPlan" }).map((m) => m.id),
    PC.agentModeChoices({ id: "auto" }).map((m) => m.id),
  ], [["codexDefault", "codexPlan"], ["default", "acceptEdits", "plan", "auto"]]);
  eq("PC: 체크는 언제나 하나(라디오)", PC.agentModeChoices({ id: "codexPlan" })
    .filter((m) => PC.agentModeIsOn(m, { id: "codexPlan" })).map((m) => m.id), ["codexPlan"]);
  eq("PC: 알약 라벨(낙관 적용 경로)", [
    PC.agentModeLabel({ id: "codexPlan" }), PC.agentModeLabel({ id: "codexDefault" }), PC.agentModeLabel({ id: "auto" }),
  ], ["Plan mode", "Default mode", "auto mode on"]);

  const tsPath2 = path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts");
  const r2 = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath2).href)}).then((m) => {
       const cur = { id: "codexPlan" };
       console.log(JSON.stringify({
         cat: m.CODEX_MODES.map((x) => ({ id: x.id, symbol: x.symbol, label: x.label, desc: x.desc })),
         choices: m.agentModeChoices(cur).map((x) => x.id),
         on: m.agentModeChoices(cur).filter((x) => m.agentModeIsOn(x, cur)).map((x) => x.id),
         labels: [m.agentModeLabel({ id: "codexPlan" }), m.agentModeLabel({ id: "codexDefault" }), m.agentModeLabel({ id: "auto" })],
       }));
     });`], { encoding: "utf8" });
  let appx = null;
  try { appx = JSON.parse((r2.stdout || "").trim().split("\n").pop()); } catch (_) { appx = null; }
  eq("앱 codex 카탈로그 = PC 와 동일", appx && appx.cat, codexCat);
  eq("앱 codex 선택지/체크 규칙 동일", appx && [appx.choices, appx.on], [["codexDefault", "codexPlan"], ["codexPlan"]]);
  eq("앱 알약 라벨 동일", appx && appx.labels, ["Plan mode", "Default mode", "auto mode on"]);

  const sl2 = require("../../codingpt_daemon/packages/runner-core/status-line");
  eq("데몬이 아는 codex 모드 id = 클라 카탈로그", sl2.CODEX_MODE_IDS.slice().sort(), codexCat.map((m) => m.id).sort());
  const LINE = (plan) => `  gpt-5.6-sol low fast · Context 0% used · Fast on · Approve for me · 1M window${plan ? "        Plan mode" : ""}`;
  eq("데몬 파싱: 상태줄의 Plan mode 유무로만", [sl2.parseCodexMode(LINE(true)), sl2.parseCodexMode(LINE(false))], [
    { id: "codexPlan", label: "Plan mode", symbol: "", plan: true },
    { id: "codexDefault", label: "Default mode", symbol: "", plan: false },
  ]);
  ok("데몬 라벨 = 클라 카탈로그", codexCat.every((m) => sl2.parseCodexMode(m.id === "codexPlan" ? LINE(true) : LINE(false)).label === m.label));

  const cs2 = read("../../codingpt_daemon/packages/runner-core/cpt-server.js");
  ok("데몬: codex 모드 조작은 shift+tab 하나뿐(컴포저를 건드리지 않는다)",
    /driveCodexMode/.test(cs2) && /io\.key\('BTab'\)/.test(cs2) && !/CODEX_PERM_CMD/.test(cs2));
  ok("데몬: 다이얼로그 중엔 모드를 판정하지 않는다(Default 단정 금지)",
    /if \(extractDialog\(screen\)\) return null;/.test(read("../../codingpt_daemon/packages/runner-core/status-line.js")));
  const cv5 = read("../src/js/chat-view.js");
  ok("PC: 이미 그 모드면 목록만 닫는다", /this\._mode && this\._mode\.id === id\) \{ this\._closeModeMenu/.test(cv5));
  const appc = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱: 시트가 같은 판정 함수를 쓴다", /agentModeIsOn/.test(appc("src/workspace/chat/AgentModeSheet.tsx")));
  ok("앱: 모드 선택도 낙관 적용 후 실패 시 되돌린다", /setStatusMode\(prev\)/.test(appc("src/workspace/chat/ChatBody.tsx")));
}


if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log("\nALL PASS");
