// e2ee.js — 종단간 암호화(기능2) PC UI 측 상태/조작.
//
// ★ 열쇠 custody 결정: **마스터키(MK)는 JS 로 내려오지 않는다.**
//   PC 앱과 사이드카 데몬은 같은 머신·같은 신뢰 도메인이고(설계 §2.3), 데몬은 이미
//   `~/.codingpt/e2ee.json`(0600) 의 소유자이며 node 내장 crypto 를 갖고 있다.
//   그래서 MK 가 필요한 연산(봉인/개봉/서명/봉투 RPC)은 전부 `cpt.sock` 로 데몬에 위임하고,
//   여기서는 **공개 입력 파생**(확인 숫자 4자리·지문 6자리·QR 핀)만 vendored 코어로 계산한다.
//   → Rust 에 암호 크레이트를 넣지 않아도 되고, deviceToken 처럼 비밀이 JS 에 노출되지 않는다.
//
// cpt.sock 계약(데몬 runner-core 가 구현 — `e2ee.` 접두사만 Rust 가 통과시킨다):
//   e2ee.state                        → { available, state, epoch, policy, scope, ikX, userRef,
//                                         enrollmentId, recoverySet, reason }
//   e2ee.pending                      → { pending:[{enrollmentId,label,platform,ikX,requestedAt,
//                                          verifyCode(서버 계산값 — 로컬 계산과 대조용)}] }
//   e2ee.approve {enrollmentId, ikX}   → { ok:true }        (MK 봉인 + 서명 + 업로드)
//   e2ee.deny    {enrollmentId}        → { ok:true }
//   e2ee.policy  {policy}              → { policy }
//   e2ee.keyring                       → { epoch, devices:[{deviceKeyId,label,platform,ikX,state}] }
//   e2ee.revoke  {deviceKeyId}         → { epoch }           (신뢰 해제 + epoch 회전)
//   e2ee.recovery.create               → { code }            (1회 표시)
//   e2ee.recovery.restore {code}       → { ok:true, epoch }  (전 기기 소실 시 복원)
//   e2ee.openText {text}               → { text, locked }    (알림 body "cptenc:1:…" 복호)
//   e2ee.rpc {method, params, hostDeviceId, timeoutMs}
//                                      → { ok:true, r } | { ok:false, e, code }
//
// ★ 무마찰 불변식: 데몬이 구버전이라 위 명령을 모르면 **전부 조용히 미지원 상태로 떨어진다**.
//   워크스페이스·터미널·IDE·프리뷰·알림은 그대로 동작한다(평문). 여기서 throw 를 새어나가게 하지 않는다.
import { api } from "./api.js";
import * as S from "./state.js";
import { state } from "./state.js";
import { verifyCode4, fingerprint6, qrPin, isSealedBody } from "../vendor/e2ee/e2ee-proto.js";
import { b64uDec } from "../vendor/e2ee/e2ee-core.js";

// UI 가 읽는 단일 상태(모바일 e2ee.ts getStatus() 와 같은 정보 구조).
export const e2ee = {
  available: false,       // 데몬이 e2ee 명령을 이해하는가
  state: "off",           // off | unsupported | bootstrap | pending | trusted | error | unavailable
  epoch: 0,
  policy: "preferred",    // off | preferred | required
  scope: "rpc",
  ikX: null,              // 이 머신(데몬) 기기 공개키 b64u — 지문 계산 입력
  userRef: "",            // 확인 숫자 파생 기준(서버가 준 문자열 — 모바일과 동일 값이어야 한다)
  verifyCode: null,       // 이 기기가 pending 일 때 화면에 크게 띄우는 4자리
  fingerprint: null,      // 감사용 6자리
  recoverySet: false,
  reason: null,
  pending: [],            // 승인 대기 중인 다른 기기들(확인 숫자는 로컬 계산)
  devices: [],            // 열쇠를 가진 기기(키링)
};

function ready() { return e2ee.available && e2ee.state === "trusted" && e2ee.policy !== "off"; }
export function e2eeReady() { return ready(); }
/**
 * ui_hello 에 실을 caps — 실제로 그 단계를 수행할 수 있을 때만 신고(config/caps.js 규약).
 *  ★ 단계별로 쪼갠 문자열을 쓴다(서버 SERVER_CAPS 와 동일 이름): 'e2ee.v1' 처럼 뭉치면 아직 배관이
 *    없는 단계(스트림 등)를 켜서 프레임이 조용히 유실된다.
 */
export function e2eeCaps() {
  if (!ready()) return [];
  const caps = ["e2ee.keys.v1"];
  if (e2ee.scope !== "off") caps.push("e2ee.rpc.v1");
  if (e2ee.scope === "stream") caps.push("e2ee.stream.v1");
  return caps;
}
/** 정책이 'required' 인가 — LAN 직결(평문 leg)을 막는 근거. lan.js 가 순환 없이 조회한다. */
export function policyRequired() { return e2ee.policy === "required"; }

/** policy='required' 인데 준비가 안 됐다 = 암호화가 필요한 조작을 막고 사유를 보여준다. */
export function e2eeGate() {
  if (e2ee.policy !== "required" || ready()) return null;
  if (e2ee.state === "pending") return "승인 대기 중 — 기존 기기에서 이 PC 를 승인해 주세요.";
  if (!e2ee.available || e2ee.state === "unsupported") return "이 PC 데몬이 아직 종단간 암호화를 지원하지 않아요(업데이트 필요).";
  return "종단간 암호화를 준비하는 중이에요.";
}

async function cpt(cmd, args) {
  try {
    const r = await api.e2eeLocal(cmd, args || {});
    return r || null;
  } catch (e) {
    // 데몬 미기동/구버전/명령 미지원 — 미지원 상태로 내려놓고 조용히 진행(평문 폴백).
    if (e2ee.available) { e2ee.available = false; e2ee.state = "unsupported"; }
    return null;
  }
}

function deriveDisplay() {
  try {
    if (e2ee.ikX) {
      const pub = b64uDec(e2ee.ikX);
      e2ee.fingerprint = fingerprint6(pub, e2ee.userRef);
      e2ee.verifyCode = e2ee.state === "pending" ? verifyCode4(pub, e2ee.userRef) : null;
    } else {
      e2ee.fingerprint = null;
      e2ee.verifyCode = null;
    }
  } catch (_) { e2ee.fingerprint = null; e2ee.verifyCode = null; }
  // 대기 목록의 확인 숫자는 **ikX 에서 로컬 계산**이 원칙(서버 위조 차단). 다만 파생 기준(userRef)이
  //  어긋나 서버 값과 다르면 서버 값을 쓴다 — 폰과 PC 화면의 숫자가 달라 보이면 사용자가 정당한 승인을
  //  거절하게 되기 때문이다(대신 verified=false 로 표시해 "검증 불가"를 알린다).
  e2ee.pending = e2ee.pending.map((p) => {
    try {
      const pub = b64uDec(p.ikX);
      const local = verifyCode4(pub, e2ee.userRef);
      const server = typeof p.serverVerifyCode === "string" ? p.serverVerifyCode
        : (typeof p.verifyCodeFromServer === "string" ? p.verifyCodeFromServer : null);
      const use = server && server !== local ? server : local;
      return { ...p, verifyCode: use, verified: !server || server === local, fingerprint: fingerprint6(pub, e2ee.userRef) };
    } catch (_) { return { ...p, verifyCode: "----", verified: false, fingerprint: "" }; }
  });
  e2ee.devices = e2ee.devices.map((d) => {
    try { return { ...d, fingerprint: fingerprint6(b64uDec(d.ikX), e2ee.userRef) }; } catch (_) { return { ...d, fingerprint: "" }; }
  });
}

/** 상태 갱신(부팅·설정 진입·WS 이벤트·주기). 실패해도 조용히 미지원 처리. */
export async function refreshE2ee() {
  const st = await cpt("e2ee.state");
  if (!st) { deriveDisplay(); S.emit(); return; }
  e2ee.available = st.available !== false;
  e2ee.state = String(st.state || "off");
  e2ee.epoch = Number(st.epoch || 0);
  if (st.policy) e2ee.policy = String(st.policy);
  if (st.scope) e2ee.scope = String(st.scope);
  e2ee.ikX = st.ikX || null;
  e2ee.userRef = typeof st.userRef === "string" ? st.userRef : "";
  e2ee.recoverySet = !!st.recoverySet;
  e2ee.reason = st.reason || null;
  const pend = await cpt("e2ee.pending");
  e2ee.pending = pend && Array.isArray(pend.pending) ? pend.pending : [];
  const kr = await cpt("e2ee.keyring");
  e2ee.devices = kr && Array.isArray(kr.devices) ? kr.devices : [];
  deriveDisplay();
  S.emit();
}

/** device_approval_event(WS) 반영 — push 는 즉시성 힌트, pull(refreshE2ee)이 정본. */
export function applyDeviceApprovalEvent(ev) {
  if (!ev) return;
  if (ev.kind === "request") {
    if (ev.enrollmentId && ev.ikX) {
      const i = e2ee.pending.findIndex((p) => p.enrollmentId === ev.enrollmentId);
      const row = { enrollmentId: ev.enrollmentId, label: ev.label || "새 기기", platform: ev.platform || null, ikX: ev.ikX, requestedAt: ev.requestedAt || new Date().toISOString() };
      if (i >= 0) e2ee.pending[i] = row; else e2ee.pending.push(row);
      deriveDisplay();
      S.emit();
    }
    void refreshE2ee();
  } else if (ev.kind === "resolved") {
    // 다른 기기가 먼저 처리 → 카드 즉시 회수(크로스기기 dismiss 와 같은 타이밍).
    e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== ev.enrollmentId);
    S.emit();
    void refreshE2ee();
  }
}

export async function approveDevice(enrollmentId) {
  const row = e2ee.pending.find((p) => p.enrollmentId === enrollmentId);
  if (!row) return { ok: false, error: "요청을 찾을 수 없어요." };
  const r = await cpt("e2ee.approve", { enrollmentId, ikX: row.ikX });
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "승인을 전달하지 못했어요." };
  e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== enrollmentId);
  S.emit();
  void refreshE2ee();
  return { ok: true };
}
export async function denyDevice(enrollmentId) {
  const r = await cpt("e2ee.deny", { enrollmentId });
  e2ee.pending = e2ee.pending.filter((p) => p.enrollmentId !== enrollmentId);
  S.emit();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "거절을 전달하지 못했어요." };
  return { ok: true };
}
export async function setPolicy(policy) {
  e2ee.policy = policy; // 낙관적(토글 즉시 반영 = 킬스위치 체감)
  S.emit();
  await cpt("e2ee.policy", { policy });
  await refreshE2ee();
}
export async function createRecoveryCode() {
  const r = await cpt("e2ee.recovery.create");
  if (!r || !r.code) return null;
  e2ee.recoverySet = true;
  S.emit();
  return String(r.code);
}
/** 복구 코드로 복원(모든 신뢰 기기 소실) — 코드 자체가 열쇠를 담으므로 데몬이 파싱·저장한다. */
export async function restoreFromRecovery(code) {
  const r = await cpt("e2ee.recovery.restore", { code: String(code || "") });
  await refreshE2ee();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "복구 코드가 올바르지 않아요(오타 확인)." };
  return { ok: true };
}
export async function revokeTrust(deviceKeyId) {
  const r = await cpt("e2ee.revoke", { deviceKeyId });
  await refreshE2ee();
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || "신뢰 해제에 실패했어요." };
  return { ok: true };
}

/**
 * 봉투 RPC — 데몬이 봉인해 back 에 보낸다(서버는 메서드명조차 못 본다).
 * @returns { ok:true, r } | null(미지원 → 호출부가 기존 평문 경로로 폴백) | throws(진짜 실패)
 *  ⚠ 실패를 빈 결과로 뭉개지 않는다 — 리컨실러가 "0개"로 오판해 레이아웃을 지운 사고가 있었다.
 */
//  ★ 네거티브 캐시: 데몬/서버에 봉투 배관이 없는 동안 **fs 호출마다 소켓 왕복이 한 번 더** 붙으면
//    IDE 트리/파일 열기가 전부 느려진다. 한 번 미지원을 보면 TTL 동안 곧바로 평문 경로로 간다.
const RPC_UNSUPPORTED_TTL_MS = 10 * 60 * 1000;
let rpcUnsupportedUntil = 0;

export async function sealedRpc(method, params, hostDeviceId, timeoutMs) {
  if (!ready() || Date.now() < rpcUnsupportedUntil) {
    const gate = e2eeGate();
    if (gate) throw new Error(gate); // required 에서는 평문 폴백 금지
    return null;
  }
  const r = await cpt("e2ee.rpc", { method, params: params || {}, hostDeviceId: hostDeviceId ?? null, timeoutMs: timeoutMs || 15000 });
  if (!r) { rpcUnsupportedUntil = Date.now() + RPC_UNSUPPORTED_TTL_MS; return null; } // 미지원 → 폴백
  if (r.ok === false) throw new Error(r.e || r.error || "요청이 실패했어요.");
  // ⚠ 성공했는데 결과가 비어 있어도 **절대 null 을 돌려주지 않는다** — 호출부가 폴백으로 오해해
  //   같은 변형(fs.write 등)을 평문으로 한 번 더 실행하는 이중 실행이 된다.
  const out = r.r === undefined ? r : r.r;
  return out === null || out === undefined ? {} : out;
}

// ── 알림 body 복호(비동기) ──────────────────────────────────────
//  MK 가 데몬에 있으므로 복호도 비동기다. 렌더는 동기라 "🔒 …" 자리표시자를 먼저 그리고,
//  복호되면 그 행만 갈아끼운 뒤 emit 한다(캐시로 반복 요청 방지).
const bodyCache = new Map(); // sealed body → 평문 | null
export function notifBodyText(body) {
  if (!isSealedBody(body)) return body || "";
  if (bodyCache.has(body)) return bodyCache.get(body) || "🔒 암호화된 내용(이 기기에 열쇠 없음)";
  bodyCache.set(body, null);
  void (async () => {
    const r = await cpt("e2ee.openText", { text: body });
    bodyCache.set(body, r && r.text ? String(r.text) : null);
    S.emit();
  })();
  return "🔒 복호화 중…";
}

/** QR 핀 대조(다른 기기가 이 PC 를 승인할 때 쓰는 값을 화면에 노출하기 위함). */
export function myQrPin() {
  try { return e2ee.ikX ? qrPin(b64uDec(e2ee.ikX)) : null; } catch (_) { return null; }
}

/** 부팅 시 1회 + 주기 갱신(60s). 로그인 전이면 데몬이 unsupported/off 를 준다. */
export function startE2ee() {
  void refreshE2ee();
  setInterval(() => { if (state.paired) void refreshE2ee(); }, 60000);
}

// lan.js 가 순환 import 없이 정책을 물어볼 수 있게 전역에 최소 표면만 노출한다.
//  (모듈 간 상호 참조를 만들면 초기화 순서에 따라 한쪽이 undefined 가 된다)
try { globalThis.__cptE2ee = { policyRequired }; } catch (_) { /* noop */ }
