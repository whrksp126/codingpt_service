// orch-roles.js — "이 터미널은 묶음에서 무슨 역할인가"(pane 탭·사이드바가 같이 읽는다).
//  pane.js 가 orch-view.js(시트·RPC)를 끌어오지 않도록 떼어 둔 얇은 조회 층이다 — state 와 순수 모델만 본다.
import { state } from "./state.js";
import { terminalRoles } from "./orch-model.js";

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

/** 역할 표시가 바뀌었는지 비교용 서명 — 바뀐 때만 탭 머리를 다시 그린다. */
export function orchRolesSig(host) {
  const roles = rolesOf(host);
  if (!roles) return "";
  return [...roles.entries()].map(([k, v]) => `${k}|${v.role}|${v.dot}|${v.title}`).sort().join("\n");
}
