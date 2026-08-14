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

// 소스를 **오려내 실행**하므로 import 가 없다 → `i18n.t` 스텁을 앞에 붙인다(원문 그대로 반환).
const I18N_STUB = "const i18n={t:(s,v)=>String(s).replace(/\\{(\\w+)\\}/g,(w,k)=>(v&&v[k]!=null?String(v[k]):w))};\\n";

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
eq("Codex 재시작 복원(SessionStart 장부 없음) → 실행 프로세스로 Chat 진입 토글 복원",
  PC.resolveToggleVisible({ isTerm: true, win: 5, chatMode: false, agentOn: true, chatReady: PC.resolveChatReady({ tab: { cmd: "codex" } }) }), true);
eq("Codex SessionStart 후 → Chat 진입 토글 표시",
  PC.resolveChatReady({ push: { agent: "codex", sessionId: "s-1" }, tab: { cmd: "codex" } }), true);
eq("Claude 재시작 복원(SessionStart 장부 없음) → 실행 프로세스로 Chat 진입 토글 복원",
  PC.resolveChatReady({ tab: { cmd: "claude" } }), true);
eq("Claude SessionStart 후 → Chat 진입 토글 표시",
  PC.resolveChatReady({ push: { agent: "claude", sessionId: "s-2" }, tab: { cmd: "claude" } }), true);

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
  // ── 토글 배치·클릭 생존 계약(사용자 확정 2026-07-27, 재확정) ────────────────────────
  //  ★ 위치 = **터미널 pane 본문 안 우측 상단**(탭바 아래, 터미널 내용 위). 한때 앱 헤더(main-top)로
  //    옮긴 판본이 있었지만 그건 사용자 요구("메인 영역 기준 우측 상단")를 앱 헤더로 **오독**한 것이다.
  //  ★ 되돌리면서 과거 사고 2건이 함께 부활하지 않도록 아래 핀이 두 조건을 각각 고정한다.
  //    ① 배치: 구버전은 주석만 `.pane-body` 기준이었고 실제로는 `.pane` 기준(= `.pane-body` 에
  //       position 없음)이라 top:6px 이 30px 짜리 `.pane-head` 안으로 들어가 탭바를 덮었다.
  //       → `.pane-body { position: relative }` 가 이 계약의 절반이다.
  //    ② 클릭 영구 사문화: 매 렌더마다 버튼의 innerHTML 을 다시 써서 자식 SVG 를 교체했고, pane 내부
  //       mousedown(capture)이 focusPane→emit 을 발화하므로 mousedown 타깃이 mouseup 전에 소멸 →
  //       WebKit 이 click 을 아예 디스패치하지 않았다(중앙 3회 무반응 / 모서리 1회 성공으로 실증).
  //       → 노드 보존(숨김=클래스)·글리프 조건부 재작성·불필요 emit 억제 세 조건을 모두 본다.
  const MT = path.resolve(here, "../../../codingpt_app/src/workspace/chat/ModeToggle.tsx");
  const css = readFileSync(path.resolve(here, "../src/styles.css"), "utf8");
  const wvJs = readFileSync(path.resolve(here, "../src/js/workspace-view.js"), "utf8");
  const stateJs = readFileSync(path.resolve(here, "../src/js/state.js"), "utf8");
  const paneJs2 = readFileSync(path.resolve(here, "../src/js/pane.js"), "utf8");
  const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const rule = (sel) => {
    const i = css.indexOf(sel + " {");
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };

  // (1) 배치 — pane 본문 안 절대배치 + 오프셋 부모 계약(`.pane-body` 가 컨테이닝 블록).
  const tgRule = rule(".pane-mode-toggle");
  ok("PC 토글은 pane 본문 안 우측 상단 절대배치",
    /position:\s*absolute/.test(tgRule) && /top:\s*\d/.test(tgRule) && /right:\s*\d/.test(tgRule), tgRule.replace(/\s+/g, " "));
  const chatScrollRule = rule(".chat-scroll");
  ok("채팅 본문은 토글 아래에서 전체 폭을 쓴다(우측 44px 안전지대 금지)",
    /padding:\s*44px 14px 10px/.test(chatScrollRule) && !/44px 10px 14px/.test(chatScrollRule),
    chatScrollRule.replace(/\s+/g, " "));
  ok("★ `.pane-body` 에 position: relative(없으면 토글이 탭바 `.pane-head` 를 덮는다 — 사고 ①)",
    /\.pane-body \{[^}]*position:\s*relative/.test(css));
  ok("토글 노드는 pane 본문에 붙는다(this.body)",
    /_buildModeToggle\(\)\s*\{[\s\S]{0,900}?this\.body\.appendChild\(b\)/.test(paneJs2));
  ok("Codex alternate-screen에서 mouse tracking이 없으면 휠을 내부 이동으로 보완",
    /_activeAgentBrand\(\) !== "codex"/.test(paneJs2)
      && /buffer\?\.active\?\.type !== "alternate"/.test(paneJs2)
      && /mouseTrackingMode !== "none"/.test(paneJs2)
      && /addEventListener\("wheel", onWheel/.test(paneJs2));
  ok("유휴에도 테두리+불투명 배경이 있는 컨트롤 형태(추가 버튼과 구별 · 터미널 글자 위에서 읽힘)",
    /border:\s*1px solid var\(--border-ctrl\)/.test(tgRule) && /background:\s*var\(--elevated2\)/.test(tgRule));
  ok("⌘F 검색 중에는 토글을 숨긴다(좌표 충돌 — search-open 예외 복원)",
    /\.pane-body\.search-open \.pane-mode-toggle\s*\{[^}]*display:\s*none/.test(css)
    && /classList\.add\("search-open"\)/.test(paneJs2));

  // (2) 노드 보존 — 숨김은 클래스로만(remove 도 innerHTML 교체와 같은 click 미발화를 만든다).
  ok("PC 토글 숨김은 remove 가 아니라 클래스로만(노드 보존)",
    /\.pane-mode-toggle\.hidden\s*\{[^}]*display:\s*none/.test(css)
    && /classList\.toggle\("hidden"/.test(paneJs2));
  ok("토글 노드는 pane 생성 시 1회만 만든다(재생성 금지)",
    (paneJs2.match(/_buildModeToggle\(\)/g) || []).length === 2   // 정의 1 + 호출 1
    && /this\._buildChat\(\);(?:\n\s*this\._build\w+\(\);)*\n\s*this\._buildModeToggle\(\);/.test(paneJs2));
  ok("main-top 재렌더는 mtDyn 만 비운다(헤더 상주 노드 소멸 금지 핀 유지)",
    /mtDyn\.innerHTML = ""/.test(wvJs) && !/mainTop\.innerHTML = ""/.test(wvJs));

  // (3) 글리프 조건부 재작성 — 이 가드가 사라지면 클릭이 다시 죽는다(②의 직접 원인).
  const syncAt = paneJs2.indexOf("_syncModeToggle() {");
  const syncBody = syncAt < 0 ? "" : paneJs2.slice(syncAt, paneJs2.indexOf("\n  }", syncAt));
  ok("글리프는 바뀔 때만 innerHTML 재작성(mousedown 타깃 소멸 방지)",
    syncAt > 0 && /if \(this\._modeGlyph !== want\)/.test(syncBody)
    && (syncBody.match(/innerHTML/g) || []).length === 1, syncBody.replace(/\s+/g, " ").slice(0, 240));
  ok("_syncModeToggle 은 토글 노드를 remove 하지 않는다", syncAt > 0 && !/\.remove\(\)/.test(syncBody));

  // (4) 불필요 emit 억제 — pane 클릭마다 전체 재렌더가 돌면 위 가드의 여유가 사라진다.
  const fpAt = stateJs.indexOf("export function focusPane(");
  const fpBody = fpAt < 0 ? "" : stateJs.slice(fpAt, stateJs.indexOf("\n}", fpAt));
  ok("focusPane 은 포커스 무변화면 emit 하지 않는다",
    fpAt > 0 && /if \(w\.focusId === paneId\) return;/.test(fpBody), fpBody.replace(/\s+/g, " ").trim());

  // (5) 소유 관계 — 토글 DOM 은 pane 소유. workspace-view 는 "전부 한 번 맞춰라"만 한다
  //     (헤더 전역 1개 판본의 잔재가 남아 있으면 두 벌이 동시에 그려진다).
  ok("workspace-view 는 토글 DOM 을 만들지 않는다(헤더 전역 1개 판본 잔재 없음)",
    !/mt-mode/.test(wvJs) && !/buildModeToggle/.test(wvJs) && !/\.mt-mode/.test(css));
  // 본문이 한 줄에서 블록으로 늘었다(빈 자리표시 문구도 같은 루프에서 맞춘다 — 2026-08-14).
  //  고정할 것은 "모든 pane 을 순회해 _syncModeToggle 을 부른다"이지 그 줄의 생김새가 아니다.
  ok("syncModeToggle 은 모든 pane 을 순회해 맞춘다(빠뜨린 pane = 사라진 기능)",
    /export function syncModeToggle\(\) \{[\s\S]{0,400}for \(const \[, p\] of panes\)[\s\S]{0,200}p\._syncModeToggle\?\.\(\)/.test(wvJs));
  ok("판정은 여전히 modeToggleState(공용 규칙)에서만 온다",
    /modeToggleState\(\)\s*\{/.test(paneJs2) && /const st = this\.modeToggleState\(\);/.test(syncBody));

  // (6) 3플랫폼 동일 디자인 — 글리프 크기만 대조(코너 오프셋은 플랫폼별 헤더/본문 차이로 폐기).
  if (!existsSync(MT)) console.log("SKIP 토글 글리프 크기 대조(앱 ModeToggle 없음)");
  else {
    const mt = readFileSync(MT, "utf8");
    // ★ 글리프 픽셀을 앱=PC 로 못 박지 않는다: 두 플랫폼의 다른 버튼 크기가 애초에 다르다
    //  (PC 추가 버튼 16 / 앱 19). 억지로 같은 숫자로 맞추면 각자 줄에서 어긋난다.
    const glyphLine = /b\.innerHTML = st\.chat[^\n]*/.exec(paneJs2)?.[0] || "";
    // ★ 2026-08-14: 헤더 추가 버튼은 **[+] 하나**가 됐다(옛 터미널/IDE/웹뷰/모바일 4버튼 폐기).
    //  크기 계약("토글 글리프 = 헤더 추가 버튼")은 그대로라 뽑는 자리만 옮긴다.
    const addsGlyph = num(/addBtn\.innerHTML = icons\.plus\(\{ size: (\d+) \}\)/, wvJs);
    eq("PC 토글 글리프 = PC 헤더 추가 버튼과 같은 크기", num(/size: (\d+)/, glyphLine), addsGlyph);
    ok("토글 두 글리프가 같은 크기(터미널/채팅)", (glyphLine.match(/size: (\d+)/g) || []).length === 2
      && new Set(glyphLine.match(/size: \d+/g)).size === 1, glyphLine.trim());
    // ★ 반전된 핀(사용자 확정 2026-07-27): 채팅 모드를 **색으로 표시하지 않는다**. 액센트 배경이
    //  "선택된 필터"처럼 읽혀 상태(모드)와 행동(전환)이 헷갈렸다 → 표현은 글리프 교체 하나뿐이다.
    //  한쪽만 되돌리면 두 화면이 같은 상태를 다르게 그리므로 양 플랫폼을 함께 못 박는다.
    ok("chat 활성 색을 쓰지 않는다(PC: .active 규칙 부재)",
      !/\.pane-mode-toggle\.active\s*\{/.test(css));
    ok("PC 토글에 active 클래스를 붙이지도 않는다", !/classList\.toggle\("active"/.test(syncBody), syncBody.replace(/\s+/g, " ").trim());
    ok("chat 활성 색을 쓰지 않는다(앱: accent 미사용)", !/C\.accent/.test(mt), mt.match(/.*C\.accent.*/)?.[0]);
    // 앱 쪽 배치는 앱 리포에서 별도로 옮기는 중이므로 **여기서 실패시키지 않는다**(리포 경계).
    //  대신 지금 어디서 렌더되는지 출력해 한쪽만 되돌리는 드리프트를 눈에 보이게 한다.
    const pv = path.resolve(here, "../../../codingpt_app/src/workspace/PaneView.tsx");
    const wv = path.resolve(here, "../../../codingpt_app/src/workspace/WorkspaceView.tsx");
    if (existsSync(pv) && existsSync(wv)) {
      const inPane = /<ModeToggle/.test(readFileSync(pv, "utf8"));
      const inHeader = /<ModeToggle/.test(readFileSync(wv, "utf8"));
      ok("앱도 ModeToggle 을 어딘가에서 렌더한다(전부 사라지면 기능 소실)", inPane || inHeader);
      console.log(`INFO 앱 ModeToggle 렌더 위치: PaneView=${inPane} WorkspaceView=${inHeader} (PC=pane 본문)`);
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

    // ══ 로고 판정(2026-07-27 추가) — 탭 좌측 아이콘을 에이전트 로고로 바꾼다 ══════════════
    // 노출 판정과 **실패 비대칭이 반대**다: 애매하면 켜는 대신 **모른다고 답한다**(모양은 사실 주장).
    //  두 화면이 다른 로고를 그리면 "폰에선 claude, PC 에선 터미널" 같은 비대칭이 생기므로 전 조합 대조.
    ok("앱이 resolveAgentBrand 를 export 한다", typeof A.resolveAgentBrand === "function");
    const BRAND_CMDS = ["", "zsh", "claude", "Claude", "CODEX", "codex", "gemini", "node",
      "2.1.219", "2025.09.18-7ae6800", "vim", "npm", "1.2", "1.2.3.4"];
    const BRAND_TITLES = ["", "✳ 히어로 섹션 추가", "✦ 생각 중", "◇ 대기", "✋ 승인 대기",
      "⠹ 작업 중", "demo", "claude · resume", "codex"];
    const BRAND_AGENTS = [undefined, null, true, false, "", "claude", "codex", "gemini", "none", "cursor-agent"];
    let bn = 0, bm = 0; const bbad = [];
    for (const cmd of BRAND_CMDS) for (const title of BRAND_TITLES) for (const agent of BRAND_AGENTS) {
      bn += 1;
      const inp = { push: null, tab: { cmd, title, agent } };
      const a2 = A.resolveAgentBrand(inp), b2 = PC.resolveAgentBrand(inp);
      if (a2 !== b2) { bm += 1; if (bbad.length < 3) bbad.push(`(${J(cmd)},${J(title)},${J(agent)}) app=${J(a2)} pc=${J(b2)}`); }
    }
    ok(`로고 판정 앱==PC ${bn - bm}/${bn} 조합`, bm === 0, bbad.join(" | "));
    // 실측 근거 몇 가지를 값으로 고정(사다리가 조용히 뒤바뀌는 것을 막는다).
    eq("최신 claude(cmd=버전문자열) → claude", PC.resolveAgentBrand({ tab: { cmd: "2.1.219", title: "demo" } }), "claude");
    eq("제목 글리프 ✳ → claude", PC.resolveAgentBrand({ tab: { cmd: "", title: "✳ 작업" } }), "claude");
    eq("gemini 글리프 → gemini", PC.resolveAgentBrand({ tab: { cmd: "", title: "✦ 생각 중" } }), "gemini");
    eq("점자 스피너는 이름을 특정하지 않는다(claude/codex 공용)", PC.resolveAgentBrand({ tab: { cmd: "", title: "⠹ 작업 중" } }), null);
    eq("cursor-agent(날짜형 cmd)는 모름", PC.resolveAgentBrand({ tab: { cmd: "2025.09.18-7ae6800", title: "demo" } }), null);
    eq("push 가 이름을 실어 오면 그것이 정본", PC.resolveAgentBrand({ push: { agent: "codex" }, tab: { cmd: "claude" } }), "codex");
    eq("빈 셸은 모름(터미널 글리프 유지)", PC.resolveAgentBrand({ tab: { cmd: "zsh", title: "demo" } }), null);
    eq("입력이 없어도 죽지 않는다", PC.resolveAgentBrand(null), null);

    // 렌더 핀 — 판정이 맞아도 그리는 쪽이 폴백을 잃으면 아이콘이 **사라진다**(실제로 한 번 냈던 실수:
    //  `<AgentMark/> || <TerminalWindow/>` 는 JSX 요소가 항상 truthy 라 폴백이 도달 불가였다).
    const paneTsx = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/PaneView.tsx"), "utf8");
    ok("앱 탭 아이콘: brand 가 있을 때만 로고, 없으면 터미널 글리프(삼항)",
      /brand \? \([\s\S]{0,300}<AgentLogo[\s\S]{0,300}<TerminalWindow/.test(paneTsx));
    // ★ 공식 브랜드 path 를 쓴다(사용자 지적 "너무 대충" → 근사 도형 금지). 양 플랫폼 **같은 데이터**여야
    //  같은 그림이 나온다 → path 문자열을 직접 대조한다(길어서 앞 80자만 비교해도 충분히 특이하다).
    const logoTsx = readFileSync(path.resolve(here, "../../../codingpt_app/src/workspace/AgentLogo.tsx"), "utf8");
    const pcIcons = readFileSync(path.resolve(here, "../src/js/icons.js"), "utf8");
    // 카탈로그의 5종 전부 — 하나라도 앱/PC 가 다르면 같은 탭이 기기마다 다른 그림이 된다.
    //  `cursor-agent` 처럼 하이픈이 든 키는 앱 쪽에서 따옴표로 감싸이므로 두 형태를 다 받는다.
    const BRANDS = [
      ["claude", "claudeMark"], ["codex", "codexMark"], ["gemini", "geminiMark"],
      ["cursor-agent", "cursorMark"], ["opencode", "opencodeMark"],
    ];
    for (const [brand, key] of BRANDS) {
      const app = new RegExp(`'?${brand}'?: '([^']{20,})'`).exec(logoTsx)?.[1] || "";
      const pc = new RegExp(`${key}: \\(o\\) => brandSvg2\\('${brand}', '([^']{20,})'`).exec(pcIcons)?.[1] || "";
      ok(`${brand} 로고 path 가 앱==PC (len ${app.length}/${pc.length})`, !!app && app === pc,
        `app=${app.slice(0, 40)} pc=${pc.slice(0, 40)}`);
    }
    ok("PC 브랜드 마크는 fill 로고로 그린다(라인 stroke 금지 — 획이 뭉개진다)",
      /const brandSvg = \(d, o = \{\}\) => \{[\s\S]{0,300}stroke="none"/.test(pcIcons));
    // ★ 로고는 **브랜드 색**으로 그린다(사용자 지적: "로고 컬러는 왜 적용 안 되나"). currentColor 로
    //  칠하면 텍스트 색(dim)이 되어 브랜드 식별이 사라진다. 양 플랫폼이 같은 hex 를 써야 같은 그림이다.
    // 색도 브랜드마다 대조한다(리터럴 모양을 고정하지 않는다 — 브랜드를 추가할 때마다 정규식이
    //  깨지면 그 테스트는 유지되지 않고 결국 느슨해진다).
    const pcBrandBlock = /const BRAND = \{([^}]*)\}/.exec(pcIcons)?.[1] || "";
    const appBrandBlock = /const BRAND_COLOR: Record<string, string> = \{([\s\S]*?)\n\};/.exec(logoTsx)?.[1] || "";
    const hexOf = (block, brand) =>
      (new RegExp(`["']?${brand}["']?:\\s*["'](#[0-9A-Fa-f]{6})["']`).exec(block)?.[1] || "").toUpperCase();
    for (const [brand] of BRANDS) {
      const pcH = hexOf(pcBrandBlock, brand);
      const appH = hexOf(appBrandBlock, brand);
      ok(`브랜드 색 앱==PC (${brand} ${pcH})`, !!pcH && pcH === appH, `pc=${pcH} app=${appH}`);
    }
    // ⚠ 주석을 먼저 걷어낸다 — 이 함정을 **설명하는 주석 자체**가 정규식에 걸려 거짓 실패가 났다
    //   (테스트가 자기 문서를 결함으로 신고하는 형태). 코드만 본다.
    const paneCode = paneTsx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    ok("앱 탭 아이콘 폴백을 `||` 로 쓰지 않는다(JSX 요소는 항상 truthy)",
      !/<AgentLogo[^>]*\/>\s*\|\|/.test(paneCode));
    // paneJs2 는 다른 블록 스코프의 변수다 — 여기서 참조하면 **테스트가 크래시**한다(실제로 냈다:
    //  FAIL 이 아니라 ReferenceError 라서 필터로 요약만 보면 "통과"로 오독된다). 이 블록에서 다시 읽는다.
    const pcPane = readFileSync(path.resolve(here, "../src/js/pane.js"), "utf8");
    ok("PC 탭 아이콘도 같은 규칙(agentMarkHtml || 터미널 글리프)",
      /this\._tabAgentMark\(t\) \|\| icons\.terminal/.test(pcPane));
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
