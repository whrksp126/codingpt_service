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

// leaf: 터미널 pane 은 탭 배열(각 탭=tmux window). 프리뷰/IDE 는 url.
export function leaf(kind, opts = {}) {
  if (kind === "preview" || kind === "ide") return { id: newPaneId(), kind, url: opts.url || null };
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
