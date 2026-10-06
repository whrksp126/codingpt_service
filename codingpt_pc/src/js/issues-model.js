// issues-model.js — 이슈 화면의 순수 판정(걸러 보기·묶기·정렬). PC 화면이 쓰고, 폰 앱이 같은 규칙을 옮겨 쓴다.
//  데몬 issues.js 가 주는 공통 모양을 그대로 받는다: { id, key, title, status, priority, labels, cwd, source:{provider}, updatedAt … }.
export const STATUSES = ["todo", "in_progress", "in_review", "done"];
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
export const VIEWS = ["list", "board", "table"];
/** 묶어 보는 순서 — 지금 손이 가야 하는 것부터(진행 중 → 리뷰 중 → 할 일 → 완료). */
export const GROUP_ORDER = ["in_progress", "in_review", "todo", "done"];

/** 걸러 보기. f = { source: "all"|provider, cwd: ""|폴더, q: 검색어, done: 완료 포함 여부 } */
export function filterIssues(issues, f) {
  const o = f || {};
  const q = String(o.q || "").trim().toLowerCase();
  return (issues || []).filter((x) => {
    if (o.source && o.source !== "all" && x.source.provider !== o.source) return false;
    if (o.cwd && (x.cwd || "") !== o.cwd) return false;
    if (!o.done && x.status === "done") return false;
    if (q && !(`${x.key} ${x.title} ${(x.labels || []).join(" ")}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

const PRI_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
/** 한 묶음 안의 순서 — 우선순위 높은 것, 그다음 최근에 바뀐 것. */
export function sortIssues(list) {
  return (list || []).slice().sort((a, b) => (PRI_RANK[a.priority] ?? 4) - (PRI_RANK[b.priority] ?? 4) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** 상태별 묶음 → [{ status, items }] (order 순서, 빈 묶음 포함 여부는 keepEmpty). */
export function groupByStatus(list, { order = GROUP_ORDER, keepEmpty = false } = {}) {
  return order.map((status) => ({ status, items: sortIssues((list || []).filter((x) => x.status === status)) }))
    .filter((g) => keepEmpty || g.items.length);
}

/** 표 정렬. key = key|title|status|priority|source|cwd|updatedAt, dir = 1|-1 */
export function sortTable(list, key, dir) {
  const d = dir === -1 ? -1 : 1;
  const val = (x) => key === "status" ? STATUSES.indexOf(x.status) : key === "priority" ? (PRI_RANK[x.priority] ?? 4)
    : key === "source" ? x.source.provider : key === "updatedAt" ? (x.updatedAt || 0) : key === "key" ? (x.number || 0) : String(x[key] || "").toLowerCase();
  return (list || []).slice().sort((a, b) => { const p = val(a); const q = val(b); return (p < q ? -1 : p > q ? 1 : 0) * d || (b.updatedAt || 0) - (a.updatedAt || 0); });
}

/** 출처 목록(걸러 보기 선택지) — 실제로 이슈가 있거나 연결된 것만. → ["all", "codingpt", "github", …] */
export function sourceOptions(issues, sources) {
  const set = new Set(["codingpt"]);
  for (const s of sources || []) if (s && s.provider) set.add(s.provider);
  for (const x of issues || []) set.add(x.source.provider);
  return ["all", ...set];
}

/** 열린 이슈 수(사이드바 배지). */
export function openCount(issues) { return (issues || []).filter((x) => x.status !== "done").length; }
