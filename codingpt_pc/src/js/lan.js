// lan.js — LAN 직결(기능4) PC 측: grant 취득 + 포워더 upstream 전달 + 경로 표시.
//
// PC 는 LAN 클라이언트를 **직접 구현하지 않는다**. 사이드카 데몬(runner-core/lan.js)이
//  핸드셰이크·프레이밍·채널·히스테리시스(shouldTry/noteSuccess/noteHardFail)·연결별 릴레이 폴백을
//  전부 갖고 있으므로, PC 는 "직결 좌표(upstream)를 넘겨주는 일"만 한다. 자체 구현이 필요한 건 모바일뿐.
//
// 데이터 흐름(프리뷰 = F1)
//   PC JS ── back POST /api/daemon/lan/grant ──▶ 단명 grant(주소 후보 + secret)
//         └─ cpt.sock forward.start { port, token, upstream:{mode:'lan',…} } ──▶ 데몬
//   데몬은 연결마다 직결을 시도하고, 첫 바이트 전에 실패하면 **버퍼를 승계해 그 연결만 릴레이로** 넘긴다.
//   → 사용자에게는 아무것도 보이지 않는다. token(릴레이)을 항상 함께 넘기는 것이 폴백의 전제다.
//
// grant secret 이 웹뷰 JS 에 들어오는 것에 대하여
//   이미 `api.backApi` 가 /api/daemon/* 전체를 JS 에 열어 두었으므로(웹뷰의 어떤 스크립트든 스스로
//   /lan/grant 를 호출할 수 있다) 이 설계가 노출면을 새로 만들지는 않는다. 게다가 grant 는
//   단일 사용·10분·scope 제한·**같은 사설망 안에서만** 유효해 deviceToken 보다 훨씬 약한 자격이다.
//   (모바일은 반대로 앱이 직접 소켓을 들기 때문에 어차피 secret 을 만진다.)
//
// 절대 규율
//  · 직결 실패는 **사용자에게 아무것도 보이지 않는다**. 오프라인 표시/차단 UX 는 기존 경로(hostOnline)가
//    단독 판정한다 — 경로 상태와 호스트 상태는 완전히 분리된 두 값이다(설계 §5.3).
//  · 릴레이 경로(pane.js 의 forward/start·preview/start, remote-fs.js 의 back_api)는 한 줄도 지우지 않는다.
//  · 임계값 정본은 모바일 `codingpt_app/src/services/lanPath.ts`(단위 테스트 위치). 데몬도 자체 사본을
//    갖고 있으므로 숫자를 바꿀 때는 세 곳을 함께 본다.
import { api } from "./api.js";

const GRANT_REFRESH_MS = 8 * 60 * 1000;   // 서버 TTL 10분보다 짧게 선제 갱신
const COOLDOWN_BASE_MS = 60 * 1000;       // 실패 후 재시도 금지 구간
const COOLDOWN_MAX_MS = 15 * 60 * 1000;
const UNSUPPORTED_RETRY_MS = 30 * 60 * 1000; // 미지원(구 데몬/서버 off)은 오래 쉰다
const STATUS_CACHE_MS = 10 * 1000;        // 배지용 상태 조회 캐시

// hostDeviceId → { grant, at, cooldownUntil, cooldownMs, unsupported, direct, statusAt }
const _hosts = new Map();
const _inflight = new Map();
const _listeners = new Set();

function hostState(hid) {
  let s = _hosts.get(hid);
  if (!s) { s = { grant: null, at: 0, cooldownUntil: 0, cooldownMs: COOLDOWN_BASE_MS, unsupported: false, direct: false, statusAt: 0 }; _hosts.set(hid, s); }
  return s;
}
function notify() { for (const f of _listeners) { try { f(); } catch (_) { /* noop */ } } }
export function onLanChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

// 이 PC 의 안정 클라이언트 키 — state.deviceKey() 와 **같은 값**을 읽는다(state.js 를 import 하면
//  state→pane→lan 순환이 되므로 localStorage 키를 직접 본다. 키 이름을 바꾸면 양쪽을 함께 고칠 것).
function clientKey() {
  try { return localStorage.getItem("cpt.deviceKey") || ""; } catch (_) { return ""; }
}

function markUnsupported(s, why) {
  if (!s.unsupported) api.debugLog(`[lan] 직결 미지원 — 릴레이 유지 (${why || ""})`);
  s.unsupported = true;
  s.grant = null;
  s.cooldownUntil = Date.now() + UNSUPPORTED_RETRY_MS;
  if (s.direct) { s.direct = false; notify(); }
}
function markFail(s, why) {
  s.grant = null;
  s.cooldownUntil = Date.now() + s.cooldownMs;
  s.cooldownMs = Math.min(s.cooldownMs * 2, COOLDOWN_MAX_MS);
  api.debugLog(`[lan] 직결 준비 실패 — 릴레이 (${why || ""}), 재시도 ${Math.round((s.cooldownUntil - Date.now()) / 1000)}s 후`);
  if (s.direct) { s.direct = false; notify(); }
}

// back 에서 grant 취득(캐시). null = 직결 불가 → 호출측은 그냥 릴레이 좌표만 쓴다.
//  실패 코드는 **문구가 아니라 code** 로 판정한다(detail.code — back daemonController.lanGrant).
async function grantFor(hostDeviceId, scopes) {
  const hid = Number(hostDeviceId);
  if (!Number.isFinite(hid)) return null;
  const s = hostState(hid);
  if (s.grant && Date.now() - s.at < GRANT_REFRESH_MS) return s.grant;
  if (Date.now() < s.cooldownUntil) return null;
  const inflight = _inflight.get(hid);
  if (inflight) return inflight;
  const p = (async () => {
    let r = null;
    try {
      r = await api.backApi("POST", "/api/daemon/lan/grant", {
        hostDeviceId: hid, clientKey: clientKey(), kind: "pc", scopes: scopes || ["tcp"],
      });
    } catch (e) {
      // back 이 404/501(LAN_UNSUPPORTED)·409 를 주면 Rust 브리지가 Err 로 올린다 — 문구에 코드가 실린다.
      const msg = String(e && e.message ? e.message : e);
      if (/LAN_UNSUPPORTED|404|501/.test(msg)) markUnsupported(s, "server/daemon");
      else markFail(s, msg.slice(0, 80));
      return null;
    }
    if (!r || !Array.isArray(r.endpoints) || !r.endpoints.length) { markUnsupported(s, "no-endpoint"); return null; }
    s.unsupported = false;
    s.cooldownMs = COOLDOWN_BASE_MS;
    s.grant = r;
    s.at = Date.now();
    return r;
  })().finally(() => _inflight.delete(hid));
  _inflight.set(hid, p);
  return p;
}

/**
 * 포워더에 넘길 직결 좌표. null 이면 데몬은 기존처럼 릴레이만 쓴다.
 *  주소 후보 중 첫 번째(서버가 IPv4 우선 정렬)를 쓴다 — 여러 후보 순회는 데몬 몫이 아니라
 *  다음 grant 갱신에서 자연히 다른 후보를 받는 구조(단순함 우선).
 */
export async function upstreamFor(hostDeviceId, port) {
  const g = await grantFor(hostDeviceId, ["tcp"]);
  if (!g || !g.scopes || !g.scopes.includes("tcp")) return null;
  const ep = g.endpoints[0];
  return {
    mode: "lan", host: ep.host, lanPort: ep.port,
    grantId: g.grantId, secret: g.secret, clientKey: clientKey(), kind: "pc",
    hostDeviceId: Number(hostDeviceId), remotePort: Number(port),
  };
}

/** 사용자 제스처(새로고침·프리뷰 재오픈)·창 포커스 복귀 = 부활 트리거. 쿨다운을 1회 무시한다. */
export function revive(hostDeviceId) {
  const ids = hostDeviceId == null ? [..._hosts.keys()] : [Number(hostDeviceId)];
  for (const id of ids) {
    const s = _hosts.get(id);
    if (!s || s.unsupported) continue; // 미지원은 앞당기지 않는다(grant 스팸 방지)
    s.cooldownUntil = 0;
  }
}
/** 사용자가 명시적으로 다시 켠 경우 — 미지원 판정까지 초기화. */
export function resetHost(hostDeviceId) { _hosts.delete(Number(hostDeviceId)); notify(); }

// ── 표시(직결 배지) ────────────────────────────────────────────────────
//  데몬이 실제로 직결을 쓰고 있는지는 데몬만 안다(연결별 폴백이 있으므로 grant 취득 성공 ≠ 직결 중).
//  그래서 배지는 데몬의 경로 스냅샷(`lan.status`)만 근거로 켠다 — 이 커맨드가 없는 구 데몬에서는
//  **배지가 아예 안 뜨고 기능은 그대로 동작**한다(거짓 표시를 하지 않는 쪽을 택했다).
export function isDirect(hostDeviceId) {
  if (hostDeviceId == null) return false;
  const s = _hosts.get(Number(hostDeviceId));
  return !!s && s.direct;
}

/** 배지 갱신용 폴링(사이드바가 주기적으로 호출). 조용히 실패한다. */
export async function refreshStatus(hostDeviceId) {
  const hid = Number(hostDeviceId);
  if (!Number.isFinite(hid)) return;
  const s = hostState(hid);
  if (s.unsupported) return;
  if (Date.now() - s.statusAt < STATUS_CACHE_MS) return;
  s.statusAt = Date.now();
  let r = null;
  try { r = await api.lanStatus(hid); } catch (_) { return; } // 구 데몬 = 커맨드 없음 → 배지 없음
  const direct = !!(r && r.mode === "lan");
  if (direct !== s.direct) { s.direct = direct; notify(); }
}

/**
 * 원격 fs 등 RPC 1건을 LAN 으로. **null = 직결 미사용(릴레이로 가라)**.
 *  데몬의 진짜 실패(파일 없음/권한)는 throw 한다 — 빈 결과로 뭉개면 IDE/리컨실러가 오판한다(§5.3).
 *  ★ fs.watch 는 절대 넘기지 않는다: 데몬 watcher 가 프로세스 전역 단일이라 LAN watch 가 릴레이
 *    watch 를 죽여 IDE 라이브 동기화가 조용히 깨진다(설계 §5.6).
 */
// E2EE 정책이 'required' 인가 — 순환 import 를 피하려 지연 조회한다(e2ee.js 도 lan 을 참조할 수 있다).
function e2eePolicyRequired() {
  try {
    // eslint-disable-next-line no-undef
    const m = globalThis.__cptE2ee;
    if (m && typeof m.policyRequired === 'function') return !!m.policyRequired();
  } catch (_) { /* noop */ }
  return false;
}

export async function lanRpc(hostDeviceId, method, params) {
  const hid = Number(hostDeviceId);
  if (!Number.isFinite(hid)) return null;
  // ⚠ E2EE 정책이 'required' 면 LAN 직결을 쓰지 않는다.
  //  LAN leg 는 프레임별 암호가 없다(인증만 한다) → 직결을 먼저 시도하는 현재 순서에서 이 가드가
  //  없으면 "반드시 암호화" 를 선택한 사용자의 파일 내용이 조용히 평문 LAN 으로 내려간다.
  //  (모바일 daemonService.lanFs 에는 같은 가드가 이미 있다 — 두 플랫폼 정책이 일치해야 한다)
  if (e2eePolicyRequired()) return null;
  const s = hostState(hid);
  // 직결 중이 아니면 IPC 를 쏘지 않는다(구 데몬에서 매 호출 실패 왕복이 생기지 않게).
  if (!s.direct) { void refreshStatus(hid); return null; }
  let r = null;
  try { r = await api.lanRpc(hid, method, params); } catch (_) { markUnsupported(s, "lan.rpc 없음"); return null; }
  if (r && r.ok === true) return r.result === undefined ? null : r.result;
  const code = r && r.code;
  if (code === "LAN_UNSUPPORTED" || code === "LAN_SCOPE") { markUnsupported(s, code); return null; }
  if (code === "LAN_TIMEOUT" || code === "LAN_UNREACHABLE" || code === "LAN_AUTH_FAILED") { markFail(s, code); return null; }
  throw new Error((r && r.error) || "직결 RPC 실패");
}

// 창 포커스 복귀 = 부활 트리거(모바일 AppState active 와 같은 역할).
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => revive(null));
}

export default { onLanChange, isDirect, refreshStatus, upstreamFor, lanRpc, revive, resetHost };
