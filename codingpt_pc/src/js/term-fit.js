// term-fit.js — xterm `FitAddon.fit()` 결과의 **실측 보정**(순수 함수 — DOM/전역 의존 0).
//
// 왜 필요한가 (2026-07-27, 실제 xterm 빌드로 헤드리스 측정해 확정)
//   `.pane-term` 폭 1500 → fit() 이 cols=197 (cellW 7.563 → 내용 1490px) 을 주는데,
//   그 내용을 실제로 보여주는 `.xterm-viewport` 의 clientWidth 는 **1481px**(세로 스크롤바 9px 제외).
//   → 마지막 열이 스크롤바 아래로 들어가 잘린다. 사용자 신고 "우측이 잘린다"의 정체.
//
// FitAddon 이 틀리는 이유 두 가지(둘 다 소스로 확인 — vendor/xterm-addon-fit.js `proposeDimensions`):
//   ① 부모 폭을 `getComputedStyle(parent).width` 로 읽는데 이 앱은 `* { box-sizing: border-box }` 라
//      그 값에 부모(`.pane-term`)의 padding(좌 8 + 우 2 = 10px)이 **포함**되어 있다. FitAddon 은
//      터미널 자기 element 의 padding 만 빼므로 부모 padding 10px 을 그대로 과다 계상한다.
//   ② 스크롤바 폭은 `viewport.offsetWidth - scrollArea.offsetWidth` 를 **Viewport 생성 시 한 번** 재고
//      그 값을 부모 폭에서 빼는데, 실제 스크롤바는 `.xterm`(=부모 폭 - padding) **안쪽**에서 자리를
//      먹는다. 즉 빼는 기준 폭이 애초에 다르다.
//   두 오차가 부분 상쇄돼(+10 / −9) "정확히 스크롤바 폭만큼 넘친다"는 모습으로 나타났다.
//
// 그래서 규칙: **fit 이 계산한 값을 믿지 않고, 실제로 보이는 영역(viewport clientWidth/Height)으로
//   검산해 넘치면 줄인다.** 벤더가 바뀌어도(내부 API 소멸) 입력이 비면 그냥 원래 값을 돌려주므로
//   조용히 죽지 않는다(호출측 pane.js `_correctFit` 이 내부 API 접근을 try 로 감싼다).
//
// 세로도 같은 오차 구조다(`.pane-term` padding 상 4 + 하 2 = 6px 과다 계상). 가로처럼 항상은 아니고
//   "남는 높이 % 셀높이 < 6px" 인 창 높이에서만 한 줄이 잘린다 → 같은 함수로 함께 검산한다.

/** 부동소수 여유(셀 폭 계산이 canvas.width/cols 라 소수점 셋째 자리에서 흔들린다). */
export const FIT_EPS = 0.5;

/**
 * 항상 비워 두는 우측/하단 여백(px). **측정을 믿지 않고 무조건 확보한다.**
 *
 * 왜 상수인가(2026-07-27, 사용자 신고 3회 후): `viewport.clientWidth` 가 스크롤바를 제외하는지는
 *  스크롤바 종류(공간 점유 vs 오버레이)·표시 시점(내용이 차기 전/후)·플랫폼에 따라 달라진다.
 *  즉 **측정만으로는 "마지막 열이 스크롤바 아래로 들어갔는가"를 확신할 수 없다.**
 *  두 실패의 무게가 다르다: 한 열을 덜 쓰면 우측에 9px 빈 띠가 생길 뿐이지만, 한 열이 잘리면
 *  TUI 의 테두리·상태줄이 사라지고 **tmux 는 히스토리를 리플로우하지 않아 영구히 남는다.**
 *  → 애매하면 덜 쓴다. 값은 앱 스크롤바 폭(`::-webkit-scrollbar { width: 9px }`)과 같다.
 *  모바일 앱이 처음부터 8px 거터를 예약해 잘림이 없었던 것과 같은 처방이다.
 */
export const FIT_GUTTER_PX = 9;

/**
 * 한 번의 보정으로 줄일 수 있는 최대 칸 수.
 *  · 스크롤바(≤15px)+부모 padding(10px) 을 최소 셀폭(폰트 8px ≈ 4.7px)으로 나눠도 6칸을 넘지 않는다.
 *  · 상한을 두는 이유는 폭주 방지다: 측정이 이상한 순간(레이아웃 0폭·전환 중)에 터미널이 2열로
 *    쪼그라들어 tmux 창까지 그 크기로 끌고 가는 것이 잘림보다 훨씬 나쁘다.
 */
export const FIT_MAX_SHRINK = 6;

// 내부 공통 — count 개의 셀(cellPx)이 실제 가시 영역(availPx) 안에 들어가도록 count 를 줄인다.
function shrinkToFit(count, cellPx, availPx, minCount, maxShrink, gutterPx) {
  const n = Number(count);
  const cell = Number(cellPx);
  const g = Number.isFinite(Number(gutterPx)) ? Math.max(0, Number(gutterPx)) : 0;
  // 가시 폭에서 거터를 **먼저** 뺀다(§FIT_GUTTER_PX) — 측정이 스크롤바를 이미 제외했더라도
  //  한 열을 덜 쓰는 쪽이 잘리는 쪽보다 낫다.
  const avail = Number(availPx) - g;
  const lim = Number.isFinite(Number(maxShrink)) ? Number(maxShrink) : FIT_MAX_SHRINK;
  // 방어: 내부 API 부재/미측정(0·NaN·음수)이면 **보정하지 않는다**(기존 동작 유지).
  if (!Number.isFinite(n) || n <= minCount) return Number.isFinite(n) ? n : count;
  if (!Number.isFinite(cell) || cell <= 0) return n;
  if (!Number.isFinite(avail) || avail <= 0) return n;
  if (n * cell <= avail + FIT_EPS) return n; // 안 넘친다 = 그대로
  const fits = Math.floor((avail + FIT_EPS) / cell);
  return Math.max(minCount, n - lim, Math.min(n, fits));
}

/**
 * 가로 보정 — fit() 이 준 cols 를 실제 viewport 폭에 맞춰 줄인다.
 * @param {{colsFromFit:number, cellW:number, viewportW:number, maxShrink?:number, gutterPx?:number}} a
 * @returns {number} 최종 cols (보정 불가/불필요면 colsFromFit 그대로)
 */
export function fitCorrection({ colsFromFit, cellW, viewportW, maxShrink, gutterPx } = {}) {
  return shrinkToFit(colsFromFit, cellW, viewportW, 2, maxShrink, gutterPx);
}

/**
 * 세로 보정 — fit() 이 준 rows 를 실제 viewport 높이에 맞춰 줄인다(규칙은 가로와 동일).
 * @param {{rowsFromFit:number, cellH:number, viewportH:number, maxShrink?:number}} a
 * @returns {number} 최종 rows
 */
export function fitRowsCorrection({ rowsFromFit, cellH, viewportH, maxShrink, gutterPx } = {}) {
  return shrinkToFit(rowsFromFit, cellH, viewportH, 1, maxShrink, gutterPx);
}
