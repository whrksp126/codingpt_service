// orch-api.js — 오케스트레이션 RPC(orch.*) 전송 래퍼(orchestration-design.md).
//
// = tasks-api.js createTaskApi 의 규칙 그대로(봉인 우선, 평문 폴백은 **구조적 미지원 코드에서만**, 도메인 code 보존).
//  바꾸는 것은 두 군데뿐이다: 평문 라우트가 `/api/daemon/orch`, 이 PC 호스트는 Rust `orch_local`(유닉스 소켓).
//  화면은 **사람 권한**만 쓴다 — 보기(orch.list) + 답하기·결정·멈추기·정리·닫기. 워커를 띄우는 쪽은 터미널 안의 에이전트다.
//
// ⚠ 이 파일은 import 시점에 window.__TAURI__ 를 건드리지 않는다(node 테스트가 createOrchApi 를 직접 돌린다).
import { createTaskApi, parseCodedError, TaskError, hostCaps, isLocalHostId } from "./tasks-api.js";

/** back ORCH_RPC_OK 의 타임아웃 — 클라 HTTP 타임아웃은 여기에 +5s. */
export const ORCH_TIMEOUTS = Object.freeze({
  "orch.list": 20000, "orch.status": 15000, "orch.runList": 15000, "orch.runShow": 20000, "orch.runClose": 60000,
  "orch.workerList": 20000, "orch.workerShow": 15000, "orch.workerRead": 15000,
  "orch.workerStop": 15000, "orch.workerRelease": 60000, "orch.workerRetain": 15000,
  "orch.reply": 15000, "orch.gateResolve": 15000, "orch.gateList": 15000, "orch.noteSet": 15000,
});

export function createOrchApi(deps) {
  const d = deps || {};
  const remote = createTaskApi({
    ...d,
    isLocalHost: () => false,
    backApi: (o) => d.backApi({ ...o, path: "/api/daemon/orch" }),
  });
  async function orchRpc(method, params, host, timeoutMs) {
    const t = timeoutMs || ORCH_TIMEOUTS[method] || 15000;
    if (d.isLocalHost && d.isLocalHost(host)) {
      try {
        return await d.local(method, params || {});
      } catch (e) {
        const p = parseCodedError(e);
        throw new TaskError(p.code, p.message, { path: "local" });
      }
    }
    return remote.taskRpc(method, params, host, t);
  }
  return { orchRpc };
}

let _inst = null;
async function inst() {
  if (_inst) return _inst;
  const [a, s, e] = await Promise.all([import("./api.js"), import("./state.js"), import("./e2ee.js")]);
  _inst = createOrchApi({
    local: (cmd, args) => a.api.orchLocal(cmd, args),
    backApi: (o) => a.api.backApiAsync(o.method, o.path, o.body ?? null, o.timeoutSecs),
    e2ee: () => ({ ready: e.e2eeReady(), policy: e.policyRequired() ? "required" : "preferred" }),
    isLocalHost: (h) => h == null || isLocalHostId(s.state, h),
  });
  return _inst;
}

/** 오케스트레이션 RPC 1건. @throws TaskError(code) */
export async function orchRpc(method, params, host, timeoutMs) {
  return (await inst()).orchRpc(method, params, host, timeoutMs);
}

/** 그 PC 가 오케스트레이션을 아는가 — null = 모름(조회 전·오프라인). */
export function hostHasOrch(host) { const c = hostCaps(host); return c == null ? null : c.includes("orch.v1"); }
