// automations-api.js — 자동화 번들 RPC(auto.* · dispatch.* · power.*) 전송 래퍼(automation-design §2.3·§7.1).
//
// = tasks-api.js createTaskApi 의 복제 규칙 그대로(봉인 우선, 평문 폴백은 **구조적 미지원 코드에서만**, 도메인 code 보존).
//  바퀴를 다시 만들지 않고 createTaskApi 를 두 군데만 바꿔 감싼다:
//   ① 평문 라우트가 `/api/daemon/task` 가 아니라 `/api/daemon/auto`(§7.1 AUTO_RPC_OK).
//   ② 이 PC 호스트 → Rust `auto_local`(유닉스 소켓). 단 데몬은 소켓의 `auto.*` 를 에이전트 생성 게이트
//      (resolveCtx + assertCptContext, §2.3·§5.7)에 먼저 태운다 — PC 앱은 CodingPT 터미널이 아니라 그 게이트에서
//      OUT_OF_CONTEXT/AUTO_OUT_OF_TERMINAL 로 거절될 수 있다. 게이트 거절은 **실행 전** 거절이라 이중 실행이 없으므로
//      그때만 같은 PC 를 원격 경로(봉인 → 평문 릴레이)로 다시 부른다. 릴레이 경로 createdBy 는 {kind:'user'} 다.
//  F2 의 task.run.fix / task.run.followup.dismiss 는 `task.` 접두라 여기가 아니라 tasks-api.taskRpc 를 탄다.
//
// ⚠ 이 파일은 import 시점에 window.__TAURI__ 를 건드리지 않는다(node 테스트가 createAutoApi 를 직접 돌린다).
import { createTaskApi, parseCodedError, TaskError, hostCaps, isLocalHostId } from "./tasks-api.js";

/** back AUTO_RPC_OK 의 타임아웃(§7.1) — 클라 HTTP 타임아웃은 여기에 +5s. */
export const AUTO_TIMEOUTS = Object.freeze({
  "auto.list": 15000, "auto.get": 15000, "auto.validate": 15000, "auto.create": 15000, "auto.update": 15000, "auto.remove": 15000,
  "auto.pause": 15000, "auto.resume": 15000, "auto.pauseAll": 15000, "auto.runNow": 15000, "auto.log": 15000,
  "dispatch.catalog": 30000, "dispatch.plan": 15000, "dispatch.get": 15000,
  "power.status": 15000, "power.set": 15000, "power.setup": 15000,
});

/** 소켓 게이트(에이전트 생성 게이트)가 PC 앱 호출을 실행 전에 거절한 코드 — 원격 경로로 재시도해도 안전하다. */
export const LOCAL_GATE_CODES = new Set(["OUT_OF_CONTEXT", "AUTO_OUT_OF_TERMINAL", "E2EE_UNKNOWN_CMD", "UNKNOWN_CMD"]);

/**
 * @param {object} deps  createTaskApi 의 deps + selfId()(이 PC 의 deviceId — 게이트 폴백이 원격 경로로 부를 host)
 *  local(cmd, args)  — Rust auto_local(봉인 요청 cmd='e2ee.rpc' 포함)
 *  backApi({method, path, body, timeoutSecs})
 */
export function createAutoApi(deps) {
  const d = deps || {};
  const remote = createTaskApi({
    ...d,
    isLocalHost: () => false,
    backApi: (o) => d.backApi({ ...o, path: "/api/daemon/auto" }),
  });

  async function autoRpc(method, params, host, timeoutMs) {
    const t = timeoutMs || AUTO_TIMEOUTS[method] || 15000;
    if (d.isLocalHost && d.isLocalHost(host)) {
      try {
        return await d.local(method, params || {});
      } catch (e) {
        const p = parseCodedError(e);
        const self = host != null ? host : d.selfId ? d.selfId() : null;
        if (!LOCAL_GATE_CODES.has(p.code) || self == null) throw new TaskError(p.code, p.message, { path: "local" });
        return remote.taskRpc(method, params, self, t);
      }
    }
    return remote.taskRpc(method, params, host, t);
  }
  return { autoRpc };
}

// ── 기본 인스턴스(앱 런타임) ─────────────────────────────────────────────────────
let _mods = null;
async function mods() {
  if (_mods) return _mods;
  const [a, s, e] = await Promise.all([import("./api.js"), import("./state.js"), import("./e2ee.js")]);
  _mods = { api: a.api, S: s, E: e };
  return _mods;
}
let _inst = null;
async function inst() {
  if (_inst) return _inst;
  const m = await mods();
  _inst = createAutoApi({
    local: (cmd, args) => m.api.autoLocal(cmd, args),
    backApi: (o) => m.api.backApiAsync(o.method, o.path, o.body ?? null, o.timeoutSecs),
    e2ee: () => ({ ready: m.E.e2eeReady(), policy: m.E.policyRequired() ? "required" : "preferred" }),
    isLocalHost: (h) => h == null || isLocalHostId(m.S.state, h),
    selfId: () => (m.S.state.daemon ? m.S.state.daemon.deviceId ?? null : null),
  });
  return _inst;
}

/** 자동화 번들 RPC 1건. @throws TaskError(code) — 문구는 text/tasks.js errText(code). */
export async function autoRpc(method, params, host, timeoutMs) {
  return (await inst()).autoRpc(method, params, host, timeoutMs);
}

/** 로컬 전용 power.event(§6.4) — Rust power_local. 실패는 삼킨다(best effort). */
export async function powerEvent(kind) {
  try { const { api } = await mods(); await api.powerLocal("power.event", { kind }); } catch (_) { /* best effort */ }
}

// ── caps 게이트(§2.3) — tasks-api 의 호스트 caps 캐시(GET /api/daemon/status runners[].caps)를 그대로 읽는다 ─────
//  null = 모름(아직 조회 전·오프라인). 모르면 시도한다(구 데몬이면 BAD_PARAMS/UNKNOWN 으로 실패가 드러난다).
const capOf = (host, cap) => { const c = hostCaps(host); return c == null ? null : c.includes(cap); };
export function hostHasAuto(host) { return capOf(host, "auto.v1"); }
export function hostHasDispatch(host) { return capOf(host, "dispatch.v1"); }
export function hostHasPower(host) { return capOf(host, "power.v1"); }

// ── 깨어 있음(runner_status.awake, §6.6) — back 이 hello/runner_busy 로 받은 불리언을 팬아웃·리플레이한다 ─────
const awakeByHost = new Map(); // host → { awake, busy }
let awakeListeners = new Set();
export function noteRunnerAwake(ev) {
  if (!ev || ev.deviceId == null) return false;
  const h = Number(ev.deviceId);
  const prev = awakeByHost.get(h);
  const next = ev.online === false ? null : { awake: ev.awake === true, busy: ev.busy === true };
  if (JSON.stringify(prev || null) === JSON.stringify(next)) return false;
  if (next) awakeByHost.set(h, next); else awakeByHost.delete(h);
  for (const fn of awakeListeners) { try { fn(); } catch (_) { /* noop */ } }
  return true;
}
/** 그 PC 가 지금 깨어 있기(잠자기 방지 층)를 잡고 있는가. 모르면 false(글리프를 그리지 않는다). */
export function hostAwake(host) {
  const v = awakeByHost.get(Number(host));
  return !!(v && v.awake);
}
export function onAwakeChanged(fn) { awakeListeners.add(fn); return () => awakeListeners.delete(fn); }
