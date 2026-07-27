// agent-toggle.mjs — TUI↔Chat 토글 **노출 판정**의 3구현체 동치 검증(PC ↔ 앱 ↔ 데몬).
//
// 왜 이 파일이 따로 있는가
//  · 사용자 신고: "터미널에 claude 가 도는데 토글이 있을 때도 있고 없을 때도 있다(pc·android·ios 전부)".
//    진단(docs/구현설계-2026-07-25/13-토글-노출-진단.md) 결론 = 판정이 데몬 push(agent_state) 하나에
//    100% 매달렸고, 계약이 2순위로 정해 둔 `tab.cmd` 폴백은 **최신 Claude Code 에서 구조적 사문**이다
//    (pane_current_command = `2.1.219` 같은 버전 문자열 → `/^(claude|codex|gemini)$/` 는 절대 미매치).
//    그래서 push 가 비는 모든 순간(15분 스테일·채널 재접속 폐기·호스트 오프라인·데몬 재기동·
//    `agentstate.v1` 미선언)이 곧 토글 소멸이었다.
//  · 이 결함의 **재발 형태는 "규칙이 두 벌"**이다: 데몬은 2026-07-25 에 "셸이 아니고 제목이 에이전트
//    글리프를 주면 에이전트" 로 고쳤는데 클라 2벌(앱·PC)은 이름 패턴에 남아 조용히 죽었다. 각 구현의
//    단위 테스트로는 절대 볼 수 없다(양쪽 다 자기 규칙으로 초록) → **여기서 앱 소스를 읽어 같은 함수를
//    실행하고 전 조합을 대조한다**(선례: e2ee-crossimpl.mjs §4 의 앱 본문 오려내기).
//  · 데몬은 모듈을 그대로 require 한다(기동하지 않는다 — 이 Mac 에서 데몬 추가 기동 금지).
//
// 앱 파일은 TS 라 그대로 import 할 수 없다 → 앱 리포의 typescript 로 **타입만 벗겨** 실행한다.
//  형제 리포/typescript 가 없는 단독 체크아웃에서는 그 절만 SKIP 한다(다른 절은 계속 돈다).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const PC = await import("../src/js/agent-signal.js");

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const eq = (name, got, want) => ok(`${name}`, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const J = (v) => JSON.stringify(v);

// ── 대조용 입력 도메인(실측 값 위주) ───────────────────────────────────────────
const CMDS = [
  "zsh", "-zsh", "bash", "-bash", "sh", "fish", "login", "tcsh",   // 셸(항상-숨김의 유일한 근거)
  "claude", "codex", "gemini",                                      // 구 CLI 이름
  "2.1.219", "2025.09.18-7ae6800",                                  // 최신 claude / cursor-agent [실측]
  "node", "vim", "npm", "python", "ssh", "", " zsh ", " claude ",
];
const TITLES = [
  "",
  "codingpt-demo",                                                  // 셸 대기(폴더명)
  "whrksp126@GH-MACui-MacBookPro:~/codingpt-demo",                  // 셸 제목 [실측]
  "✳ 히어로 아래에 고객 후기 섹션 추가",                              // claude idle [실측]
  "⠹ 작업 중",                                                       // 점자 스피너(working)
  "claude · resume",                                                // 글리프 없는 claude 화면 [실측]
  "claude agents",
  "✋ 승인 필요", "✦ 생각 중", "⏲ 대기", "◇ 유휴",                    // gemini 글리프
];
const AGENTS = [undefined, null, "", "claude", "unknown", "none", "null", "false", true, false, "  gemini  "];
const STATES = [undefined, null, "", "idle", "working", "permission", "needsInput", "gone"];
const PUSHES = [null, { state: "working" }, { state: "idle" }, { state: "needsInput" }, { state: "gone" }];
const MODES = [undefined, "tui", "chat"];

// ══════════════════════════════════════════════════════════════════════════
// 1. 경계 고정 — "항상 보여야 한다" vs "빈 셸에 굳으면 안 된다"(진단서 §6)
//    from 까지 단언한다: 어느 칸에서 결정됐는지가 곧 계약이다.
// ══════════════════════════════════════════════════════════════════════════
const P = (push, tab) => PC.resolveAgentPresence({ push, tab });
eq("빈 셸 탭(cmd=zsh) = 유일한 항상-숨김", P(null, { cmd: "zsh", title: "codingpt-demo" }), { on: false, from: "shell" });
eq("셸인데 제목 글리프가 스테일하게 남음 → 여전히 숨김(구 사고 경로)",
  P(null, { cmd: "zsh", title: "⠹ 작업 중" }), { on: false, from: "shell" });
eq("최신 claude(cmd=버전 문자열 + 제목 글리프) → 켜짐(제목 칸)",
  P(null, { cmd: "2.1.219", title: "✳ 히어로 아래에 고객 후기 섹션 추가" }), { on: true, from: "title" });
eq("최신 claude 인데 제목이 글리프 없는 화면(/resume) → 그래도 켜짐(④ 애매하면 켠다)",
  P(null, { cmd: "2.1.219", title: "claude · resume" }), { on: true, from: "ambiguous" });
eq("목록이 아직 안 옴(cmd·title 미상) → 켜짐(토글이 사라지는 것보다 낫다)",
  P(null, { cmd: "", title: "" }), { on: true, from: "ambiguous" });
eq("탭 신호 자체가 없음(null) → 켜짐", P(null, null), { on: true, from: "ambiguous" });
eq("push 가 정본 — 셸로 보이는 1틱에도 토글이 안 깜빡인다",
  P({ state: "working" }, { cmd: "zsh", title: "codingpt-demo" }), { on: true, from: "push" });
eq("push 'gone' = 종료 통보 → 꺼짐", P({ state: "gone" }, { cmd: "2.1.219" }), { on: false, from: "push" });
eq("데몬 정규화 신호 긍정 → 켜짐(제목·이름 없어도)",
  P(null, { cmd: "2.1.219", agent: "claude" }), { on: true, from: "daemon" });
// ★ 데몬의 부정은 OFF 가 아니다: agentSignalOf 는 "셸 확정"과 "글리프를 못 봤다(=모름)" 를 같은 false 로
//  접어 보내고, 후자에는 claude 가 도는 순간이 다수 들어간다(/resume·agents·신뢰 확인·제목 비활성·
//  noPrefix·cursor-agent). 셸이라는 진짜 부정은 위 shell 칸이 이미 잡으므로 잃는 OFF 가 없다(§6 참조).
eq("데몬 정규화 신호 명시적 부정 → 그래도 켜짐(false 는 '모름'과 구분 불가 — 셸만이 OFF)",
  P(null, { cmd: "vim", agent: false }), { on: true, from: "ambiguous" });
eq("데몬이 부정해도 셸이면 셸 칸에서 꺼진다(진짜 부정은 여기서 잡힌다)",
  P(null, { cmd: "zsh", agent: false }), { on: false, from: "shell" });
eq("구 데몬(agent 필드 없음)은 '모름' — 부정으로 접으면 토글 영구 소멸",
  P(null, { cmd: "vim" }), { on: true, from: "ambiguous" });
eq("구 CLI 이름 패턴은 유지(gemini·구 claude — 계약 §1.5 폴백 삭제 금지)",
  P(null, { cmd: "gemini", title: "codingpt-demo" }), { on: true, from: "cmd" });
eq("node 는 이미 chat 모드였던 탭에서만 인정(기존 규칙)",
  [P(null, { cmd: "node" }).from, P(null, { cmd: "node", mode: "chat" }).from], ["ambiguous", "cmd"]);
eq("혼합 탭(IDE/프리뷰) 활성 → 숨김", PC.resolveToggleVisible({ isTerm: false, win: 5, chatMode: true, agentOn: true }), false);
eq("win 미확정('new') → 숨김(chat 모드여도)", PC.resolveToggleVisible({ isTerm: true, win: "new", chatMode: true, agentOn: true }), false);
eq("chat 모드는 에이전트가 사라져도 유지", PC.resolveToggleVisible({ isTerm: true, win: 5, chatMode: true, agentOn: false }), true);

// ══════════════════════════════════════════════════════════════════════════
// 2. 데몬 규칙 동치 — `runner-core/agent-watch.js` 의 실제 함수와 대조
//    (판정 정본이 두 벌이 된 것이 이번 결함의 근원 → 하드코딩이 아니라 실물 모듈을 부른다)
// ══════════════════════════════════════════════════════════════════════════
{
  const WATCH = path.resolve(here, "../../codingpt_daemon/packages/runner-core/agent-watch.js");
  if (!existsSync(WATCH)) {
    console.log("SKIP 데몬 규칙 동치(형제 리포 없음 — 단독 체크아웃)");
  } else {
    const W = createRequire(WATCH)(WATCH);
    let n = 0, mism = 0; const bad = [];
    for (const t of TITLES) {
      n += 1;
      const a = W.titleStatus(t), b = PC.agentTitleStatus(t);
      if (a !== b) { mism += 1; if (bad.length < 3) bad.push(`${J(t)} daemon=${J(a)} pc=${J(b)}`); }
    }
    ok(`제목 글리프 판정 PC=데몬 ${n - mism}/${n}`, mism === 0, bad.join(" | "));

    // 데몬 isAgentPane = (셸 아님) ∧ (이름 확정 ∨ 제목 신호). 클라의 ④ '애매하면 켠다' 는 **표시 전용**
    //  이라 데몬엔 없다(오알림은 사용자를 깨우므로 비용의 비대칭이 반대 — 진단서 §7 부연).
    //  그래서 대조 대상은 "데몬도 갖고 있는 근거 칸"으로 한정한다.
    const pcEvidence = (cmd, title) =>
      !PC.isShellCmd(cmd) && (PC.hasAgentCmd({ cmd }) || PC.agentTitleStatus(title) != null);
    let n2 = 0, mism2 = 0; const bad2 = [];
    for (const cmd of CMDS) {
      for (const title of TITLES) {
        n2 += 1;
        // 데몬은 이미 trim 된 cmd 를 받는다(agent-watch.observe) → 같은 값을 준다.
        const a = W.isAgentPane(cmd.trim(), W.titleStatus(title), false);
        const b = pcEvidence(cmd, title);
        if (a !== b) { mism2 += 1; if (bad2.length < 3) bad2.push(`(${J(cmd)},${J(title)}) daemon=${a} pc=${b}`); }
      }
    }
    ok(`에이전트 근거 판정(셸 가드+이름+제목) PC=데몬 ${n2 - mism2}/${n2} 조합`, mism2 === 0, bad2.join(" | "));
    ok("셸 목록이 데몬과 같다(스테일 제목이 남은 셸 탭에 토글이 뜨는 것을 막는 유일한 가드)",
      [...PC.SHELL_CMDS].every((c) => W.isAgentPane(c, "working", true) === false));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. 앱 ↔ PC 동치 — **앱 소스를 실행해** 전 조합 대조(같은 입력에 두 화면이 다른 그림 = 반복 사고)
// ══════════════════════════════════════════════════════════════════════════
{
  const APP = path.resolve(here, "../../../codingpt_app/src/workspace/agentPresence.ts");
  const APPPKG = path.resolve(here, "../../../codingpt_app/package.json");
  let A = null, why = "";
  if (!existsSync(APP) || !existsSync(APPPKG)) {
    why = "codingpt_app 없음 — 단독 체크아웃";
  } else {
    try {
      const ts = createRequire(APPPKG)("typescript");
      const src = readFileSync(APP, "utf8");
      // 타입만 벗긴다(문법 변환 없음) → 남는 것은 순수 ESM. `import type` 은 transpile 이 소거한다.
      const js = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      A = await import(`data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`);
    } catch (e) { why = `앱 모듈을 실행할 수 없다(형식/의존성 변경?): ${e.message}`; }
  }
  if (!A) {
    console.log(`SKIP 앱↔PC 토글 판정 동치(${why})`);
  } else {
    ok("앱 agentPresence.ts 를 타입만 벗겨 실행할 수 있다", typeof A.resolveAgentPresence === "function");
    ok("앱이 사다리 코어를 전부 export 한다(한쪽만 이름을 바꾸면 여기서 터진다)",
      ["SHELL_CMDS", "isShellCmd", "agentTitleStatus", "normalizeDaemonAgentFlag", "hasAgentCmd",
        "resolveAgentPresence", "resolveToggleVisible"].every((k) => k in A));
    eq("셸 목록 문자열 동일", [...A.SHELL_CMDS].sort(), [...PC.SHELL_CMDS].sort());

    const cmp = (label, fn, cases) => {
      let n = 0, mism = 0; const bad = [];
      for (const c of cases) {
        n += 1;
        const a = fn(A, c), b = fn(PC, c);
        if (J(a) !== J(b)) { mism += 1; if (bad.length < 3) bad.push(`${J(c)} app=${J(a)} pc=${J(b)}`); }
      }
      ok(`앱==PC ${label} ${n - mism}/${n} 조합`, mism === 0, bad.join(" | "));
    };
    cmp("isShellCmd", (M, c) => M.isShellCmd(c), [...CMDS, null, undefined]);
    cmp("agentTitleStatus", (M, c) => M.agentTitleStatus(c), [...TITLES, null, undefined]);
    cmp("normalizeDaemonAgentFlag", (M, c) => M.normalizeDaemonAgentFlag(c),
      [null, undefined, ...AGENTS.flatMap((agent) => STATES.map((agentState) => ({ agent, agentState })))]);
    cmp("hasAgentCmd", (M, c) => M.hasAgentCmd(c),
      [null, ...CMDS.flatMap((cmd) => MODES.map((mode) => ({ cmd, mode })))]);

    // 사다리 전 조합 — push × cmd × title × agent × agentState × mode. on 뿐 아니라 from(근거)까지 대조.
    {
      const agents = [undefined, null, "claude", true, false];
      const states = [undefined, "working", "gone", ""];
      let n = 0, mism = 0; const bad = []; const froms = new Set();
      for (const push of PUSHES) {
        for (const cmd of CMDS) {
          for (const title of TITLES) {
            for (const agent of agents) {
              for (const agentState of states) {
                for (const mode of MODES) {
                  n += 1;
                  const tab = { cmd, title, agent, agentState, mode };
                  const a = A.resolveAgentPresence({ push, tab });
                  const b = PC.resolveAgentPresence({ push, tab });
                  froms.add(b.from);
                  if (J(a) !== J(b)) {
                    mism += 1;
                    if (bad.length < 3) bad.push(`${J({ push, tab })} app=${J(a)} pc=${J(b)}`);
                  }
                }
              }
            }
          }
        }
      }
      ok(`앱==PC 사다리 판정 ${n - mism}/${n} 조합 일치(on + 근거 칸)`, mism === 0, bad.join(" | "));
      eq("근거 칸 도메인 = 6가지(push/shell/daemon/cmd/title/ambiguous)",
        [...froms].sort(), ["ambiguous", "cmd", "daemon", "push", "shell", "title"].filter((f) => froms.has(f)));
      ok("'daemon-none' 칸은 부활하지 않았다(데몬의 false = 모름 — §6 이 근거)", !froms.has("daemon-none"));
      // OFF 를 만드는 칸은 push(종료 통보)와 shell(셸 확정) **둘뿐**이어야 한다 — 나머지 칸에서 OFF 가
      //  나오면 그게 곧 "claude 가 도는데 토글이 사라진다" 의 새 경로다.
      {
        const offFroms = new Set();
        for (const push of PUSHES) for (const cmd of CMDS) for (const title of TITLES)
          for (const agent of agents) for (const agentState of states) {
            const r = PC.resolveAgentPresence({ push, tab: { cmd, title, agent, agentState } });
            if (!r.on) offFroms.add(r.from);
          }
        eq("OFF 를 만드는 근거 칸 = push·shell 뿐(깜빡임 불가 조건)", [...offFroms].sort(), ["push", "shell"]);
      }
    }
    {
      let n = 0, mism = 0; const bad = [];
      for (const isTerm of [true, false]) {
        for (const win of [0, 5, 1000123, "new", null, undefined]) {
          for (const chatMode of [true, false]) {
            for (const agentOn of [true, false]) {
              n += 1;
              const c = { isTerm, win, chatMode, agentOn };
              const a = A.resolveToggleVisible(c), b = PC.resolveToggleVisible(c);
              if (a !== b) { mism += 1; if (bad.length < 3) bad.push(`${J(c)} app=${a} pc=${b}`); }
            }
          }
        }
      }
      ok(`앱==PC 토글 노출(혼합 탭·win 미확정·chat 유지) ${n - mism}/${n} 조합`, mism === 0, bad.join(" | "));
    }
  }
}


{
  // ── 토글 배치·클릭 생존 계약(사용자 확정 2026-07-27) ────────────────────────
  //  ★ 위치 계약이 바뀌었다: pane 본문 절대배치 → **메인 영역 헤더(main-top) 우측 끝, 전역 1개**.
  //    (구 계약은 `.pane-body` 기준이라고 적혀 있었지만 `.pane-body` 에 position 이 없어 실제로는
  //     `.pane` 기준이었고 30px 짜리 `.pane-head` 를 덮었다 — 사용자 신고 후 라이브 실증.)
  //  ★ 그리고 이 블록의 진짜 목적은 디자인 토큰이 아니라 **"클릭이 살아 있는가"의 구조적 핀**이다.
  //    구버전은 매 emit 마다 버튼의 innerHTML 을 다시 써서 자식 SVG 를 교체했고, pane 내부
  //    mousedown(capture)이 focusPane→emit 을 무조건 발화하므로 mousedown 타깃이 mouseup 전에
  //    소멸 → WebKit 이 click 을 아예 디스패치하지 않았다(중앙 클릭 3회 무반응 / 모서리 1회 성공으로
  //    실증). 아래 세 핀이 그 세 조건(노드 보존·글리프 조건부 재작성·불필요 emit 억제)을 고정한다.
  const MT = path.resolve(here, "../../../codingpt_app/src/workspace/chat/ModeToggle.tsx");
  const css = readFileSync(path.resolve(here, "../src/styles.css"), "utf8");
  const wvJs = readFileSync(path.resolve(here, "../src/js/workspace-view.js"), "utf8");
  const stateJs = readFileSync(path.resolve(here, "../src/js/state.js"), "utf8");
  const paneJs2 = readFileSync(path.resolve(here, "../src/js/pane.js"), "utf8");
  const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

  // (1) 배치 — main-top 에 붙고, pane 본문 절대배치 흔적이 남아 있지 않다.
  ok("PC 토글은 main-top 에 붙는다(pane 본문 절대배치 폐기)",
    /mainTop\.append\(mtDyn, buildModeToggle\(\)\)/.test(wvJs) && !/\.pane-mode-toggle/.test(css));
  ok("PC 토글 숨김은 remove 가 아니라 클래스로만(노드 보존)",
    /\.mt-mode\.hidden\s*\{[^}]*display:\s*none/.test(css)
    && /classList\.toggle\("hidden"/.test(wvJs));
  ok("main-top 재렌더는 mtDyn 만 비운다(토글 노드 소멸 금지)",
    /mtDyn\.innerHTML = ""/.test(wvJs) && !/mainTop\.innerHTML = ""/.test(wvJs));

  // (2) 글리프 조건부 재작성 — 이 가드가 사라지면 클릭이 다시 죽는다.
  const syncAt = wvJs.indexOf("export function syncModeToggle()");
  const syncBody = syncAt < 0 ? "" : wvJs.slice(syncAt, wvJs.indexOf("\n}", syncAt));
  ok("글리프는 바뀔 때만 innerHTML 재작성(mousedown 타깃 소멸 방지)",
    syncAt > 0 && /if \(mtModeGlyph !== want\)/.test(syncBody)
    && (syncBody.match(/innerHTML/g) || []).length === 1, syncBody.replace(/\s+/g, " ").slice(0, 240));
  ok("syncModeToggle 은 토글 노드를 remove 하지 않는다", syncAt > 0 && !/\.remove\(\)/.test(syncBody));

  // (3) 불필요 emit 억제 — pane 클릭마다 전체 재렌더가 돌면 위 가드의 여유가 사라진다.
  const fpAt = stateJs.indexOf("export function focusPane(");
  const fpBody = fpAt < 0 ? "" : stateJs.slice(fpAt, stateJs.indexOf("\n}", fpAt));
  ok("focusPane 은 포커스 무변화면 emit 하지 않는다",
    fpAt > 0 && /if \(w\.focusId === paneId\) return;/.test(fpBody), fpBody.replace(/\s+/g, " ").trim());

  // (4) 판정과 그리기의 분리 — pane 은 DOM 을 만들지 않는다(전역 1개라는 사실을 코드로 고정).
  ok("pane.js 는 토글 DOM 을 만들지 않는다(판정만 = modeToggleState)",
    /modeToggleState\(\)\s*\{/.test(paneJs2) && !/_modeBtn/.test(paneJs2));

  // (5) 3플랫폼 동일 디자인 — 글리프 크기만 대조(오프셋은 헤더 배치가 되어 의미가 없어졌다).
  if (!existsSync(MT)) console.log("SKIP 토글 글리프 크기 대조(앱 ModeToggle 없음)");
  else {
    const mt = readFileSync(MT, "utf8");
    // ★ 글리프 픽셀을 앱=PC 로 못 박지 않는다: 두 헤더의 다른 버튼 크기가 애초에 다르다
    //  (PC 추가 버튼 16 / 앱 19). 억지로 같은 숫자로 맞추면 각자 헤더 줄에서 어긋난다.
    //  진짜 불변식은 **"토글 글리프 = 그 플랫폼 헤더 추가 버튼과 같은 크기"** 다(줄 정렬).
    const glyphLine = /mtModeBtn\.innerHTML[^\n]*/.exec(wvJs)?.[0] || "";
    const addsGlyph = num(/mkBtn\(icons\.terminal[\s\S]*?size: (\d+)/, wvJs)
      ?? num(/b\.innerHTML = icon\(\{ size: (\d+) \}\)/, wvJs);
    eq("PC 토글 글리프 = PC 헤더 추가 버튼과 같은 크기", num(/size: (\d+)/, glyphLine), addsGlyph);
    ok("토글 두 글리프가 같은 크기(터미널/채팅)", (glyphLine.match(/size: (\d+)/g) || []).length === 2
      && new Set(glyphLine.match(/size: \d+/g)).size === 1, glyphLine.trim());
    ok("chat 활성 색은 양쪽 다 accent 토큰", /\.pane-ctrl\.active\s*\{[^}]*var\(--accent\)/.test(css)
      && /C\.accent/.test(mt));
    // 앱도 pane 오버레이가 아니라 헤더에 있어야 한다(같은 라운드에 함께 옮겼다).
    const pv = path.resolve(here, "../../../codingpt_app/src/workspace/PaneView.tsx");
    const wv = path.resolve(here, "../../../codingpt_app/src/workspace/WorkspaceView.tsx");
    if (existsSync(pv) && existsSync(wv)) {
      ok("앱 토글도 pane 이 아니라 워크스페이스 헤더에서 렌더된다",
        !/<ModeToggle/.test(readFileSync(pv, "utf8")) && /<ModeToggle/.test(readFileSync(wv, "utf8")));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 되돌리면 안 되는 배선(PC 전용 회귀 핀)
//    · `_chatActive()` 에 `_agentOn` 을 AND 로 걸면 claude 종료 후 화면은 Chat 인데 억제 가드만 풀려
//      display:none 인 xterm 의 스테일 cols/rows 로 ptyResize + 크기 주장이 되살아난다(12R·17R 계열 사고).
//    · 토글 노출은 반드시 공용 함수를 거친다(앱과 갈리는 지점을 한 곳으로 묶는다).
// ══════════════════════════════════════════════════════════════════════════
{
  const src = readFileSync(path.resolve(here, "../src/js/pane.js"), "utf8");
  const at = src.indexOf("_chatActive()");
  const body = at < 0 ? "" : src.slice(at, src.indexOf("\n  }", at));
  ok("_chatActive() 는 _agentOn 을 보지 않는다(스테일 ptyResize·크기 주장 부활 방지)",
    at > 0 && !body.includes("_agentOn"), body.replace(/\s+/g, " ").trim());
  ok("토글 노출은 resolveToggleVisible 을 거친다", /resolveToggleVisible\(\{/.test(src));
  ok("에이전트 판정은 resolveAgentPresence 를 거친다(인라인 규칙 부활 금지)",
    /resolveAgentPresence\(\{/.test(src) && !/AGENT_CMD_RE\.test/.test(src));
  // 판정 입력은 앱과 **같은 재료**여야 한다(플랫폼별 추가 재료 = 대조 불가능한 비대칭).
  //  pane_title 원본(ptitle)은 사다리에서 도달 불가였다 — window_name 은 자동 개명이든 수동 rename 이든
  //  항상 비지 않으므로 `tab.title || tab.ptitle` 의 우변이 평가되지 않는다(§6 이 실행으로 확인한다).
  ok("판정 입력에 ptitle 폴백이 없다(도달 불가 코드 부활 금지)",
    /title:\s*tab\.title\s*,/.test(src) && !/tab\.ptitle/.test(src));
  const rust = readFileSync(path.resolve(here, "../src-tauri/src/tmux.rs"), "utf8");
  // AUTO_RENAME_FMT 안의 pane_title 은 자동 개명 포맷(데몬과 3벌 동기)이라 그대로 있어야 한다 —
  //  여기서 금지하는 것은 **목록 행에 별 필드로 싣는 것**이다.
  ok("Rust 터미널 목록에 pane_title 필드가 없다(죽은 표면 부활 금지)",
    !/pane_current_command\}\\t#\{pane_title/.test(rust) && !/pub title: String/.test(rust));
  ok("자동 개명 포맷(AUTO_RENAME_FMT)의 pane_title 은 그대로 유지(탭 이름이 글리프를 나르는 경로)",
    /AUTO_RENAME_FMT[\s\S]{0,600}#\{pane_title\}/.test(rust));
  const stateJs = readFileSync(path.resolve(here, "../src/js/state.js"), "utf8");
  // 주석의 언급(왜 뺐는지)은 남기고, **탭에 쓰는 코드**가 없는 것만 본다.
  ok("리컨실러·영속화가 ptitle 을 탭에 쓰지 않는다",
    !/t\.ptitle/.test(stateJs) && !/ptitle\s*[:,]/.test(stateJs));
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 휘발 신호는 영속되지 않는다 — 지난 세션의 판정이 다음 실행 첫 몇 초를 지배하면
//    "claude 가 도는데 토글이 잠깐 없다" 가 재현된다(이 라운드가 없애려던 증상의 축소판).
//    state.js 는 브라우저 전역을 요구하므로 최소 스텁 후 import 한다(contract.mjs 관례).
// ══════════════════════════════════════════════════════════════════════════
{
  globalThis.window = {
    __TAURI__: { core: { invoke: async () => ({}) }, event: { listen: async () => () => {} } },
    addEventListener() {}, removeEventListener() {},
    location: { href: "http://localhost/" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    FitAddon: { FitAddon: class { activate() {} fit() {} } },
    Terminal: class { open() {} write() {} onData() {} loadAddon() {} dispose() {} },
    WebLinksAddon: { WebLinksAddon: class {} },
    SearchAddon: { SearchAddon: class {} },
  };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.document = {
    hidden: false, addEventListener() {}, removeEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
    body: { classList: { add() {}, remove() {} }, appendChild() {} },
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {} }),
  };
  const S = await import("../src/js/state.js");
  const tree = {
    id: "root", dir: "row",
    first: { id: "a", kind: "terminal", active: 0, tabs: [{ win: 7, title: "✳ 작업", cmd: "2.1.219", agent: false, agentState: "gone", mode: "chat" }] },
    second: { id: "b", kind: "preview", url: "http://x" },
  };
  const out = S.stripVolatile(tree);
  eq("영속본에서 휘발 신호(agent·agentState)가 빠진다", out.first.tabs[0],
    { win: 7, title: "✳ 작업", cmd: "2.1.219", mode: "chat" });
  eq("이름/cmd/mode 는 유지(라벨·모드 복원에 쓴다)",
    [out.first.tabs[0].title, out.first.tabs[0].cmd, out.first.tabs[0].mode], ["✳ 작업", "2.1.219", "chat"]);
  eq("원본 트리는 변형되지 않는다(라이브 상태 보호)", tree.first.tabs[0].agent, false);
  eq("터미널 아닌 leaf 는 그대로", out.second, tree.second);
}

// ══════════════════════════════════════════════════════════════════════════
// 6. **플랫폼별 실제 입력**으로 최종 노출 대조 — 같은 tmux 행 → 앱은 데몬 목록 행, PC 는 Rust 행.
//
//    §3 은 **같은 합성 tab 객체**를 양쪽에 먹이므로 "두 플랫폼이 애초에 다른 재료를 받는다" 는 결함을
//    원리적으로 볼 수 없다(69300/69300 초록인데 실제로는 8/13 이 갈렸다 — 2026-07-25 결함 #2).
//    그래서 여기서는 한 행에서 두 입력을 **생성**한다:
//      · 앱 입력 = 데몬 `agentSignalOf` 를 실제로 호출해 만든 {cmd, title:window_name, agent, agentState}
//      · PC 입력 = Rust `list_terminals` 가 주는 {cmd, title:window_name} (agent 필드 없음 = 영구 '모름')
//    단언은 **최종 노출(on)** 이다 — 근거 칸(from)은 재료가 다르니 달라도 되지만, 사용자가 보는 결과는
//    같아야 한다("PC 는 보이는데 폰은 없다" 가 이 제품에서 반복된 사고 형태).
// ══════════════════════════════════════════════════════════════════════════
{
  const WATCH = path.resolve(here, "../../codingpt_daemon/packages/runner-core/agent-watch.js");
  const APP = path.resolve(here, "../../../codingpt_app/src/workspace/agentPresence.ts");
  const APPPKG = path.resolve(here, "../../../codingpt_app/package.json");
  let A = null, W = null;
  if (existsSync(WATCH) && existsSync(APP) && existsSync(APPPKG)) {
    try {
      W = createRequire(WATCH)(WATCH);
      const ts = createRequire(APPPKG)("typescript");
      const js = ts.transpileModule(readFileSync(APP, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      A = await import(`data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`);
    } catch (_) { A = null; }
  }
  if (!A || !W) {
    console.log("SKIP 플랫폼별 실제 입력 대조(형제 리포/typescript 없음)");
  } else {
    // [실측 근거] 각 행의 cmd/window_name/pane_title 조합 — 진단서 13 §토글이 사라지는 원인 5~9 항.
    const ROWS = [
      ["claude 작업 중(글리프 제목)", "2.1.219", "✳ 히어로 섹션 추가", "✳ 히어로 섹션 추가"],
      ["claude /resume 화면", "2.1.219", "claude · resume", "claude · resume"],
      ["claude agents 화면", "2.1.219", "claude agents", "claude agents"],
      ["claude 폴더 신뢰 확인(제목=셸 제목)", "2.1.219", "whrksp126@GH:~/demo", "whrksp126@GH:~/demo"],
      ["CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1", "2.1.219", "demo", ""],
      ["showStatusInTerminalTab(noPrefix)", "2.1.219", "히어로 섹션 추가", "히어로 섹션 추가"],
      ["수동 rename 한 claude 탭(이름 얼어붙음)", "2.1.219", "내 작업탭", "✳ 히어로 섹션 추가"],
      ["구 claude(이름 매치)", "claude", "claude", "claude"],
      ["gemini working", "gemini", "✦ 생각 중", "✦ 생각 중"],
      ["cursor-agent", "2025.09.18-7ae6800", "demo", "demo"],
      ["vim", "vim", "vim", "vim"],
      ["npm run dev", "npm", "npm", "npm"],
      ["빈 셸(스테일 글리프 제목)", "zsh", "codingpt-demo", "⠹ 스테일 제목"],
    ];
    let mism = 0; const bad = []; let hidden = 0;
    for (const [label, cmd, name, ptitle] of ROWS) {
      const sess = "codingpt-demo--t-1";
      W._states.delete(sess);                                  // 세션 장부 초기화(첫 관찰 상태)
      const sig = W.agentSignalOf(sess, cmd, ptitle);           // 데몬이 목록에 싣는 값(pty.js:144)
      const appOn = A.resolveAgentPresence({ push: null, tab: { cmd, title: name, agent: sig.on, agentState: sig.state } }).on;
      const pcOn = PC.resolveAgentPresence({ push: null, tab: { cmd, title: name } }).on;
      if (appOn !== pcOn) { mism += 1; bad.push(`${label}: app=${appOn} pc=${pcOn}`); }
      if (!appOn) hidden += 1;
    }
    ok(`앱(데몬 행)==PC(Rust 행) 최종 노출 ${ROWS.length - mism}/${ROWS.length} 시나리오`, mism === 0, bad.join(" | "));
    // 셸 행 하나만 숨김이어야 한다 — claude 가 도는 행(/resume·제목 비활성·noPrefix 등)에서 숨으면
    //  그게 사용자 신고 증상이다.
    eq("13 시나리오 중 숨김은 '빈 셸' 하나뿐", hidden, 1);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
