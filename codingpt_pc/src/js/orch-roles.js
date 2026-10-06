// orch-roles.js — "이 터미널은 묶음에서 무슨 역할인가"(pane 탭·사이드바가 같이 읽는다).
//  pane.js 가 orch-view.js(시트·RPC)를 끌어오지 않도록 떼어 둔 얇은 조회 층이다 — state 와 순수 모델만 본다.
import { state } from "./state.js";
import { terminalRoles, sessionTree, workerGlyph } from "./orch-model.js";

const cache = new Map(); // host → { at, roles:Map }

function rolesOf(host) {
  const k = String(Number(host));
  const b = state.orch.byHost[k];
  if (!b) return null;
  const c = cache.get(k);
  if (c && c.at === b.at) return c.roles;
  const roles = terminalRoles(b);
  cache.set(k, { at: b.at, roles });
  return roles;
}

/** (host, 홈-상대 cwd, 터미널 번호) → { role, dot, title, uiState, runId, dispatchId } | null */
export function orchTabRole(host, cwd, win) {
  const h = host != null ? host : (state.daemon ? state.daemon.deviceId : null);
  if (h == null || typeof win !== "number") return null;
  const roles = rolesOf(h);
  return roles ? roles.get(`${cwd || ""}\n${win}`) || null : null;
}

const treeCache = new Map(); // host\ncwd → { at, rows }
function rowsOf(host, cwd) {
  const b = state.orch.byHost[String(Number(host))];
  if (!b) return [];
  const k = `${Number(host)}\n${cwd || ""}`;
  const c = treeCache.get(k);
  if (c && c.at === b.at) return c.rows;
  const rows = sessionTree(b, cwd || "");
  treeCache.set(k, { at: b.at, rows });
  return rows;
}
/** 상태 표식 → 문구 키(text/orch.js). 사이드바와 탭이 같은 말을 한다. */
export const GLYPH_TEXT = { working: "wWorking", waiting: "wNeedsInput", blocked: "wBlocked", failed: "wFailed", interrupted: "wStopped", done: "wSucceeded", unverifiable: "wIdleNoReport" };
/**
 * 이 탭(터미널 번호 또는 채팅 대화)의 에이전트 — 사이드바 에이전트 행과 **같은 표식·같은 제목**을 탭 머리에 쓴다.
 *  → { glyph, title, worker } | null(에이전트가 없는 터미널). title 이 비면 탭이 제 이름을 쓴다(사이드바도 그 이름을 쓴다).
 */
export function tabSession(host, cwd, { win = null, threadId = null } = {}) {
  const h = host != null ? host : (state.daemon ? state.daemon.deviceId : null);
  if (h == null) return null;
  if (typeof win === "number") {
    const role = orchTabRole(h, cwd, win);
    if (role && role.role === "worker") return { glyph: workerGlyph(role.uiState), title: role.title || "", worker: true };
  }
  for (const r of rowsOf(h, cwd)) {
    if (threadId ? (r.chat && r.threadId === threadId) : (typeof win === "number" && !r.chat && r.tid === win)) return { glyph: r.glyph, title: r.lead || "", worker: false };
  }
  return null;
}

/** 역할 표시가 바뀌었는지 비교용 서명 — 바뀐 때만 탭 머리를 다시 그린다. */
export function orchRolesSig(host) {
  const roles = rolesOf(host);
  const b = state.orch.byHost[String(Number(host))];
  //  에이전트 상태·제목도 탭에 그린다 — 그것이 바뀌어도 다시 그린다.
  const sess = ((b && b.sessions) || []).map((x) => `${x.cwd || ""}|${x.tid == null ? "" : x.tid}|${x.threadId || ""}|${x.state || ""}|${x.detail ? 1 : 0}|${x.title || ""}`).sort().join("\n");
  if (!roles) return sess;
  return [...roles.entries()].map(([k, v]) => `${k}|${v.role}|${v.dot}|${v.uiState || ""}|${v.title}`).sort().join("\n") + "\n--\n" + sess;
}
