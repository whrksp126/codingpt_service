// term-fit.mjs — 터미널 fit 보정(우측 잘림 근본수정)의 **실행 검증** + 배선 회귀 핀.
//
// 왜 이 파일이 있는가
//  사용자 신고: "터미널 우측이 잘린다". 헤드리스 Chrome 에서 실제 vendor xterm + styles.css 로 측정해
//  원인을 확정했다(숫자는 아래 케이스 그대로):
//    `.pane-term` 폭 1500 → FitAddon 이 cols=197 (cellW 7.563 → 내용 1490px) 을 주는데, 그 내용을
//    실제로 보여주는 `.xterm-viewport` 의 clientWidth 는 1481px(세로 스크롤바 9px 제외) → 9px 초과.
//  FitAddon 이 틀리는 이유는 두 겹이다(vendor 소스로 확인):
//    ① 부모 폭을 `getComputedStyle(parent).width` 로 읽는데 이 앱은 `* { box-sizing: border-box }` 라
//       그 값에 `.pane-term` 의 padding(좌8+우2=10px)이 포함돼 있고 FitAddon 은 그걸 빼지 않는다.
//    ② 스크롤바 폭은 Viewport 생성 시 한 번 재서 부모 폭에서 빼는데, 실제 스크롤바는 `.xterm`
//       (=부모 폭−padding) **안쪽**에서 자리를 먹는다 → 빼는 기준 폭이 애초에 다르다.
//  그래서 "fit 을 믿지 말고 실제 가시 폭으로 검산해 넘치면 줄인다"가 수정이고, 그 규칙이 term-fit.js 다.
//
// 아래 단정은 순수 함수를 **실제로 실행**한다(정규식으로 소스 모양만 보는 공허한 검증 회피).
// 라이브 실측(헤드리스, 창 폭 900/1200/1500/1900 × 배율 0.8/1.0/1.3)에서 보정 전 overflowPx>0 이던
// 조합이 보정 후 전부 ≤0 이 되는 것도 확인했다(라운드 보고서에 표 첨부).
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fitCorrection, fitRowsCorrection, FIT_EPS, FIT_MAX_SHRINK } from "../src/js/term-fit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got=${got} want=${want}`);

// ── 1. 실측 케이스 재현(이 숫자가 곧 사용자 신고의 내용) ─────────────────────────
eq("실측: 폭 1500 / cols 197 / cellW 7.563 / viewport 1481 → 195 로 줄인다",
  fitCorrection({ colsFromFit: 197, cellW: 7.563, viewportW: 1481 }), 195);
ok("보정 후에는 더 이상 넘치지 않는다(내용 ≤ 가시폭)",
  195 * 7.563 <= 1481 + FIT_EPS, `${195 * 7.563} vs ${1481}`);
ok("보정 결과는 FitAddon 이 '스크롤바를 알았다면' 냈을 값과 같다(과잉 축소 아님)",
  Math.floor(1481 / 7.563) === 195);

// ── 2. 넘치지 않으면 손대지 않는다(불필요한 tmux 리사이즈 금지) ────────────────────
eq("딱 맞으면 그대로", fitCorrection({ colsFromFit: 100, cellW: 8, viewportW: 800 }), 100);
eq("여유가 있으면 그대로", fitCorrection({ colsFromFit: 90, cellW: 8, viewportW: 800 }), 90);
eq("부동소수 오차(EPS 이내)는 초과로 보지 않는다",
  fitCorrection({ colsFromFit: 100, cellW: 8.004, viewportW: 800 }), 100);

// ── 3. 방어 — 내부 API 부재/미측정이면 **보정하지 않는다**(조용히 죽지 않게) ─────────
for (const [label, arg] of [
  ["cellW 0(렌더 전)", { colsFromFit: 197, cellW: 0, viewportW: 1481 }],
  ["cellW NaN", { colsFromFit: 197, cellW: NaN, viewportW: 1481 }],
  ["viewport 0(display:none)", { colsFromFit: 197, cellW: 7.563, viewportW: 0 }],
  ["viewport undefined(구조 변경)", { colsFromFit: 197, cellW: 7.563, viewportW: undefined }],
  ["viewport 음수", { colsFromFit: 197, cellW: 7.563, viewportW: -5 }],
]) eq(`방어: ${label} → 원래 cols 유지`, fitCorrection(arg), 197);
eq("인자 자체가 없어도 던지지 않는다(undefined 반환)", fitCorrection(), undefined);
eq("최소 열(2) 아래로는 내려가지 않는다",
  fitCorrection({ colsFromFit: 2, cellW: 100, viewportW: 10 }), 2);
eq("한 번에 줄일 수 있는 상한(FIT_MAX_SHRINK)을 넘지 않는다 — 측정 이상 시 폭주 방지",
  fitCorrection({ colsFromFit: 200, cellW: 8, viewportW: 100 }), 200 - FIT_MAX_SHRINK);

// ── 4. 세로도 같은 규칙(`.pane-term` 상4+하2=6px 이 같은 방식으로 과다 계상된다) ──────
eq("세로: rows 42 / cellH 15 / viewport 620 → 41",
  fitRowsCorrection({ rowsFromFit: 42, cellH: 15, viewportH: 620 }), 41);
eq("세로: 넘치지 않으면 그대로(viewport 637 · 실측 케이스)",
  fitRowsCorrection({ rowsFromFit: 42, cellH: 15, viewportH: 637 }), 42);
eq("세로 최소 1행", fitRowsCorrection({ rowsFromFit: 1, cellH: 15, viewportH: 3 }), 1);
eq("세로 방어: cellH 0 → 그대로", fitRowsCorrection({ rowsFromFit: 42, cellH: 0, viewportH: 620 }), 42);

// ── 5. 스윕 — 어떤 (폭, 셀폭, 스크롤바) 조합에서도 결과가 "넘치지 않고 1칸 이상 남기지 않는다" ──
//    (넘치면 잘림 재발 / 너무 많이 줄이면 화면을 낭비 = 두 방향 모두 결함)
{
  let n = 0, bad = 0; const ex = [];
  for (const paneW of [420, 640, 900, 1200, 1500, 1900, 2560]) {
    for (const cellW of [4.7, 6.02, 7.563, 9.031, 11.5]) {
      for (const sb of [0, 9, 15]) {
        // FitAddon 이 실제로 하는 계산(부모 padding 10px 미차감 + 스크롤바 차감)
        const colsFromFit = Math.max(2, Math.floor((paneW - sb) / cellW));
        const viewportW = paneW - 10 - sb;   // 진짜 가시 폭
        const cols = fitCorrection({ colsFromFit, cellW, viewportW });
        n += 1;
        const over = cols * cellW > viewportW + FIT_EPS;
        const waste = viewportW - cols * cellW >= cellW; // 한 칸 더 들어갈 여유를 남겼는가
        if (over || (waste && colsFromFit >= Math.floor(viewportW / cellW))) {
          bad += 1;
          if (ex.length < 3) ex.push(`paneW=${paneW} cellW=${cellW} sb=${sb} fit=${colsFromFit} → ${cols} (over=${over} waste=${waste})`);
        }
      }
    }
  }
  ok(`스윕 ${n - bad}/${n} 조합: 보정 후 초과 0 · 과잉 축소 0`, bad === 0, ex.join(" | "));
}

// ── 6. 배선 핀 — pane.js 가 fit 뒤에 반드시 검산하고, 그 값으로 리사이즈를 보낸다 ──────
{
  const src = readFileSync(path.resolve(here, "../src/js/pane.js"), "utf8");
  const at = src.indexOf("  _fitNow() {");
  const body = at < 0 ? "" : src.slice(at, src.indexOf("\n  }", at));
  ok("_fitNow 는 fit() 다음에 _correctFit() 을 부른다(보정 없는 경로 부활 금지)",
    at > 0 && /this\.fit\.fit\(\);[\s\S]{0,80}this\._correctFit\(\);/.test(body), body.replace(/\s+/g, " "));
  ok("_resize 는 보정 뒤의 cols/rows 로 나간다(순서 뒤집히면 tmux 가 스테일 크기를 받는다)",
    body.indexOf("_correctFit") < body.indexOf("this._resize("));
  const ca = src.indexOf("  _correctFit() {");
  const cbody = ca < 0 ? "" : src.slice(ca, src.indexOf("\n  }", ca));
  ok("_correctFit 은 term-fit.js 의 순수 규칙을 쓴다(인라인 재구현 금지)",
    /fitCorrection\(\{/.test(cbody) && /fitRowsCorrection\(\{/.test(cbody));
  ok("판정 기준은 `.xterm-viewport` 의 실제 clientWidth/Height",
    /querySelector\("\.xterm-viewport"\)/.test(cbody) && /vp\.clientWidth/.test(cbody) && /vp\.clientHeight/.test(cbody));
  ok("내부 API 는 방어적으로 읽는다(옵셔널 체이닝 + try) — 벤더 업그레이드로 조용히 죽지 않게",
    /_core\?\./.test(cbody) && /if \(!cell \|\| !vp\) return;/.test(cbody) && /catch \(_\) \{ return; \}/.test(cbody));
  ok("보정 루프에 상한이 있다(무한 루프 금지)", /for \(let pass = 0; pass < 2; pass\+\+\)/.test(cbody));
  ok("변화가 없으면 즉시 끝낸다(불필요 resize 0)",
    /if \(cols === t\.cols && rows === t\.rows\) return;/.test(cbody));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
