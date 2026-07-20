// tiling.js — pane 분할 트리(순수 로직). 렌더/영속화가 이 트리를 소비한다.
//
//  노드:
//   · leaf   = { id, kind:'terminal'|'preview', win?, url? }
//   · branch = { dir:'h'|'v', ratio:0..1, first:node, second:node }
//     - dir 'h' = 좌우 분할(가로로 나란히), 'v' = 상하 분할(세로로 쌓기)
//
//  cmux: ⌘D = 우측 분할('h'), ⌘⇧D = 하단 분할('v').

let _seq = 1;
export function newPaneId() {
  return "p" + _seq++ + "-" + Math.floor(performance.now()).toString(36);
}
// 영속화 복원 시 seq 를 밀어 충돌 방지.
export function bumpSeq(fromIds) {
  for (const id of fromIds || []) {
    const m = /^p(\d+)-/.exec(id || "");
    if (m) _seq = Math.max(_seq, parseInt(m[1], 10) + 1);
  }
}

// leaf: 터미널 pane 은 탭 배열(각 탭=tmux 터미널). 프리뷰는 url, IDE 는 openPath.
export function leaf(kind, opts = {}) {
  if (kind === "ide") return { id: newPaneId(), kind, openPath: opts.openPath || null };
  if (kind === "preview") return { id: newPaneId(), kind, url: opts.url || null };
  // empty: 터미널 0개 상태의 자리 pane — 자동 생성 금지(닫힘=전 기기 공통 의사), 사용자가 + 로 추가.
  if (opts.empty) return { id: newPaneId(), kind: "terminal", tabs: [], active: 0 };
  return {
    id: newPaneId(),
    kind: "terminal",
    tabs: [{ win: opts.win ?? 0, title: opts.title || "" }],
    active: 0,
  };
}

export function isLeaf(n) {
  return n && !n.dir;
}

// 트리에서 leaf 를 찾아 반환.
export function findLeaf(node, id) {
  if (!node) return null;
  if (isLeaf(node)) return node.id === id ? node : null;
  return findLeaf(node.first, id) || findLeaf(node.second, id);
}

// 모든 leaf 순회.
export function eachLeaf(node, cb) {
  if (!node) return;
  if (isLeaf(node)) return cb(node);
  eachLeaf(node.first, cb);
  eachLeaf(node.second, cb);
}

export function leafIds(node) {
  const ids = [];
  eachLeaf(node, (l) => ids.push(l.id));
  return ids;
}

// 다음 터미널 표시명("터미널 N") — 생성 시 고정 부여(pane 간 이동/새 분할에도 유지).
//  win(tmux window index)에서 파생하던 라벨은 독립 세션 구조에서 이동 시 번호가 재부여돼 이름이
//  바뀌어 보였다 → 사용중 번호(제목 "터미널 N" + 무제목 탭의 win 레거시 라벨) 최대값 +1.
export function nextTerminalTitle(root) {
  let max = 0;
  eachLeaf(root, (l) => {
    if (l.kind !== "terminal") return;
    for (const t of l.tabs || []) {
      const m = /^터미널 (\d+)$/.exec(t.title || "");
      if (m) max = Math.max(max, parseInt(m[1], 10));
      else if (!t.title && typeof t.win === "number") max = Math.max(max, t.win);
    }
  });
  return "터미널 " + (max + 1);
}

// leaf 를 branch 로 치환(분할). before=true 면 newLeaf 를 first(좌/상)에 둔다.
//  반환: { tree, added } (새 트리 루트 + 추가된 leaf).
export function split(root, targetId, dir, newLeafNode, before) {
  const added = newLeafNode || leaf("terminal");
  function rec(node) {
    if (isLeaf(node)) {
      if (node.id !== targetId) return node;
      return before
        ? { dir, ratio: 0.5, first: added, second: node }
        : { dir, ratio: 0.5, first: node, second: added };
    }
    return { ...node, first: rec(node.first), second: rec(node.second) };
  }
  return { tree: rec(root), added };
}

// leaf 닫기: 형제를 부모 자리로 승격. 마지막 하나면 null(빈 워크스페이스).
//  반환: { tree, focusId } (닫은 뒤 포커스 후보).
export function closeLeaf(root, targetId) {
  if (isLeaf(root)) return { tree: root.id === targetId ? null : root, focusId: null };
  function rec(node) {
    if (isLeaf(node)) return { node, hit: false };
    // 직속 자식이 타겟 leaf 면 형제 승격.
    if (isLeaf(node.first) && node.first.id === targetId) {
      return { node: node.second, hit: true, focusId: firstLeafId(node.second) };
    }
    if (isLeaf(node.second) && node.second.id === targetId) {
      return { node: node.first, hit: true, focusId: firstLeafId(node.first) };
    }
    const a = rec(node.first);
    if (a.hit) return { node: { ...node, first: a.node }, hit: true, focusId: a.focusId };
    const b = rec(node.second);
    if (b.hit) return { node: { ...node, second: b.node }, hit: true, focusId: b.focusId };
    return { node, hit: false };
  }
  const r = rec(root);
  return { tree: r.node, focusId: r.focusId || null };
}

// leaf(id) 를 다른 노드로 치환(불변). IDE/프리뷰 pane 병합 시 대상 leaf 를 탭 host 로 교체하는 데 사용.
export function replaceLeaf(root, id, replacement) {
  function rec(node) {
    if (isLeaf(node)) return node.id === id ? replacement : node;
    return { ...node, first: rec(node.first), second: rec(node.second) };
  }
  return rec(root);
}

// 두 leaf 의 트리 내 위치를 맞바꾼다(불변). 노드 객체 identity 는 유지.
export function swapLeaves(root, idA, idB) {
  const a = findLeaf(root, idA);
  const b = findLeaf(root, idB);
  if (!a || !b) return root;
  function rec(node) {
    if (isLeaf(node)) {
      if (node.id === idA) return b;
      if (node.id === idB) return a;
      return node;
    }
    return { ...node, first: rec(node.first), second: rec(node.second) };
  }
  return rec(root);
}

// leaf 통째로 이동. side=null → target 과 스왑, side=방향 → target 을 그 방향으로 분할해 삽입.
//  기존 leaf 객체를 재사용하므로 PaneView(iframe/에디터 상태)가 보존된다.
//  반환: { tree, movedId }.
export function moveLeaf(root, srcId, targetId, side) {
  if (srcId === targetId) return { tree: root, movedId: null };
  const src = findLeaf(root, srcId);
  if (!src) return { tree: root, movedId: null };
  if (!side) return { tree: swapLeaves(root, srcId, targetId), movedId: srcId };
  const removed = closeLeaf(root, srcId).tree;
  if (!removed) return { tree: root, movedId: null };
  const dir = side === "left" || side === "right" ? "h" : "v";
  const before = side === "left" || side === "top";
  const r = split(removed, targetId, dir, src, before);
  return { tree: r.tree, movedId: src.id };
}

export function firstLeafId(node) {
  let id = null;
  eachLeaf(node, (l) => {
    if (id == null) id = l.id;
  });
  return id;
}

// branch 의 ratio 갱신(드래그 리사이즈). 불변 갱신.
export function setRatio(root, branchPath, ratio) {
  // branchPath: 루트부터 'first'|'second' 배열. 여기선 노드 참조 대신 경로로 안전 갱신.
  function rec(node, i) {
    if (isLeaf(node)) return node;
    if (i === branchPath.length) return { ...node, ratio: clamp(ratio, 0.1, 0.9) };
    const key = branchPath[i];
    return { ...node, [key]: rec(node[key], i + 1) };
  }
  return rec(root, 0);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// src leaf 제거(형제 승격) 후 dst leaf 가 차지할 rect 예측 — 드래그 "예상 위치" 표시용.
//  드랍이 src pane 을 없애는 경우(단일 탭 이동, pane 통째 이동/편입) 예상 존을 제거 전 rect 로
//  그리면 실제 결과(형제가 src 자리까지 확장)와 어긋난다. 측정된 현재 rect 만으로 계산:
//  형제 서브트리가 부모 branch 영역 전체(형제 ∪ src)로 늘어난다고 보고 dst rect 를 아핀 스케일.
//  dst 가 형제 서브트리 밖이면 변화 없음. rectOf(id) → {x,y,w,h}|null.
export function rectAfterRemoval(root, srcId, dstId, rectOf) {
  const dst = rectOf(dstId) || null;
  if (!root || !dst || srcId === dstId) return dst;
  let sibling = null;
  (function walk(node) {
    if (sibling || isLeaf(node)) return;
    if (isLeaf(node.first) && node.first.id === srcId) { sibling = node.second; return; }
    if (isLeaf(node.second) && node.second.id === srcId) { sibling = node.first; return; }
    walk(node.first);
    walk(node.second);
  })(root);
  if (!sibling) return dst; // src 가 루트(마지막 pane)거나 트리에 없음
  const sibIds = leafIds(sibling);
  if (!sibIds.includes(dstId)) return dst;
  const union = (ids) => {
    let u = null;
    for (const id of ids) {
      const q = rectOf(id);
      if (!q || q.w <= 0 || q.h <= 0) continue;
      u = u
        ? { x: Math.min(u.x, q.x), y: Math.min(u.y, q.y), x2: Math.max(u.x2, q.x + q.w), y2: Math.max(u.y2, q.y + q.h) }
        : { x: q.x, y: q.y, x2: q.x + q.w, y2: q.y + q.h };
    }
    return u;
  };
  const sib = union(sibIds);
  const par = union([...sibIds, srcId]); // 부모 영역 = 형제 ∪ src
  if (!sib || !par || sib.x2 - sib.x <= 0 || sib.y2 - sib.y <= 0) return dst;
  const sx = (par.x2 - par.x) / (sib.x2 - sib.x);
  const sy = (par.y2 - par.y) / (sib.y2 - sib.y);
  return {
    x: par.x + (dst.x - sib.x) * sx,
    y: par.y + (dst.y - sib.y) * sy,
    w: dst.w * sx,
    h: dst.h * sy,
  };
}

// 방향 이동(⌥⌘화살표) — 렌더된 rect 를 받아 가장 가까운 leaf 로 포커스.
//  dir: 'left'|'right'|'up'|'down'. rects: { id: {x,y,w,h} }.
export function neighbor(rects, fromId, dir) {
  const from = rects[fromId];
  if (!from) return null;
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  let best = null;
  let bestScore = Infinity;
  for (const [id, r] of Object.entries(rects)) {
    if (id === fromId) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = cx - fcx;
    const dy = cy - fcy;
    let ok = false;
    if (dir === "left") ok = dx < -1 && Math.abs(dy) <= Math.max(from.h, r.h);
    else if (dir === "right") ok = dx > 1 && Math.abs(dy) <= Math.max(from.h, r.h);
    else if (dir === "up") ok = dy < -1 && Math.abs(dx) <= Math.max(from.w, r.w);
    else if (dir === "down") ok = dy > 1 && Math.abs(dx) <= Math.max(from.w, r.w);
    if (!ok) continue;
    const score = Math.abs(dx) + Math.abs(dy);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}
