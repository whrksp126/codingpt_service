// term-links.js — 터미널 화면의 주소·파일 경로를 누를 수 있게 한다(2026-10-06 사용자 요청).
//  · OSC 8 하이퍼링크(에이전트 CLI 가 밑줄로 그리는 것) = xterm 의 linkHandler 로 받는다 — 기본 동작(window.open)은
//    웹뷰에서 아무 일도 하지 않아 "누를 수 있게 생겼는데 안 눌린다" 였다.
//  · 맨 글자 주소·경로 = 줄에서 찾아 링크로 만든다(registerLinkProvider).
//  여는 곳은 채팅과 같다: http(s) → 이 워크스페이스의 브라우저 pane, 파일 → IDE. ⌘/Ctrl+클릭과 그 밖의 스킴만 시스템에 맡긴다.

const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
// 경로 — 폴더 구분자가 하나 이상 있고 확장자로 끝나는 것만(낱말 오탐 방지). 뒤에 :줄번호[:열] 허용.
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
const TRAIL = /[.,;:!?\]}'"]+$/;

/** 한 줄 글에서 링크 후보를 찾는다 → [{ start, end, text, kind: "url"|"path" }] (end 는 포함하지 않는 끝). 순수. */
export function findLinks(text) {
  const out = [];
  const s = String(text || "");
  const taken = [];
  for (const m of s.matchAll(URL_RE)) {
    // 끝의 문장부호를 뗀다. 닫는 괄호는 여는 괄호보다 많을 때만(문장의 괄호) — 주소 안의 짝 맞는 괄호는 둔다.
    let t = m[0];
    for (;;) {
      const cut = t.replace(TRAIL, "");
      if (cut !== t) { t = cut; continue; }
      if (t.endsWith(")") && (t.match(/\)/g) || []).length > (t.match(/\(/g) || []).length) { t = t.slice(0, -1); continue; }
      break;
    }
    if (t.length < 10) continue;
    out.push({ start: m.index, end: m.index + t.length, text: t, kind: "url" });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of s.matchAll(PATH_RE)) {
    const a = m.index; const b = a + m[0].length;
    if (taken.some(([x, y]) => a < y && b > x)) continue;       // 주소 안의 경로 조각
    if (a > 0 && /[\w@]/.test(s[a - 1])) continue;               // 낱말 중간에서 시작
    out.push({ start: a, end: b, text: m[0], kind: "path" });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** "src/a.js:12:3" → { path, line }. file:// 주소도 받는다. */
export function splitPathLine(raw) {
  let p = String(raw || "");
  if (/^file:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { p = p.replace(/^file:\/\//i, ""); } }
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(p);
  return m ? { path: m[1], line: Number(m[2]) } : { path: p, line: null };
}

/**
 * xterm 에 붙인다. open = { url(href, event), path(path, line, event) }.
 *  문자열 위치 → 셀 열 변환을 직접 한다(한글 같은 2칸 글자가 앞에 있으면 글자 수와 열이 어긋난다).
 */
export function attachTermLinks(term, open) {
  if (!term || typeof term.registerLinkProvider !== "function") return null;
  return term.registerLinkProvider({
    provideLinks(y, cb) {
      let line = null;
      try { line = term.buffer.active.getLine(y - 1); } catch (_) { line = null; }
      if (!line) { cb(undefined); return; }
      let text = ""; const colOf = [];   // colOf[문자열 인덱스] = 셀 열(0부터)
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;   // 2칸 글자의 뒤 칸
        const ch = cell.getChars() || " ";
        for (let i = 0; i < ch.length; i++) colOf.push(x);
        text += ch;
      }
      const found = findLinks(text.replace(/\s+$/, ""));
      if (!found.length) { cb(undefined); return; }
      cb(found.map((f) => ({
        range: { start: { x: colOf[f.start] + 1, y }, end: { x: colOf[f.end - 1] + 1, y } },
        text: f.text,
        decorations: { underline: true, pointerCursor: true },
        activate: (e, t) => {
          if (f.kind === "url") open.url(t, e);
          else { const pl = splitPathLine(t); open.path(pl.path, pl.line, e); }
        },
      })));
    },
  });
}
