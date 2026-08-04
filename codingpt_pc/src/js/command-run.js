// command-run.js — 명령 id → 실제 동작(PC).
//
// 왜 레지스트리인가: 동작은 화면 조립을 아는 쪽(main.js·workspace-view.js)에 있고, 부르는 쪽은
//  팔레트와 단축키다. 부르는 쪽이 화면 모듈을 직접 import 하면 순환이 생긴다(팔레트 ↔ 워크스페이스
//  화면). 그래서 **동작은 등록하고, 부르는 쪽은 id 만 안다**.
//
// 규율:
//  · 지금 쓸 수 없는 명령은 **막는다**(isAvailable). 팔레트는 그런 행을 흐리게 보여주고 Enter 를
//    먹지 않는다 — 눌렀는데 아무 일도 없는 것이 가장 나쁘다.
//  · 등록되지 않은 명령은 없는 것과 같다. 표(commands.js)에 줄만 넣고 동작을 안 붙이면 팔레트에
//    흐린 채로 보인다(빈 줄이 아니라).
import { state, activeWs, wsRuntime } from "./state.js";
import { commandById } from "./commands.js";

const handlers = new Map();

/** { 'ws.addIde': () => …, … } 형태로 등록. 나중 등록이 이긴다. */
export function registerCommands(map) {
  for (const id of Object.keys(map || {})) {
    if (typeof map[id] === "function") handlers.set(id, map[id]);
  }
}

export function hasHandler(id) {
  return handlers.has(id);
}

/** 지금 이 명령을 쓸 수 있나. 범위(scope)와 화면 상태를 함께 본다. */
export function isAvailable(id) {
  const c = commandById(id);
  if (!c || !c.pc || !handlers.has(id)) return false;
  if (c.scope === "global") return true;
  // 설정 화면에 들어가 있으면 워크스페이스 명령은 갈 곳이 없다.
  if (state.view === "settings") return false;
  const ws = activeWs();
  if (!ws) return false;
  if (c.scope === "pane") {
    const rt = wsRuntime(ws.id);
    if (!rt || !rt.layout) return false;
  }
  return true;
}

/** 실행. 쓸 수 없으면 아무 일도 안 하고 false. */
export function runCommand(id) {
  if (!isAvailable(id)) return false;
  try { handlers.get(id)(); } catch (_) { /* 각 동작이 자기 방식으로 알린다 */ }
  return true;
}
