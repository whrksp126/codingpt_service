// 팔레트 검색 — 입력 해석과 점수 매기기(순수 판정).
//
// ⚠ 앱(codingpt_app/src/palette/match.ts)에 같은 구현이 있고 **대조 테스트가 걸려 있다**.
//   같은 글자를 쳤을 때 PC 와 폰에서 다른 순서가 나오면 "내 파일이 어디 갔지"가 된다.
//
// 규율:
//  · 점수는 **정수**다. 실수 연산은 두 언어에서 미세하게 갈릴 수 있고, 그 차이가 동점 처리에서
//    순서를 뒤집는다.
//  · 동점은 반드시 **결정적으로** 깬다(짧은 것 → 사전순). 안 그러면 같은 입력에 목록이 흔들린다.
//  · 매칭은 부분수열(fuzzy)이다. 다만 **연속**과 **경계**(/, -, _, ., 공백 뒤, 맨 앞)에 큰 가산점을
//    줘서 `wsv` 가 `WorkspaceView` 를 잡되 아무 데나 흩어진 우연한 일치는 뒤로 밀리게 한다.

/** 팔레트 입력의 두 모드. 접두어 `>` 하나로 갈린다(사용자 확정: 창은 하나). */
export const MODE_FILE = "file";
export const MODE_COMMAND = "command";

/**
 * 입력 → { mode, term }.
 *  `>` 로 시작하면 명령 모드. 그 외는 파일 모드(열린 탭 + 파일).
 */
export function parseQuery(raw) {
  const s = String(raw == null ? "" : raw);
  if (s.trimStart().startsWith(">")) {
    return { mode: MODE_COMMAND, term: s.trimStart().slice(1).trim() };
  }
  return { mode: MODE_FILE, term: s.trim() };
}

const BOUNDARY = "/-_. \\";

/**
 * 여기서 낱말이 시작되는가.
 *  구분자 뒤(`workspace-view` 의 v)뿐 아니라 **camelCase 의 대문자**(`WorkspaceView` 의 V)도
 *  낱말의 시작이다. 이걸 빼면 `wsv` 가 `WorkspaceView.tsx` 를 못 잡는다(실측으로 확인 — 대시가
 *  있는 `workspace-view.js` 만 가산점을 받아 위로 올라갔다).
 *  `orig` 은 **대소문자를 지운 문자열이 아니어야** 한다 — 판정에 원본 글자가 필요하다.
 */
export function isWordStart(orig, low, idx) {
  if (idx <= 0) return true;
  if (BOUNDARY.indexOf(low[idx - 1]) >= 0) return true;
  const c = orig[idx];
  const p = orig[idx - 1];
  return c >= "A" && c <= "Z" && p >= "a" && p <= "z";
}

/**
 * 부분수열 점수. 안 맞으면 null(0 이 아니다 — 0 은 "빈 검색어"라는 유효한 점수다).
 *  · 연속 +8 / 낱말 시작 +6 / 그냥 맞음 +1
 *  · 첫 일치가 뒤일수록 감점(최대 20) — 앞에서 맞는 게 대개 사용자가 찾던 것이다.
 */
export function fuzzyScore(text, term) {
  const orig = String(text == null ? "" : text);
  const t = orig.toLowerCase();
  const q = String(term == null ? "" : term).toLowerCase();
  if (!q) return 0;
  let from = 0;
  let score = 0;
  let prev = -2;
  let first = -1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === " ") continue;                  // 공백은 구분자로 무시("ws view" == "wsview")
    const idx = t.indexOf(c, from);
    if (idx < 0) return null;
    if (first < 0) first = idx;
    score += idx === prev + 1 ? 8 : 1;
    if (isWordStart(orig, t, idx)) score += 6;
    prev = idx;
    from = idx + 1;
  }
  if (first < 0) return 0;                    // 검색어가 공백뿐
  return score - Math.min(first, 20);
}

/** 경로 점수 — 파일명 일치를 경로 전체 일치보다 위로(사람은 파일명을 친다). */
export function scorePath(path, term) {
  const p = String(path == null ? "" : path);
  const base = p.split("/").pop() || p;
  const b = fuzzyScore(base, term);
  const f = fuzzyScore(p, term);
  if (b == null && f == null) return null;
  if (b == null) return f;
  const withBonus = b + 12;
  return f == null || f < withBonus ? withBonus : f;
}

/**
 * 동점 깨기 — 점수 내림차순 → 정렬키 짧은 것 → 사전순.
 *  `items` 는 `{ score, sortKey }` 를 가진 것들이다. 원본을 건드리지 않는다.
 */
export function rankByScore(items) {
  return items.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ak = String(a.sortKey || "");
    const bk = String(b.sortKey || "");
    if (ak.length !== bk.length) return ak.length - bk.length;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

/**
 * 점수가 붙은 행들을 걸러 정렬하되, **검색어가 비면 원래 순서를 지킨다**.
 *  rankPaths 와 같은 규율이다 — 열린 탭·명령은 화면(또는 표)의 순서가 곧 사용자의 심상이라,
 *  아무것도 안 친 상태에서 이름 길이순으로 다시 줄 세우면 "왜 순서가 이렇지"가 된다.
 *  (실제로 하네스에서 잡혔다: 빈 검색어인데 `IDE` 가 `claude` 앞으로 올라갔다.)
 */
export function rankRows(rows, term, limit) {
  const cap = typeof limit === "number" ? limit : 50;
  const list = Array.isArray(rows) ? rows : [];
  if (!String(term || "").trim()) return list.slice(0, cap);
  return rankByScore(list).slice(0, cap);
}

/**
 * 파일 목록 걸러 정렬. `paths` 는 워크스페이스 루트 기준 상대경로.
 *  검색어가 비면 **자르기만 한다**(정렬을 흔들지 않는다 — 트리 순서가 곧 사용자의 심상이다).
 */
export function rankPaths(paths, term, limit) {
  const cap = typeof limit === "number" ? limit : 50;
  const list = Array.isArray(paths) ? paths : [];
  if (!String(term || "").trim()) return list.slice(0, cap);
  const scored = [];
  for (const p of list) {
    const s = scorePath(p, term);
    if (s == null) continue;
    scored.push({ score: s, sortKey: p, path: p });
  }
  return rankByScore(scored).slice(0, cap).map((r) => r.path);
}

/**
 * 명령/탭처럼 **이름 + 검색 보조어**를 가진 항목의 점수.
 *  보조어(keywords)로도 찾을 수 있게 하되, 이름으로 맞은 것이 항상 위다(보조어 일치는 감점).
 */
export function scoreLabeled(label, keywords, term) {
  if (!String(term || "").trim()) return 0;
  const l = fuzzyScore(label, term);
  if (l != null) return l;
  const k = fuzzyScore(keywords || "", term);
  if (k == null) return null;
  return k - 30;
}
