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
import { readFileSync, existsSync } from "node:fs";
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
  // 컴포저 마크업은 이제 **한 덩어리 둥근 상자**다(참고 앱 배치): 위=입력 / 아래=컨트롤 행.
  const comp = cv.slice(cv.indexOf('<div class="chat-composer">'), cv.indexOf("`;", cv.indexOf('<div class="chat-composer">')));
  // class 속성에 상태 클래스가 붙는다(`chat-model hidden`) → 이름 뒤 경계까지만 본다.
  //  `chat-ctl-gap` 은 경계 문자가 '-' 이라 자동으로 걸러진다.
  const order = [...comp.matchAll(/class="(chat-box|chat-input|chat-ctl|chat-plus|chat-model|chat-send)[ "]/g)].map((m) => m[1]);
  eq("컴포저 구조 = 상자[입력][컨트롤행[+][전송]]", order,
    ["chat-box", "chat-input", "chat-ctl", "chat-plus", "chat-send"]);
  // 모델 칩은 폐기(사용자 확정 2026-07-27 2차: "+ 버튼 옆에 있는 모델 표현은 제거"). 되살아나면 실패.
  ok("모델 칩이 없다(마크업·CSS·순수 규칙 전부)",
    !/chat-model/.test(comp) && !/\.chat-model\s*\{/.test(css) && !/prettyModel/.test(cv));
  // 컴포저 배경 = 대화 본문과 같은 색(별색 띠가 "영역이 나뉜 것"으로 읽혔다).
  ok("컴포저에 별색 배경 띠가 없다",
    /\.chat-composer\s*\{[^}]*background:\s*transparent/.test(css));
  // ★ contenteditable 전환(2026-07-30)으로 JS autoGrow 는 폐기 — 높이는 CSS(max-height+overflow)가
  //  전담한다. "숨겨진 동안 측정 → 납작" 계열 사고의 재발 경로 자체가 사라졌는지 부재로 핀한다.
  ok("JS autoGrow 가 없다(높이는 CSS 전담 — 측정 실패 사고 원천 차단)", !/_autoGrow/.test(cv));
  ok("입력에 min-height 바닥이 있다(측정 실패에도 납작해지지 않게)",
    /\.chat-input\s*\{[^}]*min-height:\s*22px/.test(css));
  ok("입력에는 자체 테두리·포커스 링이 없다(상자만 가진다 — '최초 모습이 이상하다'의 원인)",
    /\.chat-input\s*\{[^}]*border:\s*none/.test(css) && !/\.chat-input:focus\s*\{/.test(css));
  ok("전송은 원형 + 빈 입력에선 disabled(거짓 affordance 금지)",
    /\.chat-send\s*\{[^}]*border-radius:\s*999px/.test(css) && /\.chat-send:disabled\s*\{/.test(css)
    && /this\.sendEl\.disabled = !has;/.test(cv));
  ok("PC 컴포저엔 마이크가 없다(웹뷰에 음성 인식 API 부재 — 사용자 확정: PC는 숨김)",
    !/chat-mic/.test(cv) && !/chat-mic/.test(css));
  ok("맨아래로 FAB 는 컴포저의 자식(여러 줄 입력에 파묻히지 않게 bottom:100% 기준)",
    /\.chat-jump\s*\{[^}]*bottom:\s*calc\(100% \+ 4px\)/.test(css)
    && comp.includes('class="chat-jump'));
  ok("`+` 팝오버는 컴포저 기준 위로 펼친다(입력을 가리지 않게)",
    /\.chat-pick\s*\{[^}]*bottom:\s*calc\(100% - 4px\)/.test(css)
    && /\.chat-composer\s*\{[^}]*position:\s*relative/.test(css));
  // dispose 에서 document 캡처 리스너를 떼지 않으면 pane 이 사라진 뒤에도 계속 살아 누적된다.
  const disp = cv.slice(cv.indexOf("  dispose() {"));
  ok("dispose 가 피커를 닫는다(document 캡처 리스너 누수 금지)", /_closePicker\(\)/.test(disp.slice(0, 400)));
  ok("피커 목록 실패를 빈 목록으로 위장하지 않는다",
    /목록을 불러오지 못했습니다/.test(cv));
  // 삽입은 반드시 상대 경로다(절대경로를 넣으면 홈 경로의 계정명이 대화에 남는다).
  ok("삽입 경로는 relToRoot 를 거쳐 커서 위치에 들어간다", /_ceInsertText\(r \+ " "\)/.test(cv) && /relToRoot\(this\._cwd\(\)/.test(cv));
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
  // ★ 2026-07-28 확정: 대화 선택(`다른 대화 보기`) UI 폐기. 채팅 = **지금 이 터미널에서 도는 대화 하나**.
  //  고르게 하려면 사용자가 남의 대화를 열 수 있다는 뜻이고, 그게 실제로 'codex 탭에 claude 대화' 사고를
  //  덮어 가리는 우회로였다. 대신 chat.open 에 **agent 를 실어** 데몬이 옳은 로그를 고르게 한다.
  ok("대화 선택 UI 가 없다(다른 대화 보기 · 세션 시트 · 탭 선택 기억 전부 폐기)",
    !/다른 대화 보기/.test(cv) && !/_openSessionPicker/.test(cv) && !/SessionPick/.test(cv));
  ok("chat.open 에 이 터미널의 에이전트를 실어 보낸다(claude 로 가정하지 않는다)",
    /const agent = this\.ctx\.agent\?\.\(\) \|\| null;/.test(cv) && /\.\.\.\(agent \? \{ agent \} : \{\}\)/.test(cv));
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

// ── 7. 앱 ↔ PC 컴포저 규칙 동치 — **앱 소스를 실행해** 대조한다 ────────────────────────────
// 왜: 전송 가능 판정·모델 칩 문자열·음성 삽입 위치가 두 화면에서 다르면 같은 입력에 다른 결과가 나온다
//  (이 제품에서 반복된 사고 유형). 선례 = agent-toggle.mjs §3(앱 agentPresence.ts 를 오려내 실행).
// ⚠ 앱 `composer.ts` 는 **import 를 갖지 않아야** 한다 — 하나라도 있으면 data: URL 모듈 해석이 실패해
//   이 절이 조용히 SKIP 된다(2026-07-27 실사고: import 하나로 69,300 조합 대조가 사라졌다).
{
  const { createRequire } = await import("node:module");
  const { existsSync } = await import("node:fs");
  const APP = path.resolve(here, "../../../codingpt_app/src/workspace/chat/composer.ts");
  const APPPKG = path.resolve(here, "../../../codingpt_app/package.json");
  let A = null, why = "";
  if (!existsSync(APP) || !existsSync(APPPKG)) why = "codingpt_app 없음 — 단독 체크아웃";
  else {
    try {
      const ts = createRequire(APPPKG)("typescript");
      const src = readFileSync(APP, "utf8");
      const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
      A = await import(`data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`);
    } catch (e) { why = `앱 모듈을 실행할 수 없다(형식/의존성 변경?): ${e.message}`; }
  }
  if (!A) console.log(`SKIP 앱↔PC 컴포저 규칙 동치(${why})`);
  else {
    ok("앱 composer.ts 에 import 가 없다(있으면 이 절이 조용히 SKIP 된다)",
      !/^\s*import[\s{*]/m.test(readFileSync(APP, "utf8")));
    ok("앱이 컴포저 순수 규칙을 export 한다",
      ["composerHasText", "agentDisplayName", "spliceSpeech"].every((k) => typeof A[k] === "function"));

    // (a) 전송 가능 판정 — 공백/개행만 있는 입력을 보내면 TUI 가 프롬프트를 한 번 삼킨다.
    const TEXTS = ["", " ", "\n", " \n\t ", "a", " a ", "0", "안녕", "  줄\n둘  "];
    let bad = [];
    for (const t of TEXTS) if (M.composerHasText(t) !== A.composerHasText(t)) bad.push(JSON.stringify(t));
    ok(`전송 가능 판정 동치 ${TEXTS.length - bad.length}/${TEXTS.length}`, !bad.length, bad.join(","));
    eq("공백만 = 전송 불가", [M.composerHasText("  \n "), A.composerHasText("  \n ")], [false, false]);

    // (c) 에이전트 표시 이름 — 플레이스홀더 "Claude에게 요청".
    const AG = ["claude", "Claude", "codex", "gemini", "cursor-agent", "", null, undefined];
    bad = [];
    for (const g of AG) if (M.agentDisplayName(g) !== A.agentDisplayName(g)) bad.push(JSON.stringify(g));
    ok(`에이전트 표시 이름 동치 ${AG.length - bad.length}/${AG.length}`, !bad.length, bad.join(","));
    eq("모르는 에이전트는 빈 문자열(기본 문구로 폴백)", M.agentDisplayName("cursor-agent"), "");

    // (d) 음성 삽입(앱 전용 규칙이지만 **덮어쓰기**라는 성질을 실행으로 고정한다).
    //   부분 결과가 연달아 오므로 같은 base/anchor 에 계속 덮어써야 한다 — 누적하면
    //   "안녕안녕하세요안녕하세요" 가 된다(가장 흔한 STT 구현 버그).
    let r = A.spliceSpeech("고쳐줘", 3, "안녕");
    eq("커서 위치에 삽입 + 앞 공백 1칸", r, { value: "고쳐줘 안녕", cursor: 6 });
    const base = "고쳐줘", anchor = 3;
    const seq = ["안", "안녕", "안녕하세요"].map((t) => A.spliceSpeech(base, anchor, t).value);
    eq("부분 결과는 누적되지 않고 덮어쓴다", seq, ["고쳐줘 안", "고쳐줘 안녕", "고쳐줘 안녕하세요"]);
    eq("앵커가 범위를 넘으면 끝에 붙는다", A.spliceSpeech("ab", 99, "x").value, "ab x");
    eq("앞이 이미 공백이면 더 넣지 않는다", A.spliceSpeech("ab ", 3, "x").value, "ab x");
    eq("빈 초안이면 앞 공백 없음", A.spliceSpeech("", 0, "x"), { value: "x", cursor: 1 });
    eq("상한을 넘기면 자른다", A.spliceSpeech("abc", 3, "defghij", 6).value, "abc de");
    // ★ 연속 발화 — 최종 결과에서 **커밋**하지 않으면 두 번째 문장이 첫 문장을 덮어써 앞 내용이 사라진다
    //  (사용자 Android 실측 신고 2026-07-27). 커밋 = base/anchor 를 방금 결과의 끝으로 옮기는 것.
    //  여기서는 컴포저의 커밋 규칙을 그대로 재현해 "이어 말하기" 가 성립하는지 실행으로 확인한다.
    {
      let base = "", anchor = 0, value = "";
      const speak = (t, final) => {
        const r = A.spliceSpeech(base, anchor, t);
        value = r.value;
        if (final) { base = r.value; anchor = r.cursor; }
      };
      speak("안", false); speak("안녕하세요", true);      // 첫 문장(부분 → 최종)
      speak("반갑", false); speak("반갑습니다", true);     // 이어서 둘째 문장
      eq("이어 말하기가 앞 문장을 지우지 않는다", value, "안녕하세요 반갑습니다");
      ok("컴포저가 final 에서 앵커를 커밋한다(소스 핀)",
        /if \(final\) \{ baseRef\.current = value; anchorRef\.current = cursor; \}/.test(
          readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatComposer.tsx"), "utf8")));
    }
    // ★ 채팅 STT 는 **보조키 패널과 같은 엔진**이어야 한다(사용자 실측: 패널은 빠르고 정확한데 채팅은
    //  아니었다 — 서드파티 라이브러리를 따로 붙였던 것이 원인). services/stt provider 를 쓰고
    //  코딩 용어 바이어스(CODING_TERMS)까지 같은 것을 넘긴다. 그리고 원문 오류 메시지를 노출하지 않는다.
    {
      const ccRaw = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatComposer.tsx"), "utf8");
      // ⚠ 주석을 먼저 걷어낸다 — "서드파티를 쓰지 않는다" 핀이 그 사실을 **설명하는 주석**에 걸려
      //  거짓 실패를 냈다(이 세션에서 세 번째로 같은 함정). 소스 핀은 항상 코드만 본다.
      const cc = ccRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      ok("채팅 STT 가 services/stt provider 를 쓴다", /getCurrentSttProvider\(\)/.test(cc) && /from '\.\.\/\.\.\/services\/stt'/.test(cc));
      ok("패널과 같은 코딩 용어 바이어스를 넘긴다", /contextualStrings: CODING_TERMS/.test(cc));
      ok("서드파티 STT 라이브러리를 쓰지 않는다", !/react-native-voice/.test(cc)
        && !existsSync(path.resolve(here, "../../../codingpt_app/src/services/speechInput.ts")));
      ok("회복 가능한 종료에 원문 메시지를 띄우지 않는다", !/e\?\.error\?\.message/.test(cc));
      // `+` 는 4갈래(프로젝트/기기/촬영/갤러리) — 출처가 실제로 넷이라 한 화면으로 합칠 수 없다.
      // `[^>]*` 는 안 된다: icon 속성에 `/>` 가 들어 있어 첫 `>` 에서 끊긴다(실측 0건) → 지연 매칭.
      const labels = [...cc.matchAll(/<MenuRow[\s\S]*?label="([^"]+)"/g)].map((m) => m[1]);
      eq("`+` 메뉴 = 프로젝트/기기/촬영/갤러리", labels, ["프로젝트에서 선택", "기기에서 선택", "촬영", "갤러리"]);
      ok("프로젝트 선택은 컬럼뷰 시트(워크스페이스 생성과 같은 형식)",
        /<ProjectFileSheet/.test(cc)
        && /COL_W/.test(readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ProjectFileSheet.tsx"), "utf8")));
    }
  }
}


// ── 컴포저 = 로컬 contenteditable + 원자 칩(2026-07-30 사용자 확정 3차) ──────────────
//  "입력은 네이티브처럼"(선택·⌘Z·Shift+방향키·IME = 브라우저 기본) — 라이브 미러의 키 포워딩은
//  이를 원리적으로 못 살려 폐기했다. TUI 반영은 전송 시 한 번(데몬 조각 paste).
{
  // 전송 시 낙관 버블 본문 = 첨부 인용 경로를 걷어낸 텍스트(stripTokenOnce 재사용 — 실행 검증)
  eq("첨부 경로 제거(+공백 1)", M.stripTokenOnce("'/a/b c.png' 이거 봐줘", "'/a/b c.png'"), "이거 봐줘");
  eq("본문 중간 경로 제거", M.stripTokenOnce("이거 '/a/x.png' 봐줘", "'/a/x.png'"), "이거 봐줘");
  eq("없으면 무변화", M.stripTokenOnce("안녕", "'/a/x.png'"), "안녕");

  const cv = readFileSync(path.resolve(here, "../src/js/chat-view.js"), "utf8");
  ok("컴포저는 contenteditable(네이티브 편집)", /class="chat-input chat-ce" contenteditable="true"/.test(cv));
  ok("입력 이벤트를 PTY 로 포워딩하지 않는다(네이티브 보장)", !/tuiWrite/.test(cv) && !/inputDelta/.test(cv));
  ok("칩은 contenteditable=false = 커서/백스페이스 원자 단위", /chip\.contentEditable = "false"/.test(cv));
  ok("칩 삭제/undo 를 DOM 기준으로 리컨실", /_reconcileChips/.test(cv) && /querySelectorAll\(".chat-chip"\)/.test(cv));
  ok("직렬화 = 칩→인용 경로(+공백)", /shq\(c\.dataset\.path \|\| ""\) \+ " "/.test(cv));
  ok("삽입은 execCommand insertText(네이티브 undo 스택 유지)", /execCommand\("insertText"/.test(cv));
  ok("붙여넣기는 plain text 강제(HTML 오염 방지)", /getData\("text\/plain"\)/.test(cv));
  ok("전송은 chat.input(데몬)이 정본 + 로컬 paste 폴백", /api\.chatInput\(/.test(cv) && /sendFallback\?\.\(raw\)/.test(cv));
  ok("이미지 경로 전송은 any 매칭(트랜스크립트 [Image #N] 변환으로 원문 예측 불가)",
    /mayConvert/.test(cv) && /any: mayConvert/.test(cv));
  ok("칩 클릭 = 미리보기(라이트박스/시스템 열기)", /_openPreview/.test(cv) && /chat-lightbox/.test(cv) && /openPath/.test(cv));
  const css = readFileSync(path.resolve(here, "../src/styles.css"), "utf8");
  ok("빈 입력 placeholder 는 :empty::before", /\.chat-ce:empty::before \{ content: attr\(data-ph\)/.test(css));

  // 실사용 신고 3종(2026-07-30 2차) 재발 방지 핀
  ok("방향키 PUA(U+F700대) 문자 삽입 차단 — beforeinput + 소독", /beforeinput/.test(cv) && /\\uF700-\\uF7FF/.test(cv) && /_ceSanitize/.test(cv));
  ok("Backspace/Delete 가 인접 칩을 원자 삭제(WebKit ncE 버그 우회)", /_chipAtCaret\(/.test(cv) && /e\.key === "Backspace" \|\| e\.key === "Delete"/.test(cv));
  ok("보낸 메시지도 인라인 칩(마커/경로 자리) + 자동 썸네일", /_userTextHtml/.test(cv) && /_hydrateMsgChips/.test(cv) && /\[Image #\(/.test(cv.replace(/\\/g, "")));
  ok("레거시 첨부 표현(넓은 인라인 확장) 제거", !/chat-attach-img/.test(cv) && !/_loadAttachment/.test(cv));
  const ts = readFileSync(path.resolve(here, "../../codingpt_daemon/packages/runner-core/transcript.js"), "utf8");
  // ⚠ 실측 정정(2026-07-30 3차): claude 가 원문 텍스트에 [Image #N](세션 전역 번호)을 이미 남긴다 —
  //  데몬이 마커를 합성하면 유령 토큰이 이중으로 생긴다(사용자 실사고: 끝에 "Image #1" 칩 + 원문은 텍스트).
  ok("데몬은 이미지 마커를 합성하지 않는다(원문 토큰이 정본)", !/\[Image #\$\{/.test(ts) && /buf\.join\(''\)/.test(ts));
  ok("클라 매핑 = k번째 토큰 ↔ attachments[k](번호는 라벨로만)", /k번째 \[Image #N\] 토큰/.test(cv) && /label: mt\[0\]\.slice\(1, -1\)/.test(cv));

  // 데몬 — 조각 paste(격리 실측: 이미지 경로는 "그 자체"가 paste 될 때만 [Image #N] 변환.
  //  문장 중간에 섞이면 무변환 → 경로 조각을 따로 paste 하면 제자리 변환된다)
  const ds = readFileSync(path.resolve(here, "../../codingpt_daemon/packages/runner-core/cpt-server.js"), "utf8");
  ok("데몬 chatInput 이 이미지 경로 조각을 분리 paste 한다", /splitImagePathSegments/.test(ds) && /IMG_PATH_SEG_RE/.test(ds));
  ok("조각 전송 시 Enter 를 넉넉히 지연(변환은 비동기 파일 읽기)", /segs\.length > 1 \? 900 : 120/.test(ds));

  // 데몬 조각 분리 규칙 — 소스에서 오려내 실행(이미지만 분리·텍스트 파일은 인라인 유지)
  {
    const m = ds.match(/const IMG_PATH_SEG_RE[\s\S]*?\n\}/);
    ok("splitImagePathSegments 를 오려낼 수 있다", !!m);
    if (m) {
      // eslint-disable-next-line no-eval
      const fn = eval(`(() => { ${m[0]}; return splitImagePathSegments; })()`);
      eq("이미지 경로만 독립 조각", fn("A '/a/i.png' B '/b/t.txt' C"), ["A ", "'/a/i.png' ", "B '/b/t.txt' C"]);
      eq("경로 없으면 통짜", fn("그냥 텍스트"), ["그냥 텍스트"]);
      eq("경로 하나면 그 조각뿐", fn("'/x/y.jpeg' "), ["'/x/y.jpeg' "]);
    }
  }

  // 앱 — 첨부 원자 토큰(칩 컴포저): 스냅/커서/전송 변환 규칙을 오려내 실행 검증
  {
    const ac = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/composer.ts"), "utf8");
    const cut = (name) => {
      const mm = ac.match(new RegExp(`export function ${name}[\\s\\S]*?\\n\\}`));
      ok(`앱 ${name} 오려내기`, !!mm);
      if (!mm) return null;
      // eslint-disable-next-line no-eval
      return eval(`(() => { ${mm[0].replace("export function", "function").replace(/: \{ text: string; removed: string\[\] \}|: string\[\]|: number|: string|: AttachEntry\[\]/g, "")}; return ${name}; })()`);
    };
    const snap = cut("snapAttachTokens");
    if (snap) {
      eq("온전한 토큰은 유지", snap("a [사진 1] b", ["[사진 1]"]), { text: "a [사진 1] b", removed: [] });
      eq("토큰이 깨지면 잔해째 걷는다(끝 깎임)", snap("a [사진 1 b", ["[사진 1]"]), { text: "a  b", removed: ["[사진 1]"] });
      eq("앞이 깎여도 걷는다", snap("a 사진 1] b", ["[사진 1]"]), { text: "a  b", removed: ["[사진 1]"] });
      eq("전부 지워졌으면 removed 만", snap("a  b", ["[사진 1]"]), { text: "a  b", removed: ["[사진 1]"] });
    }
    const caret = cut("snapCaretOutOfToken");
    if (caret) {
      eq("토큰 내부 커서 → 끝으로", caret("a [사진 1] b", 5, ["[사진 1]"]), 8);
      eq("토큰 밖 커서는 그대로", caret("a [사진 1] b", 1, ["[사진 1]"]), 1);
    }
    ok("전송 변환 = 토큰→인용 경로 + 고아 토큰 제거", /resolveAttachTokens/.test(ac) && /\[(\?:)?사진\|파일/.test(ac.replace(/\\/g, "")) || /\(\?:사진\|파일\)/.test(ac));
    const cc2 = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatComposer.tsx"), "utf8");
    ok("앱 컴포저가 스냅+커서 스냅을 배선", /snapAttachTokens/.test(cc2) && /snapCaretOutOfToken/.test(cc2));
    const cr = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatRow.tsx"), "utf8");
    ok("앱 보낸 메시지 인라인 칩+자동 썸네일+미리보기", /UserRichText/.test(cr) && /MsgChip/.test(cr) && /onPreview/.test(cr));
  }

  // 앱 — 미러 입력은 철회(로컬 KeyTextInput 유지)하되 any 낙관 매칭은 공유
  const appCb = path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatBody.tsx");
  if (existsSync(appCb)) {
    const cb = readFileSync(appCb, "utf8");
    ok("앱 채팅에 미러 입력이 없다(네이티브 입력 유지)", !/MirrorInput/.test(readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chat/ChatComposer.tsx"), "utf8")));
    ok("앱도 이미지 경로 전송은 any 매칭", /addPending\(text, /.test(cb));
    const cm = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/chatModel.ts"), "utf8");
    ok("앱 pruneOptimistic 이 any 를 지원", /p\.any \|\| keys\.has/.test(cm));
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
