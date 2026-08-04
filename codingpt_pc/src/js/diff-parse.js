// 통합 diff(unified diff) 파싱 — 순수 판정.
//
// ⚠ 앱(codingpt_app/src/workspace/ide/diffParse.ts)에 같은 구현이 있고 **대조 테스트가 걸려 있다**.
//   리뷰 화면은 "몇 번째 덩어리를 승인했다"를 그대로 에이전트에게 돌려주므로, 두 기기가 덩어리를
//   다르게 세면 **엉뚱한 곳을 승인한 결과**가 간다. 이건 화면이 예뻐지고 말고의 문제가 아니다.
//
// 규율:
//  · 덩어리(hunk) 번호는 **파일 안에서 0부터, 나타난 순서대로**다. 이 번호가 에이전트와 주고받는
//    유일한 식별자라 파싱이 흔들리면 안 된다.
//  · 못 읽는 줄은 버리지 않고 'ctx' 로 둔다 — 원문을 조용히 삭제하면 사용자가 못 본 변경이 생긴다.
//  · git 의 `\ No newline at end of file` 은 표시용 메타다(변경 줄로 세지 않는다).

/**
 * @typedef {{ type:'ctx'|'add'|'del'|'meta', text:string, oldNo:number|null, newNo:number|null }} DiffLine
 * @typedef {{ index:number, header:string, oldStart:number, newStart:number, lines:DiffLine[],
 *             adds:number, dels:number }} DiffHunk
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * 한 파일의 통합 diff → 덩어리 목록.
 *  `git diff` 가 주는 헤더(diff --git / index / --- / +++)는 건너뛴다.
 */
export function parseHunks(diffText) {
  const lines = String(diffText == null ? "" : diffText).split("\n");
  // ★ `split("\n")` 은 **끝의 개행 때문에 빈 원소를 하나 더** 만든다. 그걸 줄로 세면 문맥 줄이
  //   하나 더 생겨 그 뒤 줄 번호가 전부 1씩 밀린다 — 코멘트 좌표가 통째로 어긋나 에이전트가
  //   엉뚱한 줄을 고친다. (실제 `git diff` 출력으로 잡힌 결함: 파일 18개 중 마지막 덩어리가 전부
  //   1씩 밀려 있었다. 인위적 샘플만 봤으면 두 구현이 **똑같이 틀린 채** 지나갔다.)
  //   가운데의 진짜 빈 줄은 그대로 둔다 — 마지막 하나만 버린다.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const hunks = [];
  let cur = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      cur = {
        index: hunks.length,
        header: raw,
        oldStart: parseInt(m[1], 10) || 0,
        newStart: parseInt(m[3], 10) || 0,
        lines: [],
        adds: 0,
        dels: 0,
      };
      oldNo = cur.oldStart;
      newNo = cur.newStart;
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;                       // 덩어리 시작 전의 파일 헤더는 화면에 필요 없다
    if (raw.startsWith("\\")) {               // `\ No newline at end of file`
      cur.lines.push({ type: "meta", text: raw.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }
    const c = raw[0];
    const body = raw.length ? raw.slice(1) : "";
    if (c === "+") {
      cur.lines.push({ type: "add", text: body, oldNo: null, newNo });
      newNo++; cur.adds++;
    } else if (c === "-") {
      cur.lines.push({ type: "del", text: body, oldNo, newNo: null });
      oldNo++; cur.dels++;
    } else {
      // ' ' 문맥 줄. 빈 줄(길이 0)도 문맥이다 — 버리면 줄 번호가 어긋난다.
      cur.lines.push({ type: "ctx", text: c === " " ? body : raw, oldNo, newNo });
      oldNo++; newNo++;
    }
  }
  return hunks;
}

/** 파일 하나의 요약 — 목록/헤더에 쓴다. */
export function summarize(diffText) {
  const hunks = parseHunks(diffText);
  let adds = 0;
  let dels = 0;
  for (const h of hunks) { adds += h.adds; dels += h.dels; }
  return { hunks: hunks.length, adds, dels };
}

/**
 * 코멘트를 달 수 있는 줄인가 — **바뀐 줄만**이다.
 *  문맥 줄에 단 코멘트는 "무엇에 대한 말인지"가 모호하고, 에이전트가 받아도 고칠 곳을 못 찾는다.
 */
export function isCommentable(line) {
  return !!line && (line.type === "add" || line.type === "del");
}

/** 코멘트가 가리키는 위치 — 에이전트가 파일에서 찾을 수 있는 좌표로 준다. */
export function anchorOf(line) {
  if (!line) return null;
  if (line.type === "add") return { side: "new", line: line.newNo };
  if (line.type === "del") return { side: "old", line: line.oldNo };
  return null;
}

/**
 * 리뷰 결과 → 에이전트에게 돌려줄 모양.
 *  파일 판정은 **덩어리 판정에서 파생**한다(따로 저장하지 않는다 — 둘이 어긋나면 어느 쪽이
 *  진실인지 알 수 없다):
 *   · 덩어리가 하나라도 거절이면 'rejected'
 *   · 전부 승인이면 'approved'
 *   · 아직 안 정한 게 있으면 'partial'
 * @param {{path:string, hunks:number}[]} files
 * @param {Record<string, 'approve'|'reject'>} decisions  키 = `${path}#${hunkIndex}`
 */
export function fileVerdict(file, decisions) {
  const n = file && file.hunks ? file.hunks : 0;
  if (!n) return "approved";                  // 덩어리가 없으면(빈 diff) 볼 것이 없다
  let approved = 0;
  let rejected = 0;
  for (let i = 0; i < n; i++) {
    const d = decisions ? decisions[`${file.path}#${i}`] : null;
    if (d === "approve") approved++;
    else if (d === "reject") rejected++;
  }
  if (rejected) return "rejected";
  if (approved === n) return "approved";
  return "partial";
}

/** 전부 정했는가 — "보내기"를 켤지 판정한다(안 정한 채 보내면 에이전트가 뭘 할지 모른다). */
export function allDecided(files, decisions) {
  for (const f of files || []) {
    for (let i = 0; i < (f.hunks || 0); i++) {
      const d = decisions ? decisions[`${f.path}#${i}`] : null;
      if (d !== "approve" && d !== "reject") return false;
    }
  }
  return true;
}

/** 아직 안 정한 덩어리의 수(푸터에 남은 개수를 보여 준다). */
export function undecidedCount(files, decisions) {
  let n = 0;
  for (const f of files || []) {
    for (let i = 0; i < (f.hunks || 0); i++) {
      const d = decisions ? decisions[`${f.path}#${i}`] : null;
      if (d !== "approve" && d !== "reject") n++;
    }
  }
  return n;
}

/**
 * 제출 페이로드 — 에이전트가 그대로 읽는 모양.
 *  코멘트는 **모아서 한 번에** 간다(사용자 확정) — 한 줄 달 때마다 에이전트를 깨우면
 *  작업이 계속 끊긴다.
 */
export function buildSubmission(files, decisions, comments, note) {
  return {
    files: (files || []).map((f) => ({
      path: f.path,
      verdict: fileVerdict(f, decisions),
      hunks: Array.from({ length: f.hunks || 0 }, (_, i) => ({
        index: i,
        decision: (decisions && decisions[`${f.path}#${i}`]) || "skipped",
      })),
      comments: (comments || [])
        .filter((c) => c.path === f.path)
        .map((c) => ({ hunk: c.hunk, side: c.side, line: c.line, text: c.text })),
    })),
    note: typeof note === "string" && note.trim() ? note.trim() : undefined,
  };
}
