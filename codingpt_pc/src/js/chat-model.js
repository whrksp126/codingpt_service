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
  THINKING_CHARS: 120,     // thinking 접힘 글자수
  MAX_MSGS: 1200,          // 로컬 버퍼 상한(오래된 것부터 버림 — 과거는 "이전 대화 더 보기")
  DRAFT_MAX: 4096,         // 컴포저 초안 영속 상한
  SEND_ENTER_DELAY_MS: 90, // paste 후 Enter 분리 전송(TUI 가 paste 종료 마커 전에 처리하는 것 방지)
};

// 에이전트 판정에 쓰는 명령 이름 — 리컨실러가 채우는 tab.cmd(pane_current_command)와 대조.
export const AGENT_CMD_RE = /^(claude|codex|gemini)$/i;

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
    const hit = pending.find((p) => p.key === k && now - p.at < OPTIMISTIC_WINDOW_MS);
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

// 시각(HH:MM) — 알림 패널(notifications.js fmtTime)과 같은 규칙.
export function fmtTime(ts) {
  const d = ts == null ? null : new Date(ts);
  if (!d || isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
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
