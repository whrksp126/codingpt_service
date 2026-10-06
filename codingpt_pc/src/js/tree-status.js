// tree-status.js — 파일 트리의 git 표시(변경 글자 · 무시 흐림). 순수 로직 — node 테스트가 직접 돌린다.
//  데몬 `git.files` 결과({ repo, entries:[{path,status}], ignored:[path] }, 경로 = 트리 루트 기준 상대)를
//  행마다 O(1) 로 물을 수 있는 표로 바꾼다. 표시 규칙은 Orca/VS Code 와 같다:
//   · 파일 = 제 상태 글자(M 수정 · A 추가 · D 삭제 · R 이름 변경 · C 복사 · U 추적 안 함 · ! 충돌)
//   · 폴더 = 안에 있는 변경 중 가장 센 것(삭제 > 수정 > 추가·추적 안 함 > 이름 변경 > 복사)
//   · 폴더째 추적 안 함(`dir/`)이면 그 안의 모든 것이 U, 무시된 것(.gitignore)은 흐리게.
const PRIORITY = { "!": 6, D: 5, M: 4, A: 3, U: 3, R: 2, C: 1 };
const stronger = (a, b) => (!a ? b : !b ? a : (PRIORITY[b] || 0) > (PRIORITY[a] || 0) ? b : a);

/** → { repo, file:Map(rel→글자), folder:Map(rel→글자), dirs:[[prefix, 글자]], ignored:Set(rel), ignoredDirs:[prefix] } */
export function buildTreeStatus(res) {
  const out = { repo: !!(res && res.repo), branch: (res && res.branch) || null, file: new Map(), folder: new Map(), dirs: [], ignored: new Set(), ignoredDirs: [] };
  if (!out.repo) return out;
  for (const e of res.entries || []) {
    const p = String(e.path || "");
    if (!p) continue;
    const isDir = p.endsWith("/");
    const clean = isDir ? p.slice(0, -1) : p;
    if (isDir) { out.dirs.push([p, e.status]); out.folder.set(clean, stronger(out.folder.get(clean), e.status)); }
    else out.file.set(clean, stronger(out.file.get(clean), e.status));
    const segs = clean.split("/");
    for (let i = 1; i < segs.length; i++) { const d = segs.slice(0, i).join("/"); out.folder.set(d, stronger(out.folder.get(d), e.status)); }
  }
  for (const p of res.ignored || []) {
    const s = String(p || "");
    if (!s) continue;
    if (s.endsWith("/")) { out.ignoredDirs.push(s); out.ignored.add(s.slice(0, -1)); } else out.ignored.add(s);
  }
  return out;
}

/** 그 행의 표시 → { letter: 글자|"" , ignored: bool }. rel = 트리 루트 기준 상대 경로. */
export function statusOf(st, rel, isDir) {
  if (!st || !st.repo || !rel) return { letter: "", ignored: false };
  if (st.ignored.has(rel) || st.ignoredDirs.some((d) => rel.startsWith(d))) return { letter: "", ignored: true };
  let letter = (isDir ? st.folder.get(rel) : st.file.get(rel)) || "";
  if (!letter) for (const [d, s] of st.dirs) if (rel.startsWith(d)) { letter = s; break; }
  return { letter, ignored: false };
}

/** 표시 서명 — 바뀐 때만 트리를 다시 그린다. */
export function statusSig(res) {
  if (!res || !res.repo) return "";
  return (res.entries || []).map((e) => e.status + e.path).sort().join("\n") + "\n--\n" + (res.ignored || []).slice().sort().join("\n");
}

/**
 * 여러 개 선택 — 보이는 행 순서(rows: 경로 배열)에서의 선택 계산. 순수 함수.
 *  click(sel, path, { meta, shift }) → { paths:Set, anchor }
 *   · 그냥 누르면 그 하나, ⌘ = 넣다 뺐다, ⇧ = 기준(anchor)부터 거기까지.
 */
export function clickSelect(rows, sel, path, mods = {}) {
  const cur = new Set(sel.paths || []);
  if (mods.shift && sel.anchor && rows.includes(sel.anchor) && rows.includes(path)) {
    const a = rows.indexOf(sel.anchor); const b = rows.indexOf(path);
    return { paths: new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1)), anchor: sel.anchor };
  }
  if (mods.meta) {
    if (cur.has(path) && cur.size > 1) cur.delete(path); else cur.add(path);
    return { paths: cur, anchor: path };
  }
  return { paths: new Set([path]), anchor: path };
}
/** 선택에서 "다른 선택의 안에 있는 것" 을 뺀다 — 폴더와 그 안 파일을 같이 골라도 한 번만 옮기고·지운다. */
export function topLevel(paths) {
  const list = [...paths].sort();
  return list.filter((p) => !list.some((q) => q !== p && p.startsWith(q + "/")));
}
