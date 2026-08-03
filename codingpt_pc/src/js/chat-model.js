// chat-model.js — 채팅(트랜스크립트) 렌더 "규칙" 한 벌. DOM 을 만들지 않는 순수 모듈.
//
// ⚠ 모바일 `codingpt_app/src/workspace/chatModel.ts` 와 **동시 수정 대상**이다.
//   (선례: 터미널 키 시퀀스 규칙이 KeyAssist.tsx ↔ pane.js 로 이원화돼 드리프트가 났던 사고 —
//    한쪽만 고치면 같은 대화가 PC/폰에서 다르게 보인다.)
//
// 소비하는 와이어 = 데몬 `runner-core/transcript.js` 의 정규화 ChatMsg. **설계서 §2.1 의 초안이 아니라
// 데몬이 실제로 내보내는 모양이 정본**이다(구현이 실측으로 바뀐 부분이 있다):
//   { seq, ts, role:'user'|'assistant'|'system',
//     kind:'text'|'thinking'|'tool_use'|'tool_result'|'question'|'slash'|'interrupt'
//          |'compact'|'divider'|'system'|'meta'|'unknown',
//     text, truncated, hidden,
//     tool?:{ id, name, title, argsPreview?, path?, lang?, argsBytes? },
//     result?:{ toolUseId, ok, preview, bytes, lines, truncated, images },
//     question?:{ header, question, options:[{label,description}], multiSelect },
//     attachments?:[{idx,mediaType,bytes}], meta?, model?, agentId?, isSidechain? }
//
// seq = 라인오프셋*1000+블록인덱스 (단조 증가·멱등 워터마크). 이 값을 DOM key 로 쓴다.

// ── 임계값(양 플랫폼 동일하게 유지) ──
export const CHAT = {
  SNAPSHOT_LIMIT: 200,     // chat.open limit
  AT_BOTTOM_PX: 48,        // 이 이내면 "맨 아래" → 새 메시지 자동 스크롤
  OUTPUT_CLAMP_LINES: 6,   // tool 결과 본문 접힘 줄수
  PATCH_CLAMP_LINES: 12,   // 편집 diff 접힘 줄수(넘으면 '더 보기')
  THINKING_CHARS: 120,     // thinking 접힘 글자수
  MAX_MSGS: 1200,          // 로컬 버퍼 상한(오래된 것부터 버림 — 과거는 "이전 대화 더 보기")
  DRAFT_MAX: 4096,         // 컴포저 초안 영속 상한
  SEND_ENTER_DELAY_MS: 90, // paste 후 Enter 분리 전송(TUI 가 paste 종료 마커 전에 처리하는 것 방지)
  CMD_MAX: 60,             // 슬래시 팔레트에 한 번에 그리는 최대 행수(검색으로 좁혀 쓰는 전제)
  PICK_LIMIT: 200,         // 컴포저 `+` 파일 목록에 한 번에 그리는 최대 행수(필터로 좁혀 쓰는 전제)
  POLL_MS: 4000,           // 캐치업 폴링 주기(push 가 살아 있으면 사실상 no-op)
  // 제출 직후 화면(선택 화면 카드·상태줄) 확인 연쇄(ms). 데몬 status-line.POKE_BURST_MS 와 같은 목적.
  //  근거(격리 tmux 실측 2026-08-03): claude 는 제출 51ms 뒤에 이미 `/model` 선택 화면을 그린다 —
  //  늦은 건 CLI 가 아니라 우리 폴링뿐이었다. 앱 useChatStream.SCREEN_BURST_MS 와 같은 값.
  SCREEN_BURST_MS: [120, 260, 450, 700, 1000, 1500, 2200],
  OPEN_FAIL_RETRY_MS: 8000,// 열기 **실패**(오류) 후 재시도 간격
  NO_SESSION_IDLE_MS: 30000, // 열기 성공 + noSession(정상 상태) 일 때의 느린 재확인 간격
  NO_SESSION_PROBE_MS: 30000, // 첫 메시지 전송 후 "훅이 바인딩을 만들었는지" 짧게 탐색하는 창
};


// ── 슬래시 명령 팔레트(TUI 의 `/` 목록) — app 미러: chatModel.ts slashQuery/filterCommands ────────
// 여는 조건과 정렬을 **양 플랫폼이 같은 함수로** 판정한다(한쪽만 고치면 폰/PC 가 다르게 뜬다).
//  · 여는 조건 = 초안 전체가 `/토큰` 한 개(공백을 치면 인자 모드 → 닫는다). TUI 팝업과 같은 감각.
//  · 정렬 = 접두사 일치 먼저, 그다음 부분 일치. 목록 자체의 순서(프로젝트→개인→빌트인)는 데몬이 준다.
export function slashQuery(text) {
  // ⚠ trim() 을 쓰지 않는다: 뒤 공백은 "인자를 치기 시작했다"는 신호라 팔레트가 **닫혀야** 한다
  //  (`/dep ` 에서 목록이 계속 떠 있으면 Enter 가 전송이 아니라 채워넣기로 가로채인다).
  const m = /^\s*\/([A-Za-z0-9:_-]*)$/.exec(String(text == null ? "" : text));
  return m ? m[1] : null;
}

export function filterCommands(items, q, max) {
  const all = Array.isArray(items) ? items : [];
  const s = String(q || "").toLowerCase();
  const cap = max || CHAT.CMD_MAX;
  if (!s) return all.slice(0, cap);
  const pre = [];
  const rest = [];
  for (const c of all) {
    const n = String(c.name || "").slice(1).toLowerCase();
    if (n.startsWith(s)) pre.push(c);
    else if (n.includes(s)) rest.push(c);
  }
  return pre.concat(rest).slice(0, cap);
}

/** 팔레트 행 배지 — 출처/제약을 한 단어로. 없으면 빈 배열. */
export function commandBadges(cmd) {
  const out = [];
  if (!cmd) return out;
  if (cmd.source === "project") out.push("프로젝트");
  else if (cmd.source === "user") out.push("내 것");
  if (cmd.chat === "dialog") out.push("선택 화면");
  if (cmd.chat === "tui") out.push("터미널에서");
  return out;
}

// 에이전트 판정에 쓰는 명령 이름 — 리컨실러가 채우는 tab.cmd(pane_current_command)와 대조.
export const AGENT_CMD_RE = /^(claude|codex|gemini)$/i;

// ── 끝난 도구 행 묶기(TUI 미러) — app 미러: chatModel.ts TOOL_GROUP_MIN/toolRunLabel ─────────
// TUI 는 연속으로 끝난 도구 호출을 한 줄로 접는다("Called claude-in-chrome 6 times, ran 5 shell
//  commands"). 채팅이 한 줄짜리 도구 행을 열몇 개씩 쌓으면 정작 읽어야 할 본문이 묻힌다
//  (2026-08-02 사용자 지적). 진행 중 도구·질문 행은 절대 접지 않는다.
export const TOOL_GROUP_MIN = 4;

function toolRunName(name) {
  const n = String(name || "").trim();
  if (!n) return "도구";
  if (n === "Bash" || n === "shell") return "셸";
  if (n === "Edit" || n === "Write" || n === "MultiEdit" || n === "apply_patch") return "편집";
  if (n === "Read" || n === "NotebookRead") return "읽기";
  if (n === "Grep" || n === "Glob" || n === "Search") return "검색";
  if (n.startsWith("mcp__")) return n.split("__")[1] || n;
  return n;
}

/** 도구 이름 배열 → "claude-in-chrome 6 · 셸 5"(많은 순, 최대 3종). */
export function toolRunLabel(names) {
  const count = new Map();
  for (const nm of names || []) {
    const k = toolRunName(nm);
    count.set(k, (count.get(k) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.map(([k, n]) => `${k} ${n}`).join(" · ") + (count.size > 3 ? " 외" : "");
}

// ── 편집 diff(TUI 미러) — app 미러: chatModel.ts patchLines ────────────────────────────────
// 데몬이 claude 의 structuredPatch 를 그대로 실어 준다(result.patch). TUI 는 이걸 초록/빨강으로
//  그리는데, 채팅은 예전엔 "The file … updated successfully" 문구만 보여줬다(정보 0 — 사용자 지적).
//  여기서는 **행 목록**으로만 바꾸고(순수), 색·박스는 각 플랫폼이 그린다.
//  줄 번호는 헌크의 oldStart/newStart 에서 증가시킨다(삭제행은 old 만, 추가행은 new 만 증가).
export function patchLines(patch, limit) {
  const hunks = (patch && Array.isArray(patch.hunks)) ? patch.hunks : [];
  const out = [];
  const cap = limit || 200;
  for (const h of hunks) {
    let oldNo = h.oldStart || 0;
    let newNo = h.newStart || 0;
    if (out.length) out.push({ type: "gap", text: "⋯", no: null });
    for (const raw of (h.lines || [])) {
      if (out.length >= cap) return { lines: out, more: true };
      const sign = raw.charAt(0);
      const text = raw.slice(1);
      if (sign === "+") out.push({ type: "add", text, no: newNo++ });
      else if (sign === "-") out.push({ type: "del", text, no: oldNo++ });
      else { out.push({ type: "ctx", text, no: newNo }); oldNo++; newNo++; }
    }
  }
  return { lines: out, more: !!(patch && patch.truncated) };
}

// ── 대화에 적힌 파일(이미지/영상/문서) 표현 규칙 — app 미러: chatModel.ts mediaRefOf ─────────────
// 사용자 확정(2026-08-02): **의도 판별은 마크다운 문법이 이미 해준다.**
//  · `![라벨](경로)` = "그려라"(이미지 문법을 고른 것 자체가 의사표시) → 실제로 띄운다.
//  · `[라벨](경로)` · 맨 경로 = 참조 → **칩**으로만(자동 로드 안 함, 누르면 열림).
//  그리고 어느 쪽이든 **경로를 화면에 남긴다** → "경로를 보여주려던 의도"였어도 잃는 정보가 0이다
//  (오판 비용 0 = 이 규칙을 고른 이유). TUI 는 경로 텍스트, 채팅은 그림+경로 = 상위집합.
const MEDIA_EXT = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "svg"],
  video: ["mp4", "m4v", "mov", "webm"],
};

/** 타깃 문자열 → { via:'url'|'path', kind:'image'|'video'|'file', name, ext }. 빈 값이면 null. */
export function mediaRefOf(target) {
  const raw = String(target == null ? "" : target).trim();
  if (!raw) return null;
  const url = /^(https?:)?\/\//i.test(raw) || raw.startsWith("data:");
  // 쿼리/해시를 뺀 뒤 확장자를 본다(URL 에 ?v=1 이 붙는 경우).
  const clean = raw.split(/[?#]/)[0];
  const base = clean.replace(/\/+$/, "").split("/").pop() || clean;
  const ext = (base.includes(".") ? base.split(".").pop() : "").toLowerCase();
  const kind = MEDIA_EXT.image.includes(ext) ? "image" : MEDIA_EXT.video.includes(ext) ? "video" : "file";
  return { via: url ? "url" : "path", kind, name: base || raw, ext, target: raw };
}

// ── 에이전트 권한 모드 카탈로그(양 플랫폼 동일 — app 미러: chatModel.ts AGENT_MODES) ──────────
// TUI 에서 shift+tab 으로만 바꿀 수 있는 그 모드다. 채팅에서는 컴포저 알약 → 목록으로 고르고,
//  데몬이 TUI 를 대신 순환시킨다(runner-core/cpt-server.js chatMode).
//  · label = **TUI 원문 그대로**(사용자 확정 2026-08-01) — 화면과 채팅이 같은 단어를 쓰게. 번역 금지.
//  · desc  = 한 줄 설명(우리 문장) — 원문 라벨만으로는 무엇이 자동인지 알 수 없어서 곁들인다.
//  · bypassPermissions 는 `--dangerously-skip-permissions` 로 띄운 세션에만 있으므로 목록에서
//    숨긴다(hidden). 지금 그 모드면 현재 항목으로만 보인다 — 없는 선택지를 눌러 실패시키지 않는다.
export const AGENT_MODES = [
  { id: "default", symbol: "⏸", label: "manual mode on", desc: "매번 승인받고 진행" },
  { id: "acceptEdits", symbol: "⏵⏵", label: "accept edits on", desc: "파일 편집은 자동 수락" },
  { id: "plan", symbol: "⏸", label: "plan mode on", desc: "계획만, 변경 안 함" },
  { id: "auto", symbol: "⏵⏵", label: "auto mode on", desc: "안전한 작업은 자동 진행" },
  { id: "bypassPermissions", symbol: "⏵⏵", label: "bypassing permissions", desc: "모든 승인 건너뜀", hidden: true },
];

// codex 알약은 **shift+tab 이 바꾸는 것만** 담는다(사용자 확정 2026-08-03).
//  실측: codex 의 shift+tab 은 Default ↔ Plan 두 상태 토글이고, 권한 3종(`/permissions`)은
//  **다른 축**이라 섞지 않는다 — 권한은 팔레트에서 `/permissions` 를 실행하면 선택 화면 카드가
//  떠서 거기서 고른다(제자리). 섞어 두면 체크가 둘 켜져 "중복 선택"처럼 보인다(그 지적의 원인).
export const CODEX_MODES = [
  { id: "codexDefault", symbol: "", label: "Default mode", desc: "평소대로 실행" },
  { id: "codexPlan", symbol: "", label: "Plan mode", desc: "계획만 세우고 실행하지 않음" },
];

/** 모드 id 가 속한 카탈로그(모르면 claude). 알약/목록이 에이전트를 따로 몰라도 되게 하는 지점. */
function catalogFor(id) {
  return CODEX_MODES.some((m) => m.id === String(id == null ? "" : id)) ? CODEX_MODES : AGENT_MODES;
}

/** 모드 id → 카탈로그 항목(모르는 id 는 null — 데몬이 새 모드를 보내도 화면이 깨지지 않게). */
export function agentModeOf(id) {
  const s = String(id == null ? "" : id);
  return AGENT_MODES.find((m) => m.id === s) || CODEX_MODES.find((m) => m.id === s) || null;
}

/** 목록 항목이 "지금 켜진" 것인가 — 양쪽 카탈로그 모두 **하나만** 켜진다(라디오). */
export function agentModeIsOn(item, current) {
  if (!item || !current) return false;
  const cur = typeof current === "string" ? { id: current } : current;
  return item.id === cur.id;
}

/** 알약/목록에 쓸 표시값 — 데몬이 준 label/symbol 을 우선하고, 없으면 카탈로그로 메운다. */
export function agentModeView(mode) {
  if (!mode || !mode.id) return null;
  const cat = agentModeOf(mode.id);
  return {
    id: mode.id,
    symbol: mode.symbol || (cat && cat.symbol) || "",
    label: mode.label || (cat && cat.label) || mode.id,
    desc: (cat && cat.desc) || "",
  };
}

/** 알약에 그릴 라벨(낙관 적용용) — 데몬 label 이 오기 전에 클라이언트가 카탈로그로 만든다. */
export function agentModeLabel(mode) {
  if (!mode || !mode.id) return "";
  const cat = agentModeOf(mode.id);
  return (cat && cat.label) || mode.label || mode.id;
}

/** 목록에 그릴 선택지 — 지금 모드(id 또는 모드 객체)가 속한 카탈로그. 숨김은 "지금 그 모드일 때"만. */
export function agentModeChoices(current) {
  const cur = typeof current === "string" || current == null ? { id: current } : current;
  return catalogFor(cur.id).filter((m) => !m.hidden || m.id === cur.id);
}

// ── 컴포저 순수 규칙(양 플랫폼 동일 — app 미러: src/workspace/chat/composer.ts) ────────────────
// 전송 가능 판정. 공백/개행만 있는 입력은 **보내지 않는다**(TUI 에 빈 Enter 를 넣으면 에이전트가
//  프롬프트를 한 번 삼켜서 사용자는 "먹혔다"고 느낀다 — 실측 사고 계열).
export function composerHasText(v) {
  return String(v == null ? "" : v).trim().length > 0;
}

// 에이전트 코드명 → 표시 이름(플레이스홀더 "Claude에게 요청"). 모르면 빈 문자열.
export function agentDisplayName(agent) {
  const s = String(agent == null ? "" : agent).trim().toLowerCase();
  if (s === "claude") return "Claude";
  if (s === "codex") return "Codex";
  if (s === "gemini") return "Gemini";
  return "";
}

// ── `noSession`(대화가 아직 없다) 상태의 재오픈 판정(순수 규칙) ────────────────────────────
// 데몬 계약(2026-07-27): `chat.open` 이 오류가 아니라 `{ supported:true, noSession:true,
//   reason:'not_started'|'ambiguous'|'none', candidates }` 를 준다. 즉 **성공 응답**이다.
//
// ⚠ 이 함수가 없으면 조용한 퇴행이 난다: 성공이라 `_openFailed` 가 비워지는데 `chatId` 는 null 이라
//   `_tick` 의 "chatId 없으면 재오픈" 이 폴링 주기(4s)마다 영원히 chat.open 을 때린다. 화면은 정상이고
//   에러도 없어서 아무도 모른다(원격 PC 면 back 릴레이까지 4초마다 왕복). 그래서 noSession 은
//   **확정된 상태**로 다루고 의미 있는 트리거에서만 다시 연다:
//     ① 첫 메시지 전송 직후(훅이 바인딩을 만들 때까지 짧게 = probe 창 안에서는 매 틱)
//     ② chat_event push 도착 / ③ 탭·터미널 전환(retarget) → 둘은 호출측이 플래그를 지운다(여긴 안 옴)
//     ④ 그 외에는 느린 재확인(NO_SESSION_IDLE_MS)
//   `ambiguous` 는 사용자가 목록에서 고를 때까지 서버 상태가 저절로 바뀌지 않으므로 **자동 재시도 0회**.
/**
 * @param {{reason:string|null, now:number, lastAt:number, probeUntil?:number}} a
 * @returns {boolean} 지금 chat.open 을 다시 부를 것인가
 */
export function shouldReopenNoSession({ reason, now, lastAt, probeUntil } = {}) {
  if (!reason) return true;                 // noSession 상태가 아니다 → 기존(실패) 재시도 규칙에 맡긴다
  if (reason === "ambiguous") return false; // 사용자가 고르기 전까지 바뀔 수 없다
  if (probeUntil && now < probeUntil) return true;
  return now - (lastAt || 0) >= CHAT.NO_SESSION_IDLE_MS;
}

// ── 컴포저 `+` 파일 넣기(순수 규칙) ──────────────────────────────────────────────
// 여기 있는 이유: 이 규칙들이 **에이전트에게 실제로 전달되는 문자열**을 결정하는데, DOM 안에 묻어 두면
//  단위 테스트가 불가능해 "정규식으로 소스 모양만 보는" 공허한 검증이 된다. 순수 함수로 빼서 실행 검증한다
//  (test/chat-composer.mjs — 돌연변이 검증까지 통과시킨 핀).
// 절대경로가 아니라 **워크스페이스 상대 경로**를 넣는 것이 정본이다: 에이전트의 cwd 가 워크스페이스
//  루트이므로 상대 경로가 짧고 정확하며, 홈 경로에 박힌 사용자 계정명이 대화 기록에 남지 않는다.

/** 홈-상대 전체 경로 → 워크스페이스 상대 경로. 루트 밖이면 그대로 둔다.
 *  ⚠ 경계 문자(`/`)를 반드시 본다 — `startsWith(root)` 로만 검사하면 `demo` 루트에서 `demo2/a.js` 가
 *   `/a.js` 로 잘려 **다른 파일을 가리킨다**(돌연변이 검증으로 확인한 실패 형태). */
export function relToRoot(root, full) {
  const r = String(root || "").replace(/\/+$/, "");
  const p = String(full || "");
  return r && p.startsWith(r + "/") ? p.slice(r.length + 1) : p;
}

/** 파일 목록 필터 — **상대** 경로 전체에 대해 대소문자 무시 부분일치(루트 이름은 대상이 아니다:
 *  루트 글자로 전부 매치되면 필터가 무의미해진다). limit 로 그리는 행수를 자른다. */
export function filterFiles(files, root, query, limit) {
  const q = String(query || "").trim().toLowerCase();
  const out = [];
  for (const f of files || []) {
    if (q && !relToRoot(root, f).toLowerCase().includes(q)) continue;
    out.push(f);
    if (out.length >= (limit || CHAT.PICK_LIMIT)) break;
  }
  return out;
}

/**
 * 커서 위치에 경로를 끼워 넣는다 → { value, caret }.
 *  · 앞이 공백이 아니면 공백 1칸을 먼저 넣는다(경로가 앞 단어에 붙어 다른 이름이 되는 것 방지).
 *  · 뒤에도 공백 1칸 — 이어서 문장을 쓰는 것이 기본 사용 흐름이다.
 *  · 선택 영역이 있으면 대체한다(일반 입력 관례). start>end 로 와도 삽입점으로만 쓰고 아무것도 지우지 않는다.
 */
export function insertPathAt(value, start, end, rel) {
  const v = String(value || "");
  const s = Math.max(0, Math.min(start ?? v.length, v.length));
  const e = Math.max(s, Math.min(end ?? s, v.length));
  const ins = (s > 0 && !/\s$/.test(v.slice(0, s)) ? " " : "") + String(rel || "") + " ";
  return { value: v.slice(0, s) + ins + v.slice(e), caret: s + ins.length };
}

/** 트리(중첩) → 파일 경로 평탄화. 디렉토리는 넣지 않고, `path` 가 없는 결손 노드도 버린다
 *  (undefined 가 목록에 섞이면 클릭해도 조용히 아무 일도 일어나지 않는다). */
export function flattenFiles(nodes, out) {
  const acc = out || [];
  for (const n of nodes || []) {
    if (n && n.dir) flattenFiles(n.children, acc);
    else if (n && n.path) acc.push(n.path);
  }
  return acc;
}

// ── 표시 여부 ──
// 데몬이 hidden:true 로 접어 보낸 것은 진단용(meta/system/unknown/구형 tool_result 자리표시).
//  thinking 은 실측상 본문이 거의 항상 빈 문자열(signature 만 옴)이라 hidden:true 로 오는데,
//  빈 말풍선을 그리면 노이즈뿐이므로 "본문이 있을 때만" 예외적으로 보여준다.
export function isVisible(m) {
  if (!m || typeof m !== "object") return false;
  if (m.kind === "thinking") return !!String(m.text || "").trim();
  return !m.hidden;
}

// tool_result 는 독립 카드가 아니라 앞선 tool_use 카드의 "결과" 슬롯으로 합친다.
export function isResult(m) {
  return !!(m && m.kind === "tool_result" && m.result);
}

// ── 라벨 규칙 ──
// 데몬이 이미 사람이 읽을 title 을 만들어 준다(summarizeTool). 우리는 그것을 신뢰하고,
//  없을 때만 폴백을 만든다 — 여기서 다시 규칙을 세우면 PC/폰/데몬 3중 드리프트가 된다.
export function toolLabel(m) {
  const t = (m && m.tool) || null;
  if (!t) return String((m && m.text) || "도구");
  if (t.title) return t.title;
  const name = t.name || "도구";
  return t.path ? `${name} · ${t.path}` : name;
}

// 결과 상태 표식 — undefined=진행중.
export function resultMark(res) {
  if (!res) return "…";
  return res.ok ? "✓" : "✕";
}
export function resultClass(res) {
  if (!res) return "pending";
  return res.ok ? "ok" : "fail";
}

// 결과 바이트/줄 요약(카드 우측 메타).
export function resultMeta(res) {
  if (!res) return "";
  const parts = [];
  if (res.lines) parts.push(`${res.lines}줄`);
  if (res.bytes) parts.push(fmtBytes(res.bytes));
  if (res.images) parts.push(`이미지 ${res.images}`);
  return parts.join(" · ");
}
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + "MB";
  if (v >= 1024) return Math.round(v / 1024) + "KB";
  return v + "B";
}

// ── 병합(스냅샷 + 델타) ──
// seq 로 중복 제거하고 정렬 유지. 델타는 대개 이미 정렬돼 오지만, epoch 리셋/재조회가 섞이면
//  순서가 어긋날 수 있어 매번 안정 정렬한다(비용은 화면에 있는 수백 건 수준).
export function mergeMsgs(list, incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return { list, added: [] };
  const bySeq = new Map();
  for (const m of list) bySeq.set(m.seq, m);
  const added = [];
  for (const m of incoming) {
    if (!m || typeof m.seq !== "number") continue;
    if (bySeq.has(m.seq)) { bySeq.set(m.seq, m); continue; } // 같은 seq 재수신 = 갱신(멱등)
    bySeq.set(m.seq, m);
    added.push(m);
  }
  let out = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (out.length > CHAT.MAX_MSGS) out = out.slice(out.length - CHAT.MAX_MSGS);
  return { list: out, added };
}

// 로컬 워터마크 — 다음 chat.since 의 sinceSeq.
export function lastSeqOf(list, fallback) {
  let mx = Number(fallback) || 0;
  for (const m of list) if (typeof m.seq === "number" && m.seq > mx) mx = m.seq;
  return mx;
}

// ── 낙관적 user 버블 dedup ──
// 전송 즉시 말풍선을 그려두고(seq 음수), 트랜스크립트에서 같은 텍스트의 user 메시지가 오면 치운다.
//  키 = trim 후 앞 200자, 창 = 60s(설계서 §2.5).
const OPTIMISTIC_WINDOW_MS = 60 * 1000;
export function optimisticKey(text) {
  return String(text || "").trim().slice(0, 200);
}
export function dropMatchedOptimistic(pending, msgs) {
  // pending: [{ key, at, seq }] — 치울 대상 seq 배열을 돌려준다.
  if (!pending.length) return [];
  const now = Date.now();
  const drop = [];
  for (const m of msgs) {
    if (!m || m.role !== "user" || (m.kind !== "text" && m.kind !== "slash")) continue;
    const k = optimisticKey(m.text);
    // any: 첨부 동반 전송 — 실제 트랜스크립트 문구(경로가 [Image #N] 으로 변환 등)를 예측할 수
    //  없으므로 "다음에 오는 user 메시지"와 짝지어 치운다(창 60s 동일).
    const hit = pending.find((p) => (p.any || p.key === k) && now - p.at < OPTIMISTIC_WINDOW_MS);
    if (hit) { drop.push(hit.seq); pending.splice(pending.indexOf(hit), 1); }
  }
  // 창이 지난 낙관 버블은 그대로 남긴다(전송은 됐고 트랜스크립트 반영만 늦은 경우가 있으므로
  //  지우면 "보낸 게 사라진" 것처럼 보인다). 정리는 epoch 리셋에서 일괄.
  return drop;
}

// 텍스트 n줄로 자르기(+ 남은 줄수) — tool 결과 접힘.
export function clampLines(text, n) {
  const lines = String(text || "").split("\n");
  if (lines.length <= n) return { head: lines.join("\n"), rest: 0 };
  return { head: lines.slice(0, n).join("\n"), rest: lines.length - n };
}

// 남은 시간(승인 카운트다운) — "2:43" / "0:07" / 만료면 null.
export function remainMs(deadlineAt) {
  const left = Number(deadlineAt) - Date.now();
  return left > 0 ? left : 0;
}
export function fmtRemain(ms) {
  const s = Math.max(0, Math.ceil(Number(ms) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// 입력 텍스트에서 토큰을 1회 제거(+붙은 공백 1개) — 전송 시 TUI 컴포저에 이미 실린 표식을 다시 보내지 않는다.
export function stripTokenOnce(s, tok) {
  const src = String(s || "");
  const t = String(tok || "");
  if (!t) return src;
  const i = src.indexOf(t);
  if (i < 0) return src;
  let a = src.slice(0, i);
  let b = src.slice(i + t.length);
  if (b.startsWith(" ")) b = b.slice(1);
  else if (a.endsWith(" ")) a = a.slice(0, -1);
  return a + b;
}

// ── 에이전트 상태(공식 채널) — 표시 규칙 ─────────────────────────────────────────
// ★ 2026-08-03 사용자 확정: "채팅 UI답게 새로 그리기". 원천이 화면 스크랩에서 **구조화 데이터**로
//  바뀌었다(데몬 agent-status.js — claude statusLine 훅 / codex rollout). 그래서 채팅은 TUI 문자열을
//  흉내내지 않고 자기 화면에 맞는 표시를 직접 만든다.
//  · 평소 = 한 줄 칩(모델 · 컨텍스트% · 한도들) — 폰 폭에서 잘리면 뒤부터 버린다.
//  · 탭 = 상세(토큰 절대값 · 리셋까지 남은 시간 · 비용/수정 줄수).
//  ⚠ 시간 계산은 **표시 시점**에 한다(데몬이 "3시간 21분 후" 문자열을 만들면 화면에 굳는다).
//  ⚠ 앱 `chatModel.ts` 의 같은 절과 **동시 수정 대상**(test/chat-status.mjs 가 실행 대조로 고정).

/** 토큰 수 → '310k' / '1.0M' / '820'. */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return Math.round(v / 1000) + "k";
  return String(v);
}

/** epoch 초 → '3시간 21분 후 리셋' / '4일 후 리셋' / 지났으면 ''. now 는 ms. */
export function fmtReset(resetsAt, now) {
  const at = Number(resetsAt) || 0;
  if (!at) return "";
  const ms = at * 1000 - (Number(now) || 0);
  if (ms <= 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(1, min)}분 후 리셋`;
  const h = Math.floor(min / 60);
  if (h < 24) { const m = min % 60; return m ? `${h}시간 ${m}분 후 리셋` : `${h}시간 후 리셋`; }
  // 일 단위는 **반올림**한다 — floor 면 95시간(≈4일)이 "3일 후"로 읽혀 하루를 손해 본다
  //  (경계에서 몇 초 차이로 눈금이 통째로 떨어지는 것도 같은 이유).
  return `${Math.max(1, Math.round(h / 24))}일 후 리셋`;
}

/**
 * 상태 → 한 줄 칩 목록 [{key,text}]. **왼쪽이 더 중요**하다(좁으면 뒤부터 버린다).
 *  모델 → 컨텍스트 → 한도들 순서. 값이 없는 항목은 아예 만들지 않는다(빈 칩 금지).
 */
export function statusChips(st) {
  if (!st) return [];
  const out = [];
  if (st.model) out.push({ key: "model", text: String(st.model) });
  if (st.contextPct != null) out.push({ key: "ctx", text: `컨텍스트 ${st.contextPct}%` });
  for (const l of Array.isArray(st.limits) ? st.limits : []) {
    if (l && l.pct != null) out.push({ key: "lim:" + l.id, text: `${l.label} ${l.pct}%` });
  }
  return out;
}

/** 상태 → 상세 행 목록 [{key,label,value,sub}]. now 는 ms(리셋 남은 시간 계산 시점). */
export function statusDetail(st, now) {
  if (!st) return [];
  const rows = [];
  if (st.contextUsed != null || st.contextPct != null) {
    const size = st.contextMax ? `${fmtTokens(st.contextUsed)} / ${fmtTokens(st.contextMax)}` : fmtTokens(st.contextUsed);
    rows.push({
      key: "ctx", label: "컨텍스트",
      value: st.contextPct != null ? `${size} (${st.contextPct}%)` : size, sub: "",
    });
  }
  for (const l of Array.isArray(st.limits) ? st.limits : []) {
    if (!l || l.pct == null) continue;
    rows.push({ key: "lim:" + l.id, label: `${l.label} 한도`, value: `${l.pct}%`, sub: fmtReset(l.resetsAt, now) });
  }
  const bits = [];
  if (st.costUsd != null) bits.push("$" + Number(st.costUsd).toFixed(2));
  if (st.linesAdded != null || st.linesRemoved != null) bits.push(`+${st.linesAdded || 0} / -${st.linesRemoved || 0} 줄`);
  if (bits.length) rows.push({ key: "cost", label: "이번 세션", value: bits.join(" · "), sub: "" });
  const meta = [];
  if (st.effort) meta.push("추론 " + st.effort);
  if (st.fast) meta.push("고속");
  if (st.approvalPolicy) meta.push("승인 " + st.approvalPolicy);
  if (meta.length) rows.push({ key: "meta", label: "설정", value: meta.join(" · "), sub: "" });
  return rows;
}

/** 상태 표시를 그릴 값이 하나라도 있는가(없으면 화면 미러 폴백을 쓴다). */
export function hasStatus(st) { return statusChips(st).length > 0; }
