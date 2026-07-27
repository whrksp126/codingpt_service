// chat-composer.mjs — 채팅 컴포저 `+` 파일 넣기 규칙(실행 검증) + 배치 계약(소스 핀).
//
// 왜 이 파일이 따로 있는가
//  · 사용자 요구(2026-07-27): "일반적인 agent app 처럼 채팅 화면 UI/UX — 왼쪽에 + 버튼, 인풋 오른쪽에
//    전송 버튼". `+` 는 **워크스페이스 파일을 골라 그 경로를 입력에 삽입**한다(업로드가 아니다).
//  · 이 규칙들이 결정하는 것은 곧 **에이전트에게 실제로 전달되는 문자열**이다. DOM 안에 묻어 두면
//    정규식으로 소스 모양만 보는 공허한 검증이 되므로 순수 함수(chat-model.js)로 빼서 여기서 실행한다.
//    (지난 라운드 교훈: "초록인데 아무것도 검증하지 않는" 테스트가 결함을 숨긴다.)
//  · 절대경로가 아니라 상대경로인 이유: 에이전트 cwd = 워크스페이스 루트라 짧고 정확하며, 홈 경로에
//    박힌 사용자 계정명이 대화 기록에 남지 않는다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const M = await import("../src/js/chat-model.js");

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ── 1. 상대 경로 변환 ────────────────────────────────────────────────────────────
eq("루트 아래 파일 → 상대 경로", M.relToRoot("codingpt-demo", "codingpt-demo/src/index.html"), "src/index.html");
eq("루트 뒤 슬래시 허용", M.relToRoot("codingpt-demo/", "codingpt-demo/a.js"), "a.js");
eq("루트가 비면 그대로", M.relToRoot("", "x/y.js"), "x/y.js");
// ★ 접두사만 같은 형제 디렉토리를 잘라내면 **다른 파일을 가리킨다** — 경계 문자(/)를 반드시 본다.
eq("접두사만 같은 형제는 자르지 않는다", M.relToRoot("demo", "demo2/a.js"), "demo2/a.js");
eq("루트 자체는 자르지 않는다", M.relToRoot("demo", "demo"), "demo");

// ── 2. 필터 ──────────────────────────────────────────────────────────────────────
const FILES = [
  "demo/src/index.html", "demo/src/app.js", "demo/README.md",
  "demo/src/components/Index.tsx", "demo/pkg/index.js",
];
eq("빈 질의 = 전체", M.filterFiles(FILES, "demo", "", 99).length, 5);
eq("대소문자 무시 부분일치(경로 전체 대상)",
  M.filterFiles(FILES, "demo", "index", 99),
  ["demo/src/index.html", "demo/src/components/Index.tsx", "demo/pkg/index.js"]);
eq("디렉토리 이름으로도 걸린다", M.filterFiles(FILES, "demo", "components", 99), ["demo/src/components/Index.tsx"]);
eq("공백만 있는 질의 = 전체(trim)", M.filterFiles(FILES, "demo", "   ", 99).length, 5);
eq("limit 로 자른다", M.filterFiles(FILES, "demo", "", 2).length, 2);
// ★ 필터는 **상대** 경로를 본다 — 루트 경로에 우연히 들어간 글자로 전부 매치되면 필터가 무의미해진다.
eq("루트 이름은 필터 대상이 아니다", M.filterFiles(FILES, "demo", "demo", 99), []);
eq("없으면 빈 배열", M.filterFiles(FILES, "demo", "존재안함", 99), []);
eq("입력이 null 이어도 죽지 않는다", M.filterFiles(null, "demo", "x", 9), []);

// ── 3. 커서 삽입 ─────────────────────────────────────────────────────────────────
eq("빈 입력에 삽입(앞 공백 없음, 뒤 공백 1칸)", M.insertPathAt("", 0, 0, "a.js"), { value: "a.js ", caret: 5 });
eq("앞이 글자면 공백을 1칸 넣는다(경로가 붙어 다른 이름이 되는 것 방지)",
  M.insertPathAt("고쳐줘", 3, 3, "a.js"), { value: "고쳐줘 a.js ", caret: 9 });
eq("앞이 이미 공백이면 더 넣지 않는다", M.insertPathAt("고쳐줘 ", 4, 4, "a.js"), { value: "고쳐줘 a.js ", caret: 9 });
eq("줄바꿈도 공백으로 본다", M.insertPathAt("한 줄\n", 4, 4, "a.js"), { value: "한 줄\na.js ", caret: 9 });
eq("커서가 중간이면 그 자리에 낀다", M.insertPathAt("ab", 1, 1, "x"), { value: "a x b", caret: 4 });
eq("선택 영역은 대체된다", M.insertPathAt("지울것", 0, 3, "a.js"), { value: "a.js ", caret: 5 });
eq("범위를 넘긴 커서는 클램프된다", M.insertPathAt("ab", 99, 99, "x"), { value: "ab x ", caret: 5 });
// start>end 는 정상 입력이 아니다 — 삽입점으로만 쓰고 **아무 글자도 지우지 않는다**(e=max(s,·)).
eq("start>end 로 와도 뒤집혀 지워지지 않는다", M.insertPathAt("abcd", 3, 1, "x"), { value: "abc x d", caret: 6 });

// ── 4. 트리 평탄화 ───────────────────────────────────────────────────────────────
const TREE = [
  { name: "src", dir: true, children: [
    { name: "index.html", dir: false, path: "demo/src/index.html" },
    { name: "deep", dir: true, children: [{ name: "d.ts", dir: false, path: "demo/src/deep/d.ts" }] },
  ] },
  { name: "README.md", dir: false, path: "demo/README.md" },
  { name: "empty", dir: true, children: null },
];
eq("파일만 평탄화(디렉토리 제외·재귀)", M.flattenFiles(TREE),
  ["demo/src/index.html", "demo/src/deep/d.ts", "demo/README.md"]);
eq("null 트리도 안전", M.flattenFiles(null), []);
// path 없는 노드(원격 응답 결손)를 넣으면 undefined 가 목록에 섞여 클릭 시 조용히 아무 일도 안 한다.
eq("path 없는 파일 노드는 버린다", M.flattenFiles([{ name: "x", dir: false }]), []);

// ── 5. 배치 계약(소스 핀 — 순수 함수로 검증할 수 없는 부분만) ───────────────────
{
  const cv = readFileSync(path.resolve(here, "../src/js/chat-view.js"), "utf8");
  const css = readFileSync(path.resolve(here, "../src/styles.css"), "utf8");
  const comp = /<div class="chat-composer">([\s\S]*?)<\/div>/.exec(cv)?.[1] || "";
  const order = [...comp.matchAll(/class="(chat-plus|chat-input|chat-send)"/g)].map((m) => m[1]);
  eq("컴포저 순서 = [+][입력][전송]", order, ["chat-plus", "chat-input", "chat-send"]);
  ok("`+` 팝오버는 컴포저 기준 위로 펼친다(입력을 가리지 않게)",
    /\.chat-pick\s*\{[^}]*bottom:\s*calc\(100% - 4px\)/.test(css)
    && /\.chat-composer\s*\{[^}]*position:\s*relative/.test(css));
  // dispose 에서 document 캡처 리스너를 떼지 않으면 pane 이 사라진 뒤에도 계속 살아 누적된다.
  const disp = cv.slice(cv.indexOf("  dispose() {"));
  ok("dispose 가 피커를 닫는다(document 캡처 리스너 누수 금지)", /_closePicker\(\)/.test(disp.slice(0, 400)));
  ok("피커 목록 실패를 빈 목록으로 위장하지 않는다",
    /목록을 불러오지 못했습니다/.test(cv));
  // 삽입은 반드시 상대 경로다(절대경로를 넣으면 홈 경로의 계정명이 대화에 남는다).
  ok("삽입 경로는 relToRoot 를 거친다", /insertPathAt\(ta\.value/.test(cv) && /relToRoot\(this\._cwd\(\)/.test(cv));
  ok("컴포저 placeholder 는 짧다(설명 문구 금지 — 사용자는 안 읽는다)",
    (/placeholder="([^"]*)"/.exec(comp)?.[1] || "").length <= 12, /placeholder="([^"]*)"/.exec(comp)?.[1]);
}

// ── 6. `noSession`(대화가 아직 없다) — 빈 상태 + **폴링 폭주 방지**(실행 검증) ─────────────
// 데몬 계약(2026-07-27): `chat.open` 이 오류가 아니라 성공 응답으로
//   `{ supported:true, noSession:true, reason:'not_started'|'ambiguous'|'none', candidates }` 를 준다.
// ⚠ 여기가 조용한 퇴행의 자리다: 성공이라 `_openFailed` 가 비는데 `chatId` 는 null 이라, 아무 가드가
//   없으면 폴링 틱(4s)마다 chat.open 을 영원히 때린다(화면은 정상 · 에러 0 · 원격이면 릴레이까지 왕복).
//   그래서 재오픈 판정을 순수 함수로 빼고 **호출 횟수를 세어** 검증한다(소스 정규식으로는 안 잡힌다).
{
  const R = M.shouldReopenNoSession;
  const T0 = 1_000_000;
  eq("noSession 이 아니면 기존 규칙에 맡긴다(true)", R({ reason: null, now: T0, lastAt: 0 }), true);
  eq("ambiguous 는 사용자가 고르기 전까지 자동 재시도 0", R({ reason: "ambiguous", now: T0 + 9e6, lastAt: T0 }), false);
  eq("not_started 는 직후엔 재시도하지 않는다", R({ reason: "not_started", now: T0 + 4000, lastAt: T0 }), false);
  eq("not_started 는 느린 간격(30s) 뒤에 한 번 재확인", R({ reason: "not_started", now: T0 + 30000, lastAt: T0 }), true);
  eq("전송 직후 탐색 창 안에서는 매 틱 재시도(훅 바인딩 순간을 잡는다)",
    R({ reason: "not_started", now: T0 + 4000, lastAt: T0, probeUntil: T0 + 30000 }), true);
  eq("탐색 창이 지나면 다시 느린 간격으로", R({ reason: "not_started", now: T0 + 31000, lastAt: T0 + 30000, probeUntil: T0 + 30000 }), false);
  eq("ambiguous 는 탐색 창이 열려 있어도 재시도하지 않는다(서버 상태가 바뀔 수 없다)",
    R({ reason: "ambiguous", now: T0 + 4000, lastAt: T0, probeUntil: T0 + 30000 }), false);

  // ★ 호출 횟수 — 가짜 시계로 10분(4초 × 150틱)을 돌려 실제 재오픈 횟수를 센다.
  const countReopens = (reason, { probeMs = 0 } = {}) => {
    let now = T0, lastAt = T0, calls = 0;
    const probeUntil = probeMs ? T0 + probeMs : 0;
    for (let i = 0; i < 150; i++) {
      now += M.CHAT.POLL_MS;
      if (R({ reason, now, lastAt, probeUntil })) { calls += 1; lastAt = now; } // 재오픈하면 기준점 갱신
    }
    return calls;
  };
  const naive = 150; // 가드가 없을 때(매 틱 chat.open)
  const notStarted = countReopens("not_started");
  ok(`not_started 10분간 재오픈 ${notStarted}회(가드 없으면 ${naive}회)`, notStarted > 0 && notStarted <= 21, String(notStarted));
  eq("ambiguous 10분간 재오픈 0회", countReopens("ambiguous"), 0);
  const probed = countReopens("not_started", { probeMs: 30000 });
  ok(`전송 직후 탐색 창에서는 촘촘히(10분 총 ${probed}회 = 창 안 ~7 + 이후 느린 ${notStarted}회 급)`,
    probed > notStarted && probed <= notStarted + 8 && probed < naive / 3, String(probed));
  eq("noSession 아님(정상 대화) = 판정이 개입하지 않는다", countReopens(null), 150);

  const cv = readFileSync(path.resolve(here, "../src/js/chat-view.js"), "utf8");
  const tick = cv.slice(cv.indexOf("  _tick() {"), cv.indexOf("  async _catchUp("));
  ok("_tick 은 noSession 게이트를 **_open 보다 먼저** 통과시킨다",
    /shouldReopenNoSession\(\{/.test(tick) && tick.indexOf("shouldReopenNoSession") < tick.indexOf("this._open()"), tick.replace(/\s+/g, " ").slice(0, 200));
  ok("noSession 은 오류 배너가 아니라 빈 상태 본문을 그린다",
    /if \(r && r\.noSession\)/.test(cv) && /this\._renderBlank\(\)/.test(cv));
  ok("빈 상태는 짧은 인사 한 줄(설명 문단 금지)", /무엇이든 요청하세요/.test(cv));
  ok("보조 액션 `다른 대화 보기` 는 ambiguous 에서만 나온다",
    /if \(this\._noSession === "ambiguous"\)[\s\S]{0,300}다른 대화 보기/.test(cv));
  ok("고른 세션은 탭 객체에 기억한다(영속·탭 이동 승계)",
    /setSessionPick\?\.\(sid\)/.test(cv) && /getSessionPick\?\.\(\)/.test(cv));
  ok("첫 메시지 전송이 탐색 창을 연다(전송 → 재오픈 경로)",
    /if \(this\._noSession\) this\._probeUntil = Date\.now\(\) \+ CHAT\.NO_SESSION_PROBE_MS;/.test(cv));
  ok("chat_event push 는 noSession 확정을 해제한다(트리거 ②)",
    /_onPush\(frame\) \{[\s\S]{0,400}if \(this\._noSession\) \{/.test(cv));
  // ★ 그 트리거가 **도달 가능**해야 한다: noSession 뷰는 chatId 가 null 이라 chatId 매칭으로는 절대
  //   배달되지 않는다 → sessionId 라우팅이 없으면 위 핀은 죽은 코드를 지키는 셈이 된다.
  ok("push 라우팅이 noSession 뷰에도 닿는다(sessionId 매칭)",
    /!v\._chatId && v\._noSession && frame\.sessionId && v\._sessionId === frame\.sessionId/.test(cv));
  ok("api 에 chatSessions 래퍼가 있다(목록 RPC)",
    /chatSessions: \(q\) =>/.test(readFileSync(path.resolve(here, "../src/js/api.js"), "utf8")));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
