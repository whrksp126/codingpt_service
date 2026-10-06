// agent-glyph.js — 에이전트 상태 표식 한 벌(사이드바 에이전트 행 · pane 탭이 같이 쓴다).
//  Orca 의 AgentStateDot 어휘를 그대로 옮겼다(2026-10-06): 누가(에이전트 로고)와 지금 어떤 상태인가(이 표식)를
//  두 개의 글리프로 나눈다. 일하는 중 = 도는 고리, 끝 = 체크, 답이 필요 = 말풍선 물음표, 근거 없음 = 점선 고리,
//  막힘·실패 = 빨간 점, 사용자가 멈춤 = 흐린 점, 한가함 = 회색 점. 색은 상태 신호에만 쓴다.
const SVG = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  done: SVG('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  waiting: SVG('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  unverifiable: SVG('<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>'),
};
export const AGENT_GLYPHS = ["working", "waiting", "blocked", "failed", "interrupted", "done", "unverifiable", "idle"];

/** 상태 표식 HTML. glyph 는 AGENT_GLYPHS 중 하나(모르면 idle). title 은 마우스를 올렸을 때의 말. */
export function agentGlyphHtml(glyph, title) {
  const g = AGENT_GLYPHS.includes(glyph) ? glyph : "idle";
  const t = title ? ` title="${String(title).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"` : "";
  const inner = g === "working" ? '<span class="ag-spin"></span>' : ICON[g] || '<span class="ag-pt"></span>';
  return `<span class="ag-glyph ${g}"${t}>${inner}</span>`;
}
