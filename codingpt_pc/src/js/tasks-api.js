// tasks-api.js — Agent Tasks 전송 래퍼(설계 §3.2) + 호스트 caps 캐시 + 원격 에이전트 목록.
//
// 왜 전용 래퍼인가(기존 sealedRpc 를 쓰지 않는 이유):
//  · sealedRpc 는 **봉투 계층 실패면 무엇이든** null(= 평문 폴백 신호)을 돌려준다. 작업 RPC 는 변이(머지·폐기)라
//    봉인 타임아웃 뒤 평문으로 같은 요청을 다시 보내면 **이중 실행**이다(부록 A3). 그래서 평문 폴백은
//    "봉투가 구조적으로 못 쓰인다" 는 코드에서만 허용한다. 타임아웃·5xx·도메인 코드는 전부 throw.
//  · sealedRpc 는 호스트가 실행하고 실패한 경우(ok:false)의 **code 를 버린다**(new Error(e) 만 던진다) —
//    작업 UI 는 code 로만 문구를 고르므로(§9 ERROR_KEY) code 를 살려야 한다.
//  · 봉인 요청도 Rust `task_local`(e2ee.rpc, method 가 task./git. 일 때만)로 보낸다 — e2ee_local 은 읽기 10초라
//    task.diff(30s) 가 먼저 코드 없이 끊긴다.
//
// 경로 3종(§2.13 "code 가 도착하는 자리"):
//  이 PC 호스트 → task_local(유닉스 소켓) → 실패 `CODE: msg`
//  다른 PC + 봉인 → task_local('e2ee.rpc') → {ok:false, e, code} 또는 `E2EE_…: msg`
//  다른 PC + 평문 → back_api POST /api/daemon/task → 실패 `HTTP 500 CODE: msg`
//
// ⚠ 이 파일은 import 시점에 window.__TAURI__ 를 건드리지 않는다(node 테스트가 createTaskApi 를 직접 돌린다).
import { rpcFailCode } from "./e2ee-fallback.js";

/** back 평문 allow-list 의 타임아웃(§3.3) — 클라 HTTP 타임아웃은 여기에 +5s. */
export const TASK_TIMEOUTS = Object.freeze({
  "task.list": 15000, "task.get": 15000, "task.create": 15000, "task.run.prompt": 20000, "task.run.trust": 15000,
  "task.run.reopen": 15000, "task.diff": 30000, "task.discard": 15000, "task.delete": 15000,
  "git.branches": 15000, "git.status": 15000, "git.files": 15000, "git.commit": 15000, "git.push": 15000,
  "git.pr.create": 15000, "git.pr.status": 30000, "git.pr.merge": 15000, "git.merge.local": 15000, "git.gh.status": 15000,
  // PR 후속(automation-design §4.3·§7.1) — back TASK_RPC_OK 추가 2줄과 같다.
  "task.run.fix": 15000, "task.run.followup.dismiss": 15000,
});

/** 읽기 — 실패 시 1회 재시도 가능(§3.2). 나머지는 전부 변이이며 재시도하지 않는다(opId 재전송은 호출부 몫). */
export const TASK_READS = new Set(["task.list", "task.get", "task.diff", "git.status", "git.files", "git.pr.status", "git.branches", "git.gh.status"]);

/** 평문 폴백이 허용되는 봉인 실패 코드 = back SEALED_STRUCTURAL ∪ {E2EE_NO_ENVELOPE, E2EE_BAD_METHOD} ∪ 구 데몬 코드. */
export const SEALED_FALLBACK_CODES = new Set([
  "E2EE_UNSUPPORTED", "E2EE_DISABLED", "E2EE_SCOPE", "E2EE_NO_KEY",
  "E2EE_NO_ENVELOPE", "E2EE_BAD_METHOD", "E2EE_UNKNOWN_CMD",
]);

// back 릴레이 타임아웃 문구(daemonRelayService.js:475). 새 데몬은 back 의 detail.code/HTTP status 를 보존해
//  `E2EE_NO_KEY`·`E2EE_DISABLED`·`E2EE_UNSUPPORTED`(코드 없는 404/501)·`DAEMON_OFFLINE`(409)·`TIMEOUT` 으로
//  준다(e2ee-local.js rpc catch) — 구조적 코드는 SEALED_FALLBACK_CODES 로 평문 폴백된다. **구 데몬**은 여전히
//  전부 E2EE_RELAY_FAILED 로 접으므로 그때는 이 문구가 타임아웃의 유일한 흔적이다(폴백은 계속 금지).
//  ★ 판정에 쓰는 곳은 "TIMEOUT 으로 **표시**할지" 뿐이다 — 폴백 여부는 이 문구와 무관하게 항상 "금지".
const RELAY_TIMEOUT_RE = /RPC 타임아웃|timed? ?out/i;

/** 작업 RPC 실패 — code 로만 분기한다(message 는 표시·진단용 원문). */
export class TaskError extends Error {
  constructor(code, message, extra) {
    super(message || code || "task rpc failed");
    this.name = "TaskError";
    this.code = code || "";
    Object.assign(this, extra || {});
  }
}

/**
 * 실패 문자열 → {code, message, status}.
 *  · `HTTP 500 GH_NOT_AUTHED: 메시지`(back_api) · `HTTP 404`(구 back — 라우트 없음)
 *  · `RUN_BUSY: 메시지`(로컬 소켓 cpt_request_coded)
 *  · `요청 실패: … timed out`(ureq 전송 실패) · 그 밖 = code ""
 */
export function parseCodedError(err) {
  const msg = err == null ? "" : String((err && err.message) || err);
  let m = /^HTTP (\d{3})(?: ([A-Z][A-Z0-9_]{1,63}))?(?:: ([\s\S]*))?$/.exec(msg);
  if (m) return { status: Number(m[1]), code: m[2] || "", message: m[3] || msg };
  const code = rpcFailCode(msg);
  if (code) return { status: 0, code, message: msg.slice(code.length + 1).trim() };
  if (/^요청 실패:/.test(msg) && RELAY_TIMEOUT_RE.test(msg)) return { status: 0, code: "TIMEOUT", message: msg };
  return { status: 0, code: "", message: msg };
}

/**
 * @param {object} deps
 *  local(cmd, args)        — Rust task_local(이 PC 데몬). 봉인 요청도 여기로(cmd='e2ee.rpc').
 *  backApi({method, path, body, timeoutSecs}) — Rust back_api.
 *  e2ee()                  — { ready:boolean, policy:'off'|'preferred'|'required' } (지금 봉인 가능한가)
 *  isLocalHost(host)       — 이 PC 데몬인가(유닉스 소켓 직결 대상)
 *  now()                   — 테스트 시계(기본 Date.now)
 */
export function createTaskApi(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  // 호스트별 봉인 미지원 네거티브 캐시(10분) — sealedRpc 와 같은 이유(미지원 호스트로 매번 왕복 금지).
  const sealedOffUntil = new Map();
  const SEALED_OFF_MS = 10 * 60 * 1000;
  const hk = (h) => (h == null ? "self" : String(Number(h)));

  async function viaLocal(method, params) {
    try {
      return await d.local(method, params || {});
    } catch (e) {
      const p = parseCodedError(e);
      throw new TaskError(p.code, p.message, { path: "local" });
    }
  }

  async function viaSealed(method, params, host, timeoutMs) {
    let r;
    try {
      r = await d.local("e2ee.rpc", { method, params: params || {}, hostDeviceId: host ?? null, timeoutMs });
    } catch (e) {
      const p = parseCodedError(e);
      if (SEALED_FALLBACK_CODES.has(p.code)) return { fallback: true, code: p.code };
      // 그 외(E2EE_RELAY_FAILED·EPOCH·DECRYPT·코드 없음) = 호스트가 실행했을 수도 있다 → 폴백 금지.
      const code = p.code === "E2EE_RELAY_FAILED" && RELAY_TIMEOUT_RE.test(p.message) ? "TIMEOUT"
        : p.code || "TIMEOUT"; // 코드 없는 실패 = 로컬 소켓 읽기 타임아웃(35s) — 결과 불명
      throw new TaskError(code, p.message, { path: "sealed", sealedCode: p.code });
    }
    if (r && r.ok === false) {
      // 호스트가 **실행하고** 실패했다 — 도메인 code 를 그대로 올린다(평문 재전송 절대 금지).
      throw new TaskError(r.code || "", r.e || r.error || "", { path: "sealed" });
    }
    const out = r && r.r !== undefined ? r.r : r;
    return { value: out == null ? {} : out };
  }

  async function viaPlain(method, params, host, timeoutMs) {
    try {
      const res = await d.backApi({
        method: "POST", path: "/api/daemon/task",
        body: { method, params: params || {}, ...(host != null ? { hostDeviceId: host } : {}) },
        timeoutSecs: Math.ceil(timeoutMs / 1000) + 5,
      });
      if (res && res.success === false) throw new TaskError((res.detail && res.detail.code) || "", res.message || "", { path: "plain" });
      return res && res.data !== undefined ? res.data : res;
    } catch (e) {
      if (e instanceof TaskError) throw e;
      const p = parseCodedError(e);
      // 404/405 = 구 back(라우트 없음) → 화면이 serverNeedsUpdate 를 그린다.
      const code = p.code || (p.status === 404 || p.status === 405 ? "SERVER_NEEDS_UPDATE" : p.status === 409 ? "DAEMON_OFFLINE" : "");
      throw new TaskError(code, p.message, { path: "plain", status: p.status });
    }
  }

  async function once(method, params, host, timeoutMs) {
    if (d.isLocalHost && d.isLocalHost(host)) return viaLocal(method, params);
    const st = (d.e2ee && d.e2ee()) || { ready: false, policy: "off" };
    const off = (sealedOffUntil.get(hk(host)) || 0) > now();
    if (st.ready && !off) {
      const r = await viaSealed(method, params, host, timeoutMs);
      if (!r.fallback) return r.value;
      sealedOffUntil.set(hk(host), now() + SEALED_OFF_MS);
    }
    if (st.policy === "required") {
      throw new TaskError("E2EE_REQUIRED", "종단간 암호화가 '항상' 으로 설정돼 있어 평문으로 보낼 수 없어요", { path: "sealed" });
    }
    return viaPlain(method, params, host, timeoutMs);
  }

  /**
   * 작업 RPC 1건. @returns 결과 객체 @throws TaskError(code)
   *  읽기는 TIMEOUT/전송 실패에서 1회 재시도한다. 변이는 재시도하지 않는다 — 호출부가 task.get 으로 실제 결과를 본다.
   */
  async function taskRpc(method, params, host, timeoutMs) {
    const t = timeoutMs || TASK_TIMEOUTS[method] || 15000;
    try {
      return await once(method, params, host, t);
    } catch (e) {
      const retryable = TASK_READS.has(method) && e instanceof TaskError && (e.code === "TIMEOUT" || e.code === "");
      if (!retryable) throw e;
      return once(method, params, host, t);
    }
  }

  return { taskRpc, _sealedOffUntil: sealedOffUntil };
}

// ── 기본 인스턴스(앱 런타임) ─────────────────────────────────────────────────────
//  api.js/state.js/e2ee.js 는 window.__TAURI__ 에 닿으므로 **동적 import** 로만 연다.
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
  _inst = createTaskApi({
    local: (cmd, args) => m.api.taskLocal(cmd, args),
    // ★ 비동기판 — 동기 back_api 는 Tauri 메인 스레드에서 돌아 최대 35초 UI 를 얼린다.
    backApi: (o) => m.api.backApiAsync(o.method, o.path, o.body ?? null, o.timeoutSecs),
    e2ee: () => ({ ready: m.E.e2eeReady(), policy: m.E.policyRequired() ? "required" : "preferred" }),
    isLocalHost: (h) => h == null || isLocalHostId(m.S.state, h),
  });
  return _inst;
}

/** 이 PC 데몬인가 — daemon_status 의 deviceId 와 같을 때만(모르면 원격으로 본다: 원격 경로는 이 PC 도 받는다). */
export function isLocalHostId(st, host) {
  const my = st && st.daemon ? st.daemon.deviceId : null;
  return my != null && host != null && Number(host) === Number(my);
}

export async function taskRpc(method, params, host, timeoutMs) {
  return (await inst()).taskRpc(method, params, host, timeoutMs);
}

// ── 호스트 caps(§2.3) — GET /api/daemon/status 의 runners[].caps 가 유일한 출처 ─────────────
//  runner_status 프레임에는 caps 가 없다 → online 전이마다 이 조회를 다시 한다(PC 앱 업데이트로 caps 가 바뀐다).
const capsByHost = new Map(); // host → string[]
let serverCaps = null;        // string[] | null(모름)
let capsInflight = null;
let capsListeners = new Set();

export function hostCaps(host) {
  return capsByHost.get(Number(host)) || null;
}
export function hostHasTasks(host) {
  const c = hostCaps(host);
  return c == null ? null : c.includes("task.v1"); // null = 모름(아직 조회 전·오프라인)
}
export function serverHasTasks() {
  return serverCaps == null ? null : serverCaps.includes("task.v1");
}
/** 서버가 그 능력을 광고하는가. null = 모름(아직 조회 전). 채팅 v2(conv.v1) 게이팅이 쓴다. */
export function serverHasCap(cap) {
  return serverCaps == null ? null : serverCaps.includes(String(cap));
}
export function onCapsChanged(fn) { capsListeners.add(fn); return () => capsListeners.delete(fn); }

export async function refreshHostCaps() {
  if (capsInflight) return capsInflight;
  capsInflight = (async () => {
    try {
      const { api } = await mods();
      const r = await api.backApiAsync("GET", "/api/daemon/status", null, 12);
      const data = (r && (r.data || r)) || {};
      capsByHost.clear();
      for (const x of data.runners || []) {
        if (x && x.deviceId != null) capsByHost.set(Number(x.deviceId), Array.isArray(x.caps) ? x.caps.slice() : []);
      }
      if (Array.isArray(data.serverCaps)) serverCaps = data.serverCaps.slice();
      for (const fn of capsListeners) { try { fn(); } catch (_) { /* noop */ } }
    } catch (_) {
      /* 서버 미가용 — 옛 값 유지(모름으로 떨어뜨리지 않는다: 배너가 깜빡인다) */
    } finally {
      capsInflight = null;
    }
  })();
  return capsInflight;
}

/** runner_status 수신(ui-channel) — online 전이면 caps 재조회, offline 이면 그 host caps 를 잊는다. */
export function noteRunnerStatus(ev) {
  if (!ev || ev.deviceId == null) return;
  if (ev.online === false) { capsByHost.delete(Number(ev.deviceId)); return; }
  void refreshHostCaps();
}

// ── 원격 PC 의 에이전트 목록(새 작업 시트의 칩) ───────────────────────────────────
//  api.agentsLocal 은 **이 PC** 데몬만 본다(agents-view.js). 다른 PC 는 봉인 agents.list → 평문 GET /agents.
//  읽기라 폴백이 안전하다(변이 아님) → 기존 sealedRpc(봉투 실패 = null = 폴백) 를 그대로 쓴다.
export async function agentsRemote(hid) {
  const { api, E } = await mods();
  try {
    const r = await E.sealedRpc("agents.list", { refresh: false }, hid, 15000);
    if (r) return { agents: r.agents || [], onboardedAt: r.onboardedAt || null };
  } catch (_) { /* 평문으로 */ }
  const r = await api.backApiAsync("GET", `/api/daemon/agents?hostDeviceId=${encodeURIComponent(String(hid))}`, null, 20);
  const data = (r && (r.data || r)) || {};
  return { agents: data.agents || [], onboardedAt: data.onboardedAt || null };
}

/** 변이용 opId(클라 UUID v4, §2.12). */
export function newOpId() {
  try { return crypto.randomUUID(); } catch (_) {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}
