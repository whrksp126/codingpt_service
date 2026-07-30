// TUI statusline 미러 — ANSI 변환 실행 검증(PC ansi.js) + 앱 ansi.ts 실행 패리티 + 배관 핀.
//  픽스처 = 2026-07-30 라이브 tmux capture-pane -e 원문(데몬 status-line.test.js 와 동일 캡처).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { ansiToHtml } from "../src/js/ansi.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
let fails = 0;
function ok(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + " " + name);
  if (!cond) fails++;
}
function eq(name, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log((pass ? "PASS" : "FAIL") + " " + name + (pass ? "" : `\n  got=${JSON.stringify(got)}\n  want=${JSON.stringify(want)}`));
  if (!pass) fails++;
}

const PAL = {
  cyan: "#0CC", green: "#0C0", brightBlack: "#888", yellow: "#FC0",
  foreground: "#EEE", background: "#111",
};
// 실캡처(claude 커스텀 statusline 줄) — 그레이 246 = 8+(246-232)*10 = 148.
const REAL = "\x1b[39m   \x1b[1m\x1b[36m◆ Opus 5\x1b[0m\x1b[38;5;246m  \x1b[32m█░░ 15%\x1b[38;5;246m \x1b[90m146k/1.0M\x1b[38;5;246m  \x1b[2m5h\x1b[0m\x1b[38;5;246m \x1b[32m23%\x1b[39m";

// ── PC(ansi.js) 실행 검증 ──
eq("PC: 실캡처 줄 → 스팬 HTML(색·bold·dim·256색 전부)", ansiToHtml(REAL, PAL),
  '   <span style="color:#0CC;font-weight:700">◆ Opus 5</span>'
  + '<span style="color:rgb(148,148,148)">  </span>'
  + '<span style="color:#0C0">█░░ 15%</span>'
  + '<span style="color:rgb(148,148,148)"> </span>'
  + '<span style="color:#888">146k/1.0M</span>'
  + '<span style="color:rgb(148,148,148)">  </span>'
  + '<span style="color:rgb(148,148,148);opacity:0.6">5h</span>'
  + '<span style="color:rgb(148,148,148)"> </span>'
  + '<span style="color:#0C0">23%</span>');
eq("PC: 256색 큐브 공식(38;5;110 → rgb(135,175,215))", ansiToHtml("\x1b[38;5;110mX", PAL), '<span style="color:rgb(135,175,215)">X</span>');
eq("PC: truecolor + 배경 + 반전", ansiToHtml("\x1b[38;2;10;20;30m\x1b[43mA\x1b[7mB", PAL),
  '<span style="color:rgb(10,20,30);background:#FC0">A</span><span style="color:#FC0;background:rgb(10,20,30)">B</span>');
eq("PC: HTML 이스케이프", ansiToHtml("<b>&", PAL), "&lt;b&gt;&amp;");
eq("PC: 비-SGR CSI/OSC 제거", ansiToHtml("\x1b[2K\x1b]0;title\x07plain", PAL), "plain");

// ── 앱(ansi.ts) 실행 패리티 — node --experimental-strip-types 로 실제 소스를 돌린다 ──
{
  const tsPath = path.resolve(here, "../../../codingpt_app/src/workspace/chat/ansi.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import(${JSON.stringify(url.pathToFileURL(tsPath).href)}).then((m) => {
       const line = Buffer.from(process.env.SL_LINE_B64, "base64").toString("utf8");
       console.log(JSON.stringify(m.parseAnsiLine(line, JSON.parse(process.env.SL_PAL))));
     });`],
  { env: { ...process.env, SL_LINE_B64: Buffer.from(REAL, "utf8").toString("base64"), SL_PAL: JSON.stringify(PAL) }, encoding: "utf8" });
  ok("앱 ansi.ts 를 strip-types 로 실행할 수 있다", r.status === 0);
  let segs = [];
  try { segs = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch (_) { segs = null; }
  eq("앱: 같은 픽스처 → 같은 세그먼트(색/굵기/dim 패리티)", segs, [
    { text: "   " },
    { text: "◆ Opus 5", color: "#0CC", bold: true },
    { text: "  ", color: "rgb(148,148,148)" },
    { text: "█░░ 15%", color: "#0C0" },
    { text: " ", color: "rgb(148,148,148)" },
    { text: "146k/1.0M", color: "#888" },
    { text: "  ", color: "rgb(148,148,148)" },
    { text: "5h", color: "rgb(148,148,148)", dim: true },
    { text: " ", color: "rgb(148,148,148)" },
    { text: "23%", color: "#0C0" },
  ]);
}

// ── 배관 핀 ──
const read = (p) => fs.readFileSync(path.resolve(here, p), "utf8");
{
  const cv = read("../src/js/chat-view.js");
  ok("PC 채팅에 statusline 스트립 요소(컴포저 위)", /chat-statusline/.test(cv) && /this\.statusEl/.test(cv));
  ok("PC 가 control(status_line) push 와 open 초기값 둘 다 반영", /ctl === "status_line"/.test(cv) && /r\.statusLines/.test(cv));
  ok("PC 렌더 = 터미널 팔레트(termTheme) + ansiToHtml", /termTheme\(\)/.test(cv) && /ansiToHtml\(/.test(cv));
  const css = read("../src/styles.css");
  ok("스트립 CSS(모노스페이스·한 줄 말줄임)", /\.chat-statusline-row/.test(css) && /white-space: pre/.test(css));
  const ts = read("../../codingpt_daemon/packages/runner-core/transcript.js");
  ok("데몬 chat.open 이 statusline 감시 등록 + 초기값 응답", /statusLib\.watch\(/.test(ts) && /statusLines/.test(ts));
  ok("데몬 push = control(kind='status_line') — back 무변경 통과 채널", /kind: 'status_line'/.test(ts));
  ok("tail 소멸 시 감시도 해제", /require\('\.\/status-line'\)\.unwatch/.test(ts));
  const sl = read("../../codingpt_daemon/packages/runner-core/status-line.js");
  ok("데몬 추출 규칙 존재(claude 구분선/푸터·codex ›)", /RULE_RE/.test(sl) && /CLAUDE_FOOTER_RE/.test(sl) && /codex/.test(sl));
  // 앱 배관
  const app = (p) => read(path.resolve(here, "../../../codingpt_app", p));
  ok("앱 useChatStream 이 statusLines 를 노출(초기값+push, poke 미유발)", /status_line/.test(app("src/workspace/chat/useChatStream.ts")) && /statusLines/.test(app("src/workspace/chat/useChatStream.ts")));
  ok("앱 ChatBody 가 컴포저 위에 StatusLineStrip 을 그린다", /StatusLineStrip/.test(app("src/workspace/chat/ChatBody.tsx")) && /termPalette\(/.test(app("src/workspace/chat/ChatBody.tsx")));
  ok("앱 프레임 타입에 status_line/lines 확장", /'status_line'/.test(app("src/workspace/chatModel.ts")) && /lines\?: string\[\]/.test(app("src/workspace/chatModel.ts")));
}

if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log("\nALL PASS");
