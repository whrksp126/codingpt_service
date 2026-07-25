// icons.js — 인라인 SVG 아이콘(이모지 금지). Phosphor/Lucide 풍 라인 아이콘, currentColor.
const svg = (inner, o = {}) =>
  `<svg viewBox="0 0 24 24" width="${o.size || 16}" height="${o.size || 16}" fill="none" stroke="currentColor" stroke-width="${o.sw || 1.8}" stroke-linecap="round" stroke-linejoin="round" class="ic">${inner}</svg>`;

export const icons = {
  sidebar: (o) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>', o),
  // 열림 상태 표시용 — 왼쪽 컬럼이 채워진 변형(색이 아니라 채움 유무로 토글 상태를 직관 표현).
  sidebarFilled: (o) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M4 4h5v16H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="currentColor" stroke="none"/>', o),
  bell: (o) => svg('<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5 2 5.5H4c.5-.5 2-1.5 2-5.5"/><path d="M10 18.5a2 2 0 0 0 4 0"/>', o),
  plus: (o) => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', o),
  folder: (o) => svg('<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', o),
  terminal: (o) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><line x1="12.5" y1="15" x2="17" y2="15"/>', o),
  x: (o) => svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', o),
  splitRight: (o) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="13" y1="4" x2="13" y2="20"/>', o),
  splitDown: (o) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/>', o),
  monitor: (o) => svg('<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="8.5" y1="20" x2="15.5" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>', o),
  smartphone: (o) => svg('<rect x="6.5" y="3" width="11" height="18" rx="2.4"/><line x1="10.5" y1="18" x2="13.5" y2="18"/>', o),
  pin: (o) => svg('<path d="M9 3.5h6l-1 5 2.5 2.5V13H7.5v-2L10 8.5z"/><line x1="12" y1="13" x2="12" y2="20.5"/>', o),
  dots: (o) => svg('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', o),
  trash: (o) => svg('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>', o),
  edit: (o) => svg('<path d="M4 20h4l10.5-10.5a2 2 0 0 0-2.8-2.8L5 17.2z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/>', o),
  palette: (o) => svg('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.6 1.3-2 2.5-2H18a3 3 0 0 0 3-3 8 8 0 0 0-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>', o),
  arrowUp: (o) => svg('<line x1="12" y1="19" x2="12" y2="6"/><path d="M6 12l6-6 6 6"/>', o),
  arrowDown: (o) => svg('<line x1="12" y1="5" x2="12" y2="18"/><path d="M6 12l6 6 6-6"/>', o),
  arrowTop: (o) => svg('<line x1="5" y1="5" x2="19" y2="5"/><line x1="12" y1="20" x2="12" y2="9"/><path d="M7 13l5-5 5 5"/>', o),
  cloud: (o) => svg('<path d="M7 18a4 4 0 0 1-.5-8A5 5 0 0 1 16.5 9 3.5 3.5 0 0 1 17 18H7z"/>', o),
  refresh: (o) => svg('<path d="M20 11a8 8 0 1 0-2.3 5.3"/><path d="M20 5v6h-6"/>', o),
  gear: (o) => svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.1 5.1l2.1 2.1M16.8 16.8l2.1 2.1M18.9 5.1l-2.1 2.1M7.2 16.8l-2.1 2.1"/>', o),
  globe: (o) => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.4 2.6 15.6 0 18M12 3c-2.6 2.4-2.6 15.6 0 18"/>', o),
  code: (o) => svg('<path d="M8.5 8l-4 4 4 4"/><path d="M15.5 8l4 4-4 4"/><path d="M13.5 6l-3 12"/>', o),
  user: (o) => svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>', o),
  caretRight: (o) => svg('<path d="M9 5l7 7-7 7"/>', o),
  chevronUp: (o) => svg('<path d="M6 15l6-6 6 6"/>', o),
  chevronDown: (o) => svg('<path d="M6 9l6 6 6-6"/>', o),
  external: (o) => svg('<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>', o),
  search: (o) => svg('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>', o),
  chevronLeft: (o) => svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>', o),
  chevronRight: (o) => svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>', o),
  sun: (o) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>', o),
  moon: (o) => svg('<path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.8 6.8 0 0 0 10 10z"/>', o),
  tools: (o) => svg('<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.1L4 16.3V20h3.7l5.7-5.7a3.5 3.5 0 0 0 4.1-4.8L15 12l-3-3z"/>', o),
  dot: (o) => `<span class="ic-dot ${o?.cls || ""}"></span>`,
  // Design Mode 요소 선택 — 크로스헤어(중앙 원 + 4방향 십자선).
  crosshair: (o) => svg('<circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>', o),
  handoffIn: (o) => svg('<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>', o),
  handoffOut: (o) => svg('<path d="M12 21V11"/><path d="M8 15l4-4 4 4"/><path d="M4 9V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/>', o),
  // TUI↔Chat 토글 글리프 — 모바일 phosphor `ChatCircleDots` 와 같은 의미(말풍선+점 3개).
  //  3플랫폼 동일 디자인 요구 → 형태/두께를 phosphor 라인 톤에 맞춘다.
  chat: (o) => svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.4 3.6a.4.4 0 0 1-.6-.3V16z"/><circle cx="8.5" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r=".9" fill="currentColor" stroke="none"/>', o),
  copy: (o) => svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15"/>', o),
  check: (o) => svg('<path d="M5 12.5l4.5 4.5L19 7"/>', o),
  // 승인 카드 헤드 — 방패+체크(권한 요청). warning 삼각형은 "오류"로 읽히므로 피한다.
  shield: (o) => svg('<path d="M12 3l7 2.5v5.8c0 4-2.8 7.6-7 9.2-4.2-1.6-7-5.2-7-9.2V5.5z"/><path d="M9 12l2.2 2.2L15.5 10"/>', o),
};

// DOM 헬퍼: 아이콘 버튼.
export function iconBtn(name, opts = {}) {
  const b = document.createElement("button");
  b.className = "ic-btn" + (opts.cls ? " " + opts.cls : "");
  b.innerHTML = icons[name](opts);
  if (opts.title) b.title = opts.title;
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}
