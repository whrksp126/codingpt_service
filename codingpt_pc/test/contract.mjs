// contract.mjs — 와이어 계약 회귀 테스트(PC 수신측). `npm test` 로 실행.
//
// 왜 이 형태인가
//  · 이 리포에는 번들러가 없다(src/js/* = 순수 ESM). 그래서 테스트도 번들러/DOM 프레임워크 없이
//    **최소 브라우저 스텁 + 동적 import** 로 실제 모듈을 그대로 구동한다.
//  · 앱을 띄워 검증할 수 없다: `npm run dev` 는 번들 사이드카 데몬을 기동해 사용자가 쓰는 데몬과
//    상호 kill 한다(리포 CLAUDE.md 경고). 그래서 IPC(invoke)를 스텁하고 로직만 고정한다.
//  · ★ 어서션은 **상대(back/데몬)가 실제로 보내는 JSON 을 하드코딩**한다. 과거에 back/데몬이 서로
//    다른 인코딩을 쓰는데 양쪽 단위테스트가 모두 초록이었던 사고(각자 자기 구현으로 검증)를 막기 위함.
//    계약 정본 = docs/구현설계-2026-07-25/11-배관-계약.md (§1.3 agent_state · §4.2 lan.*).
const calls = [];
let invokeImpl = async () => ({});
const invoke = async (cmd, args) => { calls.push([cmd, args]); return invokeImpl(cmd, args); };

globalThis.window = {
  __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
  addEventListener() {}, removeEventListener() {},
  location: { href: "http://localhost/" },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  // xterm 계열은 index.html 이 window 에 심는 전역 — 파싱/로직 검증에는 껍데기면 충분하다.
  FitAddon: { FitAddon: class { activate() {} fit() {} } },
  Terminal: class { open() {} write() {} onData() {} loadAddon() {} dispose() {} },
  WebLinksAddon: { WebLinksAddon: class {} },
  SearchAddon: { SearchAddon: class {} },
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
  body: { classList: { add() {}, remove() {} }, appendChild() {} },
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {} }),
};

const base = process.argv[2] || new URL("../src/js", import.meta.url).href;
const S = await import(`${base}/state.js`);
const lan = (await import(`${base}/lan.js`)).default;

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ── 갭1: agent_state 수신 ─────────────────────────────────────────
// back 이 실제로 보내는 형태를 그대로 하드코딩한다(계약 §1.3-②).
const frame = (over) => ({
  cwd: "other/project/codingpt", win: 1000123, state: "working", agent: "claude",
  version: 42, at: 1753432801000, sessionId: "21b28dc2-aaaa", source: "hook",
  since: 1753432800000, hostDeviceId: 12, kind: "local", ...over,
});
S.setAgentState(frame());
eq("push 수신 → state", S.agentStateOf("other/project/codingpt", 1000123)?.state, "working");
S.setAgentState(frame({ state: "idle", version: 41 }));
eq("version 역전 폐기(같은 호스트)", S.agentStateOf("other/project/codingpt", 1000123)?.state, "working");
S.setAgentState(frame({ state: "permission", version: 43 }));
eq("version 증가 수용", S.agentStateOf("other/project/codingpt", 1000123)?.state, "permission");
S.setAgentState(frame({ state: "idle", version: 1, hostDeviceId: 99 }));
eq("호스트 교체는 무조건 수용", S.agentStateOf("other/project/codingpt", 1000123)?.state, "idle");
// 데몬 재기동 = version 이 1부터 다시 시작한다(상시 이벤트: PC 업데이트/데몬 재시작). version 만 보면
//  새 프레임을 전량 폐기해 낡은 'working' 에 15분 고착한다 → **at 까지 후퇴했을 때만** 폐기한다.
//  (앱 agentStateStore.applyAgentState 와 같은 규칙 — 두 화면이 갈리면 안 된다)
S.setAgentState(frame({ cwd: "p/reboot", win: 7, state: "working", version: 42, at: 1753432801000 }));
S.setAgentState(frame({ cwd: "p/reboot", win: 7, state: "permission", version: 1, at: 1753432805000 }));
eq("데몬 재기동(version 리셋)이라도 at 이 전진하면 채택", S.agentStateOf("p/reboot", 7)?.state, "permission");
S.setAgentState(frame({ cwd: "p/reboot", win: 7, state: "idle", version: 0, at: 1753432803000 }));
eq("version·at 둘 다 후퇴 = 진짜 늦은 프레임 → 폐기", S.agentStateOf("p/reboot", 7)?.state, "permission");
S.setAgentState(frame({ state: "gone", version: 50, hostDeviceId: 99 }));
eq("gone → 키 삭제(폴백 복귀)", S.agentStateOf("other/project/codingpt", 1000123), null);
S.setAgentState(frame({ state: "working", version: 60 }));
S.setAgentState(frame({ state: "ended", version: 61 }));
eq("ended 도 소멸 취급(방어)", S.agentStateOf("other/project/codingpt", 1000123), null);
S.setAgentState(frame({ cwd: "", win: 3, state: "working", version: 1 }));
eq("cwd '' (홈) 허용", S.agentStateOf("", 3)?.state, "working");
// stale(15분 초과) → 폴백
S.setAgentState(frame({ state: "working", version: 70 }));
S.agentStates.get("other/project/codingpt|1000123").recvAt = Date.now() - 16 * 60 * 1000;
eq("15분 초과 push = stale → null", S.agentStateOf("other/project/codingpt", 1000123), null);
// 호스트 오프라인 → 폐기
S.setAgentState(frame({ state: "working", version: 80 }));
S.forgetAgentStatesForHost(12, "other/project/codingpt");
eq("호스트 오프라인 → 폐기", S.agentStateOf("other/project/codingpt", 1000123), null);
// hostDeviceId 미스탬프(구 back) → cwd 로 폐기
S.setAgentState({ cwd: "p/x", win: 5, state: "working" });
S.forgetAgentStatesForHost(null, "p/x");
eq("hostDeviceId 없으면 cwd 로 폐기", S.agentStateOf("p/x", 5), null);
// 제어 WS 재접속 → 전량 폐기(back 리플레이는 '삭제'를 표현할 수 없다 = 유령 방지, 계약 §1.5).
//  실제 배선(ui-channel onopen 이 이걸 부르는가)은 test/agentstate-reconnect.mjs 가 본다.
S.setAgentState(frame({ cwd: "p/reset", win: 9, state: "working", version: 1 }));
S.resetAgentStates();
eq("resetAgentStates → 전량 폐기(폴백 복귀)", S.agentStateOf("p/reset", 9), null);

// ── 갭4: LAN 배지/승격 ────────────────────────────────────────────
const seen = () => calls.map((c) => c[0]).filter((c) => c.startsWith("lan_"));
const clear = () => { calls.length = 0; };

// 1) 데몬이 relay → 배지 OFF + 승격 probe 1회
clear();
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "relay", hostDeviceId: 12, scopes: ["tcp"] };
  if (cmd === "lan_probe") return { ok: true, rttMs: 7, endpoint: { host: "192.168.0.31", port: 47321 } };
  return {};
};
await lan.refreshStatus(12);
await new Promise((r) => setTimeout(r, 20)); // maybePromote 는 fire-and-forget
eq("relay → 배지 OFF", lan.isDirect(12), false);
eq("relay → 승격 probe 발사", seen(), ["lan_status", "lan_probe"]);

// 2) 다음 폴링에서 mode:'lan' → 배지 ON
clear();
invokeImpl = async (cmd) => (cmd === "lan_status" ? { mode: "lan", hostDeviceId: 12, endpoint: { host: "192.168.0.31", port: 47321 } } : {});
await lan.refreshStatus(12);
eq("mode lan → 배지 ON", lan.isDirect(12), true);
// 배지 ON 이면 승격 probe 는 안 쏜다. 검증 probe(5분 간격)는 1번 케이스에서 방금 쏜 뒤라 아직 이르다.
eq("배지 ON 이면 probe 안 함", seen(), ["lan_status"]);

// 3) 구 사이드카(커맨드 없음) → 배지 OFF + 폴링 정지, **grant/upstream 은 죽이지 않는다**
clear();
lan.resetHost(13);
invokeImpl = async (cmd) => { if (cmd.startsWith("lan_")) throw new Error("unknown cmd"); return {}; };
await lan.refreshStatus(13);
eq("구 데몬 → 배지 OFF", lan.isDirect(13), false);
clear();
await lan.refreshStatus(13);
eq("구 데몬 → 폴링 정지(재시도 없음)", seen(), []);
clear();
invokeImpl = async (cmd, a) => {
  if (cmd === "back_api") return { grantId: "g1", secret: "s", scopes: ["tcp"], endpoints: [{ host: "192.168.0.31", port: 47321, family: 4 }] };
  return {};
};
const up = await lan.upstreamFor(13, 5173);
eq("lan.status 부재가 upstream(프리뷰 직결)을 죽이지 않음", up && up.mode, "lan");

// 4) mode:'unsupported' → 30분 휴면(배지 OFF)
clear();
lan.resetHost(14);
invokeImpl = async (cmd) => (cmd === "lan_status" ? { mode: "unsupported" } : {});
await lan.refreshStatus(14);
eq("mode unsupported → 배지 OFF", lan.isDirect(14), false);

// 5) e2ee policy=required → lanRpc 는 IPC 없이 null(릴레이). preferred 면 막지 않는다.
clear();
globalThis.__cptE2ee = { policyRequired: () => true };
eq("policy required → lanRpc null", await lan.lanRpc(12, "fs.read", { path: "a.ts" }), null);
eq("policy required → IPC 0건", seen(), []);
globalThis.__cptE2ee = { policyRequired: () => false };
clear();
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "lan" };
  if (cmd === "lan_rpc") return { ok: true, result: { content: "hi" } };
  return {};
};
await lan.refreshStatus(12);
eq("policy preferred → lanRpc 통과", await lan.lanRpc(12, "fs.read", { path: "a.ts" }), { content: "hi" });
// 6) 정책성 거절(LAN_SCOPE)은 조용히 릴레이(throw 금지)
clear();
lan.resetHost(15);
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "lan" };
  if (cmd === "lan_rpc") return { ok: false, code: "LAN_SCOPE", error: "scope" };
  return {};
};
await lan.refreshStatus(15);
let threw = false;
let res;
try { res = await lan.lanRpc(15, "fs.read", { path: "a.ts" }); } catch (_) { threw = true; }
eq("LAN_SCOPE → null(조용한 릴레이)", [threw, res], [false, null]);
// ★ scope 부족은 "이 호스트가 LAN 미지원"이 아니라 "이 메서드군만 미지원"이다. 기본 설정
//   (LAN_SCOPES='tcp')에서 정상적인 rpc 거절 1건이 grant 를 버리면 **켜져 있는 프리뷰 직결(tcp)까지
//   30분 죽는다** — 배지도 함께 꺼진다. 억제는 rpc 에만 걸려야 한다.
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "lan" };
  if (cmd === "back_api") return { grantId: "g1", secret: "s", scopes: ["tcp"], endpoints: [{ host: "192.168.0.31", port: 47321, family: 4 }] };
  return {};
};
eq("LAN_SCOPE 후에도 프리뷰 upstream 생존", (await lan.upstreamFor(15, 5173))?.mode, "lan");
await lan.refreshStatus(15);
eq("LAN_SCOPE 후에도 배지 유지", lan.isDirect(15), true);
clear();
eq("scope 거절 후 rpc 재왕복 없음", [await lan.lanRpc(15, "fs.read", { path: "b.ts" }), seen()], [null, []]);

// 7) lan.rpc 커맨드만 없는 사이드카(구버전) → rpc 만 쉬고 grant/upstream 은 살린다
clear();
lan.resetHost(16);
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "lan" };
  if (cmd === "lan_rpc") throw new Error("unknown cmd");
  if (cmd === "back_api") return { grantId: "g2", secret: "s", scopes: ["tcp"], endpoints: [{ host: "192.168.0.31", port: 47321, family: 4 }] };
  return {};
};
await lan.refreshStatus(16);
eq("lan.rpc 부재 → null(조용한 릴레이)", await lan.lanRpc(16, "fs.read", { path: "a.ts" }), null);
eq("lan.rpc 부재가 프리뷰 upstream 을 죽이지 않음", (await lan.upstreamFor(16, 5173))?.mode, "lan");

// 8) 시계 주입 — 승격/검증 probe 간격 규칙(정본 숫자: PROBE_GAP 60s · VERIFY_GAP 5분)
const realNow = Date.now;
let T = realNow();
Date.now = () => T;
const probeCount = () => seen().filter((c) => c === "lan_probe").length;
// 8-a) 'probing' 은 "승격 미완"이다 — 데몬(PROMOTE_OK_STREAK=2)이 아직 안 올렸을 수 있으므로 계속 부추긴다.
//      여기서 손을 놓으면 경로가 'probing' 에 영구 고착해 배지·fs 직결이 死文이 된다(교차검증 결함 #1/#2).
clear();
lan.resetHost(17);
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "probing" };
  if (cmd === "lan_probe") return { ok: true, rttMs: 7 };
  return {};
};
await lan.refreshStatus(17);
await new Promise((r) => setTimeout(r, 20));
T += 61000;
await lan.refreshStatus(17);
await new Promise((r) => setTimeout(r, 20));
eq("probing 이어도 60s 간격으로 계속 부추긴다", probeCount(), 2);
// 8-b) 'lan' 에서도 저빈도 검증 probe — 안 하면 집을 떠나 릴레이로 흘러도 '직결' 배지가 켜진 채 굳는다.
clear();
lan.resetHost(18);
invokeImpl = async (cmd) => {
  if (cmd === "lan_status") return { mode: "lan" };
  if (cmd === "lan_probe") return { ok: true, rttMs: 7 };
  return {};
};
await lan.refreshStatus(18);
await new Promise((r) => setTimeout(r, 20));
eq("lan 진입 시 검증 probe 1회", probeCount(), 1);
T += 60000;
await lan.refreshStatus(18);
await new Promise((r) => setTimeout(r, 20));
eq("검증 probe 는 1분 뒤엔 안 쏜다(5분 간격)", probeCount(), 1);
T += 5 * 60 * 1000;
await lan.refreshStatus(18);
await new Promise((r) => setTimeout(r, 20));
eq("5분 지나면 검증 probe 재발사", probeCount(), 2);
Date.now = realNow;

// ── 갭2 §2.10: 사람이 대조하는 값은 로컬 파생 60비트 안전코드 ──────────────
//  ★ e2ee.js 는 마지막에 import 한다: 모듈 최상단에서 globalThis.__cptE2ee 를 실물로 덮으므로
//    위 5)의 policyRequired 스텁과 충돌한다(LAN 테스트가 끝난 뒤여야 안전하다).
//  이 절이 고정하는 것 = "서버가 준 값을 표시하지 않는다". 여기가 깨지면 화면의 대조값을 서버가
//  지배하게 되고, 사용자가 두 화면을 비교하는 유일한 오프라인 방어 채널이 사라진다.
const core = await import("../src/vendor/e2ee/e2ee-core.js");
const proto = await import("../src/vendor/e2ee/e2ee-proto.js");
core.setRandomSource((n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 0xff; return b; });
const E = await import(`${base}/e2ee.js`);
const HL = await import(`${base}/host-lock.js`);

const selfPub = core.x25519Public(core.randomBytes(32));
const newPub = core.x25519Public(new Uint8Array(32).fill(9));
const selfIkX = core.b64uEnc(selfPub);
const newIkX = core.b64uEnc(newPub);
const wantSelfSafety = proto.safetyCode(selfPub, "u77");
const wantNewSafety = proto.safetyCode(newPub, "u77");
const wantNewCode4 = proto.verifyCode4(newPub, "u77");

// 데몬 응답을 하드코딩(계약 §2.4 의 result 형태). ★ 서버/데몬이 안전코드를 실어 보내도 무시해야 한다.
function e2eeStub(over) {
  const o = over || {};
  return async (cmd, args) => {
    if (cmd !== "e2ee_local") return {};
    if (args.cmd === "e2ee.state") {
      return {
        available: true, state: o.state || "trusted", epoch: 3, policy: "preferred", scope: "rpc",
        ikX: selfIkX, userRef: "u77", recoverySet: false,
        safetyCode: "ZZZZ-ZZZZ-ZZZZ", // 서버 위조 시나리오 — 절대 화면에 오르면 안 된다
      };
    }
    if (args.cmd === "e2ee.pending") {
      return { pending: o.pending || [] };
    }
    if (args.cmd === "e2ee.keyring") return { epoch: 3, devices: [] };
    return {};
  };
}

invokeImpl = e2eeStub({ state: "trusted" });
await E.refreshE2ee();
eq("이 PC 안전코드 = ikX 로컬 파생", E.e2ee.safetyCode, wantSelfSafety);
eq("서버가 준 안전코드는 무시한다", E.e2ee.safetyCode === "ZZZZ-ZZZZ-ZZZZ", false);
eq("trusted 면 요청번호(4자리)는 표시하지 않는다", E.e2ee.verifyCode, null);
eq("지문(6자리)도 로컬 파생", E.e2ee.fingerprint, proto.fingerprint6(selfPub, "u77"));

// 대기 카드: 안전코드는 항상 로컬, 요청번호만 서버 값과 대조한다.
invokeImpl = e2eeStub({
  pending: [{ enrollmentId: "e1", label: "iPad", platform: "ios", ikX: newIkX, verifyCode: wantNewCode4, safetyCode: "ZZZZ-ZZZZ-ZZZZ" }],
});
await E.refreshE2ee();
eq("대기 기기 안전코드 = 로컬 파생(서버 값 무시)", [E.e2ee.pending[0].safetyCode, E.e2ee.pending[0].verified], [wantNewSafety, true]);
invokeImpl = e2eeStub({
  pending: [{ enrollmentId: "e1", label: "iPad", platform: "ios", ikX: newIkX, verifyCode: "0000", safetyCode: "ZZZZ-ZZZZ-ZZZZ" }],
});
await E.refreshE2ee();
eq("요청번호가 서버와 다르면 서버 값 + verified=false(안전코드는 그대로 로컬)",
  [E.e2ee.pending[0].verifyCode, E.e2ee.pending[0].verified, E.e2ee.pending[0].safetyCode], ["0000", false, wantNewSafety]);
// 파생 기준이 어긋나도 안전코드는 흔들리지 않는다 = 대조 채널이 서버 손에 넘어가지 않는다.
eq("verified=false 여도 안전코드는 로컬 값", E.e2ee.pending[0].safetyCode === "ZZZZ-ZZZZ-ZZZZ", false);

// 이 PC 가 승인 대기 중이면 요청번호를 표시한다(구분용) — 대조값은 여전히 안전코드.
invokeImpl = e2eeStub({ state: "pending" });
await E.refreshE2ee();
eq("pending 이면 요청번호 표시", E.e2ee.verifyCode, proto.verifyCode4(selfPub, "u77"));
eq("pending 이어도 안전코드는 같은 로컬 값", E.e2ee.safetyCode, wantSelfSafety);

// state 확장값 방어(구/미래 데몬이 state 에 'enrolled' 를 실어 보내는 경우) — 모르는 값이 'ready' 로
//  새면 열쇠 없는 데몬에 봉인을 시도하고, 반대로 '꺼짐' 으로 뭉개면 사용자가 대기 중임을 알 수 없다.
//  ⚠ **오늘의 데몬은 state 에 이 값을 넣지 않는다**(pcState 도메인 = off|unsupported|bootstrap|pending|
//   trusted|error, e2ee-account.js:531-539). 진행상태 정본은 `keyState` 다 — 아래 절이 그걸 고정한다.
invokeImpl = async (cmd, args) => {
  if (cmd !== "e2ee_local") return {};
  if (args.cmd === "e2ee.state") return { available: true, state: "enrolled", epoch: 0, policy: "required", scope: "rpc", ikX: selfIkX, userRef: "u77" };
  if (args.cmd === "e2ee.pending") return { pending: [] };
  if (args.cmd === "e2ee.keyring") return { epoch: 0, devices: [] };
  return {};
};
await E.refreshE2ee();
eq("enrolled 는 준비 완료가 아니다(봉인 시도 금지)", E.e2eeReady(), false);
eq("enrolled 도 요청번호를 표시한다(승인 대기 화면)", E.e2ee.verifyCode, proto.verifyCode4(selfPub, "u77"));
eq("policy=required + enrolled → 게이트 사유 노출", E.e2eeGate(), "승인 대기 중 — 기존 기기에서 이 PC 를 승인해 주세요.");
eq("enrolled 에서는 caps 를 신고하지 않는다(교집합 게이팅)", E.e2eeCaps(), []);

// ── 갭2 §2.4: keyState/checking 이 정본 — "확인 중" 과 "영구 평문" 은 다른 화면이어야 한다 ──
//  ★ 이 절이 없으면 조용히 죽는 방식(실측): 계정에 열쇠가 0개면 데몬은
//   `{state:'bootstrap', keyState:'none', checking:false, phase:'bootstrap'}` 를 준다. 그런데 PC 가
//   keyState/checking 을 버리면 state='bootstrap' 만 보고 '준비 중'(대기색)을 그린다 — 사용자는
//   "곧 켜진다" 고 읽는데 실제로는 **영구 평문**이고, PC 에는 켤 버튼조차 없었다.
//  응답 JSON 은 데몬 e2ee-local.js state() 가 실제로 만드는 형태를 그대로 하드코딩한다.
const bootstrapCalls = [];
const stateStub = (over) => async (cmd, args) => {
  if (cmd !== "e2ee_local") return {};
  if (args.cmd === "e2ee.state") {
    return {
      available: true, state: "bootstrap", keyState: "none", checking: false, nextCheckInMs: null,
      accountEpoch: null, phase: "bootstrap", epoch: 0, policy: "preferred", scope: "rpc",
      ikX: selfIkX, userRef: "u77", enrollmentId: null, recoverySet: false, reason: null, ...(over || {}),
    };
  }
  if (args.cmd === "e2ee.pending") return { pending: [] };
  if (args.cmd === "e2ee.keyring") return { epoch: 0, devices: [] };
  if (args.cmd === "e2ee.bootstrap") { bootstrapCalls.push(args); return { ok: true, epoch: 1 }; }
  return {};
};

invokeImpl = stateStub({});
await E.refreshE2ee();
eq("keyState/checking/phase 를 상태로 복사한다", [E.e2ee.keyState, E.e2ee.checking, E.e2ee.phase], ["none", false, "bootstrap"]);
eq("계정 열쇠 0개(확인 끝) = '확인 중' 이 아니라 '열쇠 없음'", E.e2eeStateLabel(), { text: "열쇠 없음", tone: "off" });
eq("phase=bootstrap 이면 '처음 켜기' 버튼을 노출한다", E.e2eeNeedsBootstrap(), true);
await E.bootstrapAccount();
eq("버튼은 e2ee.bootstrap 커맨드를 부른다", bootstrapCalls.length, 1);

invokeImpl = stateStub({ checking: true, phase: "boot", nextCheckInMs: 4200 });
await E.refreshE2ee();
eq("확인 중이면 '확인 중'(대기색) — 평문이라고 단정하지 않는다", E.e2eeStateLabel(), { text: "확인 중", tone: "wait" });
eq("nextCheckInMs 도 보관(다음 확인까지 표기)", E.e2ee.nextCheckInMs, 4200);
eq("확인 중에는 '처음 켜기' 버튼을 내리지 않는다(phase 기준)", E.e2eeNeedsBootstrap(), false);

invokeImpl = stateStub({ state: "pending", keyState: "pending", checking: true, phase: "pending" });
await E.refreshE2ee();
eq("keyState=pending → '승인 대기'(확인 중보다 구체적)", E.e2eeStateLabel(), { text: "승인 대기", tone: "wait" });

invokeImpl = stateStub({ state: "pending", keyState: "enrolled", checking: true, phase: "pending" });
await E.refreshE2ee();
eq("keyState=enrolled(봉인문 대기) → '승인 대기'", E.e2eeStateLabel(), { text: "승인 대기", tone: "wait" });

// policy='required' 인데 계정에 열쇠가 0개면 "준비하는 중" 이라고 말해선 안 된다(영구 차단이 된다).
invokeImpl = stateStub({ policy: "required", keyState: "none", checking: false, phase: "bootstrap" });
await E.refreshE2ee();
eq("required + 열쇠 0개 → 게이트 사유가 '처음 켜기' 를 지목한다",
  E.e2eeGate(), "이 계정에 아직 암호화 열쇠가 없어요 — 설정 → 종단간 암호화 에서 '이 계정에 암호화 처음 켜기' 를 눌러 주세요.");
invokeImpl = stateStub({ policy: "required", keyState: "none", checking: true, phase: "boot" });
await E.refreshE2ee();
eq("required + 확인 중 → 기존 '준비하는 중' 문구", E.e2eeGate(), "종단간 암호화를 준비하는 중이에요.");

invokeImpl = stateStub({ state: "bootstrap", keyState: "none", checking: false, phase: "no_enroll_client", reason: null });
await E.refreshE2ee();
eq("취득 배관 없는 구 번들 = '열쇠 없음'", E.e2eeStateLabel(), { text: "열쇠 없음", tone: "off" });
eq("bootstrap 커맨드가 없는 데몬에는 버튼을 띄우지 않는다", E.e2eeNeedsBootstrap(), false);

// 넓은 도메인 데몬(2026-07-26 pcState 확장: checking 이면 'bootstrap', 아니면 'none', 봉인문 대기는
//  'enrolled') — `state` 가 달라져도 화면은 같아야 한다. 두 도메인이 동시에 배포돼 있다(계약 §2.4 규약 3).
invokeImpl = stateStub({ state: "none", keyState: "none", checking: false, phase: "bootstrap" });
await E.refreshE2ee();
eq("넓은 도메인 state='none' → '열쇠 없음'(라벨 동일)", E.e2eeStateLabel(), { text: "열쇠 없음", tone: "off" });
invokeImpl = stateStub({ state: "enrolled", keyState: "enrolled", checking: true, phase: "pending" });
await E.refreshE2ee();
eq("넓은 도메인 state='enrolled' → '승인 대기'(라벨 동일)", E.e2eeStateLabel(), { text: "승인 대기", tone: "wait" });
eq("state='enrolled' 에서도 요청번호를 표시한다(승인 대기 화면)", E.e2ee.verifyCode, proto.verifyCode4(selfPub, "u77"));

// 하위호환: keyState 를 아예 안 보내는 구 데몬은 '확인 중'(모르는 것을 '열쇠 없음' 으로 단정하지 않는다).
//  ★ 구 라벨 '준비 중' 은 폐기했다(카피 감사 §2-A: "곧 켜진다" 는 오해를 주는 유일한 문구였다) —
//   대기색·판정 순서는 그대로이고 문구만 '확인 중' 으로 흡수했다(앱도 같은 문구).
invokeImpl = async (cmd, args) => {
  if (cmd !== "e2ee_local") return {};
  if (args.cmd === "e2ee.state") return { available: true, state: "bootstrap", epoch: 0, policy: "preferred", scope: "rpc", ikX: selfIkX, userRef: "u77" };
  if (args.cmd === "e2ee.pending") return { pending: [] };
  if (args.cmd === "e2ee.keyring") return { epoch: 0, devices: [] };
  return {};
};
await E.refreshE2ee();
eq("구 데몬(keyState 없음) → '확인 중'(대기색 유지)", [E.e2eeStateLabel(), E.e2ee.keyState], [{ text: "확인 중", tone: "wait" }, null]);
eq("구 데몬에는 '처음 켜기' 버튼 없음", E.e2eeNeedsBootstrap(), false);

invokeImpl = stateStub({ state: "trusted", keyState: "trusted", checking: false, phase: "trusted", epoch: 3 });
await E.refreshE2ee();
// self 배지에 '켜짐' 을 쓰지 않는다(자기 열쇠 보유 ≠ 트래픽 암호화 — §2.7). 문구 정본 = 카피 감사 §4-1.
eq("열쇠 보유 = '열쇠 있음'", E.e2eeStateLabel(), { text: "열쇠 있음", tone: "on" });
invokeImpl = stateStub({ state: "off", keyState: "trusted", policy: "off", phase: "trusted", epoch: 3 });
await E.refreshE2ee();
eq("사용자가 끄면(policy=off) 열쇠가 있어도 '꺼짐'", E.e2eeStateLabel(), { text: "꺼짐", tone: "off" });

// ── 갭2 §2.7: 자물쇠는 호스트별로(거짓 자물쇠 금지) ─────────────────────
//  back 이 실제로 보내는 runner_status 를 하드코딩(daemonRelayService fanoutRunnerStatus).
HL.resetHostLocks();
eq("프레임 전 = 모름 → '확인 중'(평문으로 단정하지 않는다)", HL.hostLockLabel(true, HL.hostE2eeEpoch(12)).text, "확인 중");
eq("runner_status 반영됨", HL.applyRunnerStatus({ deviceId: 12, online: true, kind: "local", deviceName: "MacBook", e2eeEpoch: 3 }), true);
eq("열쇠 있는 PC = '암호화됨'", HL.hostLockLabel(true, HL.hostE2eeEpoch(12)).text, "암호화됨");
eq("같은 값 재수신은 emit 하지 않는다", HL.applyRunnerStatus({ deviceId: 12, online: true, e2eeEpoch: 3 }), false);
HL.applyRunnerStatus({ deviceId: 13, online: true, kind: "local", deviceName: "미니", e2eeEpoch: 0 });
eq("열쇠 없는 PC = '평문(열쇠 없음)'", HL.hostLockLabel(true, HL.hostE2eeEpoch(13)).text, "평문(열쇠 없음)");
eq("구 back(필드 없음) = '확인 중'", HL.hostLockLabel(true, HL.hostE2eeEpoch(99)).text, "확인 중");
eq("이 기기에 열쇠 없으면 무조건 '평문'", HL.hostLockLabel(false, 5).text, "평문");
eq("호스트 오프라인 → 항목 삭제(근거 없는 사진을 남기지 않는다)",
  [HL.applyRunnerStatus({ deviceId: 12, online: false }), HL.hostE2eeEpoch(12)], [true, undefined]);
eq("로그아웃 → 전량 폐기", [HL.resetHostLocks(), HL.hostE2eeEpoch(13)], [true, undefined]);

// ★ 자물쇠는 **세대(epoch)까지 교집합**이다(계약 §2.7, 앱 e2eeState.ts hostLockLabel 3인자와 동일 규칙).
//  왜: 데몬은 회전을 폴링으로만 감지하므로(TRUSTED_MS=15분) back 이 팬아웃하는 e2eeEpoch 는 그 동안
//  옛 세대다. 그 사이 이 화면이 새 세대로 봉인하면 데몬이 E2EE_EPOCH_MISMATCH(409) → 평문 REST 폴백인데
//  `hostEpoch>0` 만 보는 규칙은 초록 자물쇠를 그린다 = 최대 15분간 거짓 자물쇠.
eq("세대 불일치 → '암호화됨' 금지(회전 직후 거짓 자물쇠)", HL.hostLockLabel(true, 3, 4).text, "확인 중");
eq("세대 일치 → '암호화됨'", HL.hostLockLabel(true, 3, 3).text, "암호화됨");
eq("내 세대를 모르면(0/undefined) 대조를 건너뛴다(구 호출부 호환)",
  [HL.hostLockLabel(true, 3, 0).text, HL.hostLockLabel(true, 3).text], ["암호화됨", "암호화됨"]);
eq("호스트 열쇠 0개는 세대 대조보다 먼저 판정한다", HL.hostLockLabel(true, 0, 4).text, "평문(열쇠 없음)");
// 문구 집합도 앱과 동일해야 한다(사용자가 두 화면을 나란히 본다) — 새 문구가 슬며시 늘면 실패한다.
eq("라벨 문구 집합 = 4가지", [...new Set([
  HL.hostLockLabel(false, 3, 3).text, HL.hostLockLabel(true, undefined, 3).text,
  HL.hostLockLabel(true, 0, 3).text, HL.hostLockLabel(true, 3, 3).text,
  HL.hostLockLabel(true, 3, 4).text,
])].sort(), ["암호화됨", "평문(열쇠 없음)", "평문", "확인 중"].sort());

// ── 갭2 §2.11-9: 파생 기준(userRef)을 모르면 **대조값을 만들지 않는다** ──────
//  왜: 데몬은 userRef 를 모를 때 ''(빈 문자열)을 보낸다(e2ee-local.js:143). PC 가 그걸로 파생하면
//  화면에는 **틀린 안전코드**가 아무 경고 없이 뜨고, 폰 화면과 절대 같아지지 않는다 → 사람이 대조하는
//  유일한 MITM 방어 채널이 통째로 무효화된다(정당한 승인을 거절하도록 학습시킨다).
//  기대: 안전코드/지문/요청번호 자리는 비운다(UI 가 '—' 를 그린다) — 대조를 유도하지 않는다.
const noRefStub = (over) => async (cmd, args) => {
  if (cmd !== "e2ee_local") return {};
  if (args.cmd === "e2ee.state") {
    return {
      available: true, state: "pending", keyState: "pending", checking: true, nextCheckInMs: null,
      accountEpoch: null, phase: "pending", epoch: 0, policy: "preferred", scope: "rpc",
      ikX: selfIkX, userRef: "", enrollmentId: "e9", recoverySet: false, reason: null, ...(over || {}),
    };
  }
  if (args.cmd === "e2ee.pending") {
    return { pending: [{ enrollmentId: "e1", label: "iPad", platform: "ios", ikX: newIkX, verifyCode: "1234" }] };
  }
  if (args.cmd === "e2ee.keyring") return { epoch: 0, devices: [{ deviceKeyId: 5, label: "폰", ikX: newIkX, state: "trusted" }] };
  return {};
};
invokeImpl = noRefStub();
await E.refreshE2ee();
eq("userRef 미상 → 이 PC 안전코드/지문은 비운다(틀린 값 대신 '—')",
  [E.e2ee.safetyCode, E.e2ee.fingerprint, E.e2ee.verifyCode], [null, null, null]);
eq("userRef 미상 → 대기 카드 안전코드도 비우고 verified=false(대조 금지 신호)",
  [E.e2ee.pending[0].safetyCode, E.e2ee.pending[0].verified], [null, false]);
eq("userRef 미상 → 요청번호는 서버 값만(구분용), 로컬 파생 금지", E.e2ee.pending[0].verifyCode, "1234");
eq("userRef 미상 → 키링 지문도 비운다", E.e2ee.devices[0].fingerprint, null);
// 기준을 알면 즉시 정상 파생으로 돌아온다(가드가 기능을 죽이지 않는다).
invokeImpl = noRefStub({ userRef: "u77" });
await E.refreshE2ee();
eq("userRef 를 받으면 곧바로 로컬 파생 복귀", E.e2ee.safetyCode, wantSelfSafety);

// ── 갭2 §2.7 자가복구①: 계정 세대/정책 변경 push 는 즉시 refresh 한다 ─────
//  없으면 폰에서 회전/해제/처음켜기 해도 PC 는 최대 60초(폴링 주기)간 낡은 자물쇠를 그린다.
//  back 은 이 3종을 **이미** 팬아웃한다(deviceTrustService.js:504/696/722) = 새 배관 0개.
{
  let stateCalls = 0;
  invokeImpl = async (cmd, args) => {
    if (cmd !== "e2ee_local") return {};
    if (args.cmd === "e2ee.state") {
      stateCalls += 1;
      return { available: true, state: "trusted", keyState: "trusted", checking: false, epoch: 4, policy: "preferred", scope: "rpc", ikX: selfIkX, userRef: "u77" };
    }
    if (args.cmd === "e2ee.pending") return { pending: [] };
    if (args.cmd === "e2ee.keyring") return { epoch: 4, devices: [] };
    return {};
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  for (const kind of ["rotated", "policy", "bootstrapped"]) {
    const before = stateCalls;
    E.applyDeviceApprovalEvent({ kind, epoch: 5 });
    await settle();
    eq(`device_approval_event kind='${kind}' → 즉시 refresh`, stateCalls > before, true);
  }
  const before = stateCalls;
  E.applyDeviceApprovalEvent({ kind: "unknown_future_kind" });
  await settle();
  eq("모르는 kind 는 무시(왕복 폭주 금지)", stateCalls, before);
}

// ── 갭2 §2.7 자가복구②: 409 E2EE_EPOCH_MISMATCH = refresh 1회 + **네거티브 캐시 금지** ────
//  왜: back 은 이 코드를 "상태가 바뀌면 즉시 낫는다" 로 정의했는데(계약 §2.3) PC 는 봉투 RPC 의 모든
//  실패를 한 덩어리로 10분 캐시했다. 그러면 열쇠를 갱신해 놓고도 10분간 봉인을 시도하지 않아 전부
//  평문이면서 배지는 초록이다(거짓 자물쇠). 반대로 실패마다 갱신을 부르면 IDE 트리·800ms 자동저장이
//  초당 여러 번 봉인하므로 왕복 폭주가 된다 → 억제창 20초.
const FB = await import(`${base}/e2ee-fallback.js`);

eq("Rust 가 실은 코드를 추출한다('<CODE>: 메시지' — bridge.rs back_api 선례)",
  FB.rpcFailCode(new Error("E2EE_EPOCH_MISMATCH: 봉투 세대가 현재와 다릅니다")), "E2EE_EPOCH_MISMATCH");
eq("코드 없는 실패(IPC 단절)는 빈 문자열", FB.rpcFailCode(new Error("cpt.sock 연결 실패(데몬 미기동?)")), "");
eq("세대 불일치 = 갱신하면 낫는다(캐시 금지)", FB.classifyRpcFail({ code: "E2EE_EPOCH_MISMATCH", myEpoch: 4 }), "epoch");
eq("응답 복호 실패도 같은 처방(회전 직후)", FB.classifyRpcFail({ code: "E2EE_DECRYPT_FAILED", myEpoch: 4 }), "epoch");
// 구 데몬은 back 4xx/5xx 를 전부 E2EE_RELAY_FAILED 로 뭉갠다(runner-core/e2ee-local.js rpc catch) →
//  detail.code 가 사라진다. 그때는 우리가 이미 가진 세대 근거(accountEpoch · runner_status)로 판정한다.
eq("뭉개진 RELAY_FAILED + 계정 세대 어긋남 → epoch",
  FB.classifyRpcFail({ code: "E2EE_RELAY_FAILED", myEpoch: 4, accountEpoch: 5 }), "epoch");
eq("뭉개진 RELAY_FAILED + 호스트 세대 어긋남 → epoch",
  FB.classifyRpcFail({ code: "E2EE_RELAY_FAILED", myEpoch: 4, hostEpoch: 5 }), "epoch");
eq("근거가 없으면 추측하지 않는다(미지원 캐시로 왕복 절감)",
  FB.classifyRpcFail({ code: "E2EE_RELAY_FAILED", myEpoch: 4, accountEpoch: 4 }), "unsupported");
eq("구 데몬(명령 자체를 모른다) → 미지원",
  FB.classifyRpcFail({ code: "E2EE_UNKNOWN_CMD", myEpoch: 4, accountEpoch: 5 }), "unsupported");
eq("세대 대조는 양쪽을 알 때만(모름을 불일치로 단정하지 않는다)",
  [FB.epochMismatch(4, 5), FB.epochMismatch(4, 4), FB.epochMismatch(4, 0), FB.epochMismatch(0, 5)],
  [true, false, false, false]);
// 봉투 하나가 409 를 맞은 것으로 E2EE '전체' 를 미지원으로 내려앉히면 설정 배지가 '미지원' 이 되고
//  e2eeCaps() 가 빈 배열이 되어 다음 hello 에서 이 PC 가 스스로 능력을 취소한다(조용한 평문).
eq("E2EE 전체 미지원 판정은 데몬이 '모른다' 고 말한 코드에서만",
  [FB.isDaemonUnsupported("E2EE_EPOCH_MISMATCH"), FB.isDaemonUnsupported("E2EE_RELAY_FAILED"),
    FB.isDaemonUnsupported("E2EE_UNKNOWN_CMD"), FB.isDaemonUnsupported("")],
  [false, false, true, true]);
eq("폴백 표: 호스트가 이미 실행한 실패는 폴백 금지(이중 실행) · required 는 전부 금지",
  [FB.mayFallback("preferred", false), FB.mayFallback("preferred", true),
    FB.mayFallback("required", false), FB.mayFallback("required", true)],
  [true, false, false, false]);

// 배선 검증 — 실제 e2ee.js sealedRpc 를 데몬 스텁으로 구동한다(순수 함수만 맞아도 배선이 없으면 죽는다).
{
  let stateCalls = 0;
  let rpcCalls = 0;     // 실제로 발사된 봉투 왕복 수(= 폭주 상한을 재는 자)
  let rpcFail = null;   // 데몬이 throw 할 오류(= 봉투 계층 실패)
  let rpcResult = { ok: true, r: { content: "x" } };
  const rpcStub = (over) => async (cmd, args) => {
    if (cmd !== "e2ee_local") return {};
    if (args.cmd === "e2ee.state") {
      stateCalls += 1;
      return {
        available: true, state: "trusted", keyState: "trusted", checking: false, epoch: 4,
        accountEpoch: 5, policy: "preferred", scope: "rpc", ikX: selfIkX, userRef: "u77", ...(over || {}),
      };
    }
    if (args.cmd === "e2ee.pending") return { pending: [] };
    if (args.cmd === "e2ee.keyring") return { epoch: 5, devices: [] };
    if (args.cmd === "e2ee.rpc") { rpcCalls += 1; if (rpcFail) throw rpcFail; return rpcResult; }
    return {};
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  // ── ③-2 의 **입력 신선도**(2026-07-27 실측 결함) ───────────────────────────────────────────
  //  accountEpoch 를 데몬 폴링만으로 채우면 **같은 왕복이 로컬 epoch 도 올리므로**(e2ee-account.js
  //  callKeyring → acceptGrant) 두 값이 항상 같이 낡는다 → `mine !== acct` 가 회전 직후 15분 창에서
  //  한 번도 참이 되지 않는다(그 창을 위해 만든 근거인데 거기서만 죽는다). 실측: 계정이 4로 회전한
  //  직후 PC 가 읽는 accountEpoch=3 · epoch=3. 앱은 같은 순간 push 의 epoch 를 즉시 반영해 '확인 중'
  //  이므로 두 화면이 최대 15분간 다른 색이었다 → PC 도 push 를 단조 반영한다(앱 e2ee.ts:1046 미러).
  //  (userRef 를 바꿔 **계정 전환**을 겸해 검증한다 — 단조 래치는 계정이 바뀌면 폐기돼야 한다.
  //   안 그러면 다음 계정의 세대가 더 낮을 때 배지가 '확인 중' 에 영구 고착된다.)
  invokeImpl = rpcStub({ epoch: 3, accountEpoch: 3, userRef: "u78" }); // 데몬이 아직 회전을 못 봤다
  await E.refreshE2ee();
  eq("계정이 바뀌면 단조 래치를 폐기한다(다음 계정에서 '확인 중' 영구 고착 금지) + 폴링만으로는 "
    + "뒤처짐이 안 보인다(accountEpoch === epoch)", [E.e2ee.epoch, E.e2ee.accountEpoch], [3, 3]);
  eq("전제: 그래서 그 창에서는 자기 행이 초록이었다",
    HL.hostLockLabel(true, E.e2ee.epoch, E.e2ee.epoch, E.e2ee.accountEpoch).text, "암호화됨");
  E.applyDeviceApprovalEvent({ kind: "rotated", epoch: 4 });
  eq("rotated push 의 epoch 를 refresh 완료 **전에** 반영한다", E.e2ee.accountEpoch, 4);
  eq("→ 자기 행이 즉시 '확인 중'(앱과 같은 순간·같은 문구)",
    HL.hostLockLabel(true, E.e2ee.epoch, E.e2ee.epoch, E.e2ee.accountEpoch).text, "확인 중");
  await settle(); // push 가 물고 온 refresh 가 낡은 폴링 값(3)으로 되돌리는지 확인
  eq("낡은 폴링 응답이 래치를 되돌리지 않는다(단조 — 배지 깜빡임 금지)", E.e2ee.accountEpoch, 4);

  invokeImpl = rpcStub();
  await E.refreshE2ee();
  eq("전제: 열쇠 보유(봉인 가능) + 계정 세대가 앞선 상태(한계 ③-2)",
    [E.e2ee.epoch, E.e2ee.accountEpoch, E.rpcAvailable()], [4, 5, true]);
  // ★ 한계 ③-2 — 자기 행: settings.js 는 hostEpoch 를 자기 epoch 로 채운다. 계정 세대가 앞서 있으면
  //  이 PC 의 봉투는 409 로 거절되는데 3인자까지는 '암호화됨' 이었다.
  eq("자기 행: 계정 세대에 뒤처지면 '확인 중'(초록 금지)",
    HL.hostLockLabel(true, E.e2ee.epoch, E.e2ee.epoch, E.e2ee.accountEpoch).text, "확인 중");
  eq("자기 행: 계정 세대와 같으면 '암호화됨'", HL.hostLockLabel(true, 5, 5, 5).text, "암호화됨");

  let before = stateCalls;
  rpcFail = Object.assign(new Error("E2EE_EPOCH_MISMATCH: 봉투 세대가 현재와 다릅니다"), {});
  const out1 = await E.sealedRpc("fs.read", { path: "a.ts" }, 12);
  await settle();
  eq("409 세대 불일치 → 평문 폴백 신호(null)", out1, null);
  eq("409 세대 불일치 → 즉시 refresh(자가복구 ②)", stateCalls > before, true);
  eq("409 는 10분 네거티브 캐시에 넣지 않는다(갱신 후 곧바로 재시도)", E.rpcAvailable(), true);
  eq("409 하나로 E2EE 전체를 '미지원' 으로 내려앉히지 않는다",
    [E.e2ee.available, E.e2ee.state], [true, "trusted"]);

  before = stateCalls;
  let rpcBefore = rpcCalls;
  for (let i = 0; i < 4; i++) await E.sealedRpc("fs.read", { path: "a.ts" }, 12);
  await settle();
  eq("억제창(20s) 안에서는 refresh 를 재발사하지 않는다(왕복 폭주 금지)", stateCalls, before);
  // ★ '10분 캐시 금지' 를 **상한 없음**으로 구현하면 종료 조건이 사라진다(2026-07-27 실측 결함):
  //  회전 push 미지원 데몬에서 호스트는 최대 15분 옛 세대로 남고, 그동안 IDE 트리 + 800ms 자동저장 +
  //  2.5s 리컨실러가 부르는 만큼 봉투가 초당 수 회 발사된다(왕복 1회 = cpt.sock → 데몬 → HTTPS
  //  POST /api/daemon/rpc(레이트리밋 없음) → 호스트 WS → 409). refresh 억제창은 **로컬 refresh 만**
  //  막으므로 브레이크가 아니다 → 그 호스트로의 **봉투 재시도 자체**를 refresh 억제창과 같은 20초 동안
  //  멈춘다(이전 동작은 첫 실패 후 10분 침묵이었으니 여전히 훨씬 공격적인 재시도다).
  eq("409 뒤 같은 호스트로는 20s 동안 봉투를 재발사하지 않는다(종료 조건 있는 재시도)", rpcCalls, rpcBefore);
  eq("억제 중에도 preferred 는 평문 폴백 신호(조작을 막지 않는다)",
    await E.sealedRpc("fs.read", { path: "a.ts" }, 12), null);
  eq("억제는 그 호스트 한정 게이트다(rpcAvailable 진단)",
    [E.rpcAvailable(), E.rpcAvailable(12), E.rpcAvailable(13)], [true, false, true]);
  rpcFail = null;
  rpcBefore = rpcCalls;
  const okOther = await E.sealedRpc("fs.read", { path: "b.ts" }, 13);
  eq("다른 PC 는 억제되지 않는다(원인이 그 호스트의 뒤처짐일 수 있다)",
    [rpcCalls > rpcBefore, okOther && okOther.content], [true, "x"]);

  // 구조적 미지원(데몬이 봉투 응답을 못 받았다 등)은 예전처럼 10분 캐시 — 왕복 절감 경로를 지운 게 아니다.
  //  ★ 호스트 13 으로 보낸다: 12 는 위 절이 20초 세대 게이트를 걸어 둔 상태라 봉투가 발사되지 않는다
  //   (게이트가 호스트별이라는 사실이 이 절이 실제로 왕복하는 근거다).
  rpcFail = new Error("E2EE_NO_ENVELOPE: 서버가 봉투 응답을 주지 않았습니다");
  eq("미지원 계열 → 평문 폴백", await E.sealedRpc("fs.read", { path: "a.ts" }, 13), null);
  eq("미지원 계열 → 네거티브 캐시 ON", E.rpcAvailable(), false);
  eq("그래도 배지를 '미지원' 으로 바꾸지는 않는다", E.e2ee.available, true);

  // 새 세대 열쇠를 채택하면(데몬 epoch 상승) 캐시를 즉시 만료 — 갱신했는데 10분 평문이면 안 된다.
  invokeImpl = rpcStub({ epoch: 5 });
  await E.refreshE2ee();
  eq("세대 승계 → 네거티브 캐시 즉시 만료", E.rpcAvailable(), true);
  // 세대가 실제로 올라갔으면 20초를 기다리지 않는다 — 자가복구가 게이트에 발이 묶이면 안 된다.
  eq("세대 승계 → 호스트별 세대 게이트도 즉시 만료", E.rpcAvailable(12), true);
  eq("세대 승계 후 자기 행은 '암호화됨'",
    HL.hostLockLabel(true, E.e2ee.epoch, E.e2ee.epoch, E.e2ee.accountEpoch).text, "암호화됨");

  // 200 + ok:false = 호스트가 **이미 실행**했다 → 폴백하면 이중 실행. 반드시 throw.
  rpcFail = null;
  rpcResult = { ok: false, e: "권한이 없습니다", code: "EACCES" };
  let threw = "";
  try { await E.sealedRpc("fs.write", { path: "a.ts", content: "x" }, 12); } catch (e) { threw = e.message; }
  eq("호스트가 이미 실행한 실패는 throw(평문 이중 실행 금지)", threw, "권한이 없습니다");

  // policy='required' — 봉투가 못 갔다고 평문으로 내려가지 않는다(다운그레이드 차단).
  //  ★ gate 만 보면 ready()=true 라 null 을 돌려주고 조용히 평문으로 갔다(정책이 새는 구멍).
  invokeImpl = rpcStub({ policy: "required", epoch: 5 });
  await E.refreshE2ee();
  rpcFail = new Error("E2EE_NO_ENVELOPE: 서버가 봉투 응답을 주지 않았습니다");
  threw = "";
  try { await E.sealedRpc("fs.read", { path: "a.ts" }, 12); } catch (e) { threw = e.message; }
  eq("required + 봉투 실패 → null 폴백이 아니라 throw", threw.length > 0, true);
  threw = "";
  try { await E.sealedRpc("fs.read", { path: "a.ts" }, 12); } catch (e) { threw = e.message; }
  eq("required + 캐시 걸린 뒤에도 계속 throw(한 번씩 새지 않는다)", threw.length > 0, true);

  // 구 데몬(e2ee.* 자체를 모른다) = 기존 '미지원' 폴백 경로 — 지우지 않았음을 고정한다.
  //  (epoch 를 올려 직전 required 절이 걸어 둔 네거티브 캐시를 만료시킨다 = 실제 왕복이 일어나게)
  invokeImpl = rpcStub({ policy: "preferred", epoch: 6, accountEpoch: 6 });
  await E.refreshE2ee();
  eq("전제: 캐시가 만료돼 실제로 왕복한다", E.rpcAvailable(), true);
  rpcFail = new Error("E2EE_UNKNOWN_CMD: 알 수 없는 e2ee 명령: e2ee.rpc");
  eq("구 데몬 → 평문 폴백", await E.sealedRpc("fs.read", { path: "a.ts" }, 12), null);
  eq("구 데몬 → E2EE 전체 '미지원'(기존 동작 유지)", [E.e2ee.available, E.e2ee.state], [false, "unsupported"]);
}

// ── 카피 계약(docs/구현설계-2026-07-25/14-설정-카피-감사.md) — 지운 문구가 되살아나지 않는다 ──────
//  왜 **소스 문자열** 단정인가: 이 라운드는 "사용자는 어차피 안 읽는다" 는 실사용 피드백에 따라 설정
//  카드/승인 시트의 상시 설명문을 566자 → 109자로 줄였다(삭제 16개). 화면 조립은 DOM·Tauri 없이는
//  실행할 수 없으므로 회귀를 잡을 수 있는 지점이 소스뿐이다. 한 번 지운 문단이 다음 라운드에 슬며시
//  되살아나면 이 작업 전체가 무효가 되고, 앱(같은 표를 쓰는 E2eeSettingsCard)과도 어긋난다.
//  ⚠ 조작 차단 오버레이 문구(e2ee.js e2eeGate)는 이 감사 범위 밖이다(§4-8) → 검사 대상 파일이 아니다.
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = base.startsWith("file:") ? fileURLToPath(base) : base;
  const settings = readFileSync(`${dir}/settings.js`, "utf8");
  const labelSrc = readFileSync(`${dir}/e2ee-label.js`, "utf8") + readFileSync(`${dir}/host-lock.js`, "utf8");

  // ① 삭제된 상시 설명문 — 카드 첫 화면에서 설명문을 0줄로 만든 근거들.
  eq("삭제한 상시 설명문이 settings.js 에 없다(§3-A 삭제 목록)",
    [
      "이 PC 에는 열쇠가 있어요",            // desc(ready) 63자 — 바로 아래 PC 별 배지가 더 정확히 말한다
      "지원되는 기기끼리는",                  // desc(not ready) — 자동 동작 설명(행동 0 변화)
      "이 PC 의 열쇠 상태",                  // 배지를 섹션 제목 행으로 올려 라벨이 불필요해졌다
      "다음 확인",                            // '· 다음 확인 30초 후' 진행 트리비아
      "에서 접속 시도",                       // 카드 제목이 이미 '새 기기 승인'
      "서버는 열쇠를 볼 수 없습니다",         // 승인 카드 하단 안심 문구 50자
      "이미 쓰던 기기",                       // 자기 대기 화면 65자(대조 행위가 없는 화면)
      "그대로 사용할 수 있어요",              // 자기 대기 하단 73자
      "QR 스캔 시 지문은 자동 검증됩니다",    // 자동으로 되는 일 설명
      "기기 목록 표기용 지문",                // → '지문'
      "이 PC 안전 코드",                     // → '이 기기 안전 코드'(앱과 동일 문구)
      "폰 설정 → 종단간 암호화",             // 안전 코드 대조 안내 53자 → 14자
      "코드 자체가 열쇠입니다",               // 복원 행 부제 27자(행 제목이 곧 설명)
      "그래서 지금은 기존 방식",              // 부트스트랩 165자 문단
      "이 계정에는 아직 암호화 열쇠가 없어요", // → '암호화 열쇠가 없어요'
      "이 계정에 암호화 처음 켜기",           // → '암호화 켜기'
      "이 PC 를 신뢰 목록에 추가해 주세요",   // → '기존 기기에서 승인해 주세요'
      "신뢰를 해제하면 열쇠를 새로 만들어",   // 상시 73자 → arm 인라인 경고로 이동
      "암호화해도 폴더명",                    // 메타데이터 고지 72자 → 16자
      "구분용 — 이 숫자로 대조하지 마세요",   // → '· 대조용 아님'
      "대조 기준을 받지 못해",                // 97자 → '안전 코드를 아직 못 만들었어요 · 승인하지 마세요'
      "이 화면을 닫으면 다시 볼 수 없어요",   // → '지금 적어두세요 · 다시 못 봅니다'
      "설정됨 — 새로 만들면",                 // → '새로 만들면 이전 코드 무효'
      "모든 기기를 잃으면",                   // → '기기를 다 잃으면 복구 불가'
      "자동 = 양쪽이 지원하면",               // → '자동 권장 · 항상 = 안 되면 조작 차단'
      "<span>지문</span>",                    // 자세히 ③ 행 삭제(⑤ 자기 행의 🔒 지문과 완전 중복)
      "한 글자라도 다르면",                   // 승인 지침 2문장 → 1문장('다르면 거절' 은 유지)
    ].filter((t) => settings.includes(t)), []);

  // ② 보안상 반드시 남는 문구 — 축약했어도 **행동 지시·정직성 신호**는 그대로다(§5).
  //  이 목록이 하나라도 사라지면 사람 눈 대조(= 서버 MITM 차단의 전부)가 흐려진다.
  eq("보안 문구는 글자까지 그대로 남아 있다(§5)",
    [
      "아래 코드가 새 기기 화면과 글자까지 같으면 승인, 다르면 거절하세요.", // §2.10 눈 대조 지침
      "· 대조용 아님",                                    // 4자리(13비트)는 대조 대상이 아니다
      "안전 코드를 아직 못 만들었어요 · 승인하지 마세요", // 대조 기준 없는 습관적 승인 차단(승인 카드)
      // 같은 상황의 **대기 화면**(이 PC 가 새 기기) 전용 문구 — 그 화면에는 승인 버튼이 없으므로
      //  누르지 말아야 할 곳을 명시한다. 승인자용 문구 재사용 = 지시 대상 어긋남(앱 COPY.wait.noSafety).
      "안전 코드를 아직 못 만들었어요 · 기존 기기에서 승인하지 마세요",
      "요청 번호는 서버 값 · 코드로만 대조하세요",        // verified=false = 표시값이 서버 지배
      "자동 권장 · 항상 = 안 되면 조작 차단",             // '항상' 이 **무엇을** 막는지(목적어) 유지
      "연결된 PC 없음",                                   // host 행 0개여도 정직성 기제를 비우지 않는다
      "기기가 없으면 자세히 → 복구 코드로 복원",          // 기기 전량 상실 시의 유일한 출구 안내
      "지금 적어두세요 · 다시 못 봅니다",                 // 복구 코드 1회 표시·영구 소실
      "다시 눌러 해제 · 되돌릴 수 없음",                  // 신뢰 해제 비가역(결정 순간)
      "폴더명·알림 제목은 서버가 봅니다",                 // 메타데이터 정직성 고지
      "다른 기기 화면과 같은지 확인",                     // 안전 코드 대조 유도(자세히 안)
    ].filter((t) => !settings.includes(t)), []);

  // ③ 안전 코드 계산 불가 = 문구만이 아니라 **승인 버튼 비활성**까지가 계약이다(앱과 통일).
  eq("안전 코드가 없으면 승인 버튼을 비활성한다", /noSafety \? " disabled" : ""/.test(settings), true);

  // ③-b 자기 대기 화면도 **같은 3항**이어야 한다(2026-07-27 교차검증 지적 #5).
  //  구 코드는 `${e2ee.safetyCode ? chips+reqno : ""}` 라 대조 기준을 못 만든 상태에서 칩·요청번호·경고를
  //  **전부 무음으로 생략**했다: 승인하는 폰은 그 PC 의 ikX 로 안전 코드를 정상 파생해 크게 그리므로
  //  (폰은 userRef 를 서버에서 받는다) 사용자는 폰의 3블록을 PC 화면에서 찾다 못 찾고 대조 없이 승인한다
  //  = 사람 눈 대조(서버 MITM 차단의 전부)가 그 승인에서 통째로 빠진다. §5 문자열 단정으로는 이 누락이
  //  잡히지 않는다(같은 문구가 승인 카드 쪽에 1회 있으면 통과한다) → **소스 형태**를 고정한다.
  eq("자기 대기 화면: 안전 코드가 없으면 경고를 그린다(무음 생략 금지)",
    /e2ee\.safetyCode \? safetyChips[\s\S]{0,120}: waitNoSafetyWarn\(\)/.test(settings), true);
  eq("자기 대기 화면·승인 카드 모두 요청번호를 **무조건** 그린다(요청 구분자 유실 금지 = 앱과 동일 구성)",
    (settings.match(/\$\{requestNo\((?:p|e2ee)\.verifyCode\)\}/g) || []).length, 2);
  // ⚠ 요청번호와 달리 `verified=false` 경고는 **안전 코드가 있을 때만** 그린다(§3-B "경고는 한 번에
  //  하나만" — 안전 코드를 못 만든 상태는 항상 verified=false 를 동반하므로 겹치면 노이즈다). 앱
  //  DeviceTrustCard 도 `hasSafety && !device.verified` 다 = 두 화면의 경고 줄 수가 같아야 한다.
  eq("verified=false 경고는 안전 코드가 있을 때만(경고 한 번에 하나 · 앱과 동일)",
    /\$\{!noSafety && p\.verified === false \?/.test(settings), true);

  // ③-c 복구 코드 컨트롤은 `state` 값이 아니라 ready/canRestore 로 분기한다(계약 §2.4 규약 3 · 지적 #4).
  //  앱과의 동치는 test/e2ee-crossimpl.mjs 5절이 격자로 대조하고, 여기서는 **화면이 그 판정을 실제로
  //  호출하는지**를 고정한다(순수 함수만 맞고 화면이 옛 분기를 쓰면 아무 것도 달라지지 않는다).
  eq("복구 코드 만들기 활성 = e2eeReady()(구 state==='trusted' 분기 제거)",
    /id="e2eeRecBtn"\$\{e2eeReady\(\) \? "" : " disabled"\}/.test(settings)
    && !/e2ee\.state === "trusted" \? "" : " disabled"/.test(settings), true);
  eq("복원 행 노출 = e2eeCanRestore()(구 state 이중 부정 제거)",
    /\$\{e2eeCanRestore\(\) \?/.test(settings)
    && !/e2ee\.state !== "trusted" && e2ee\.state !== "off"/.test(settings), true);

  // ③-d host 행 집합 = isHostRow(앱 필터와 동치 · 지적 #1/#6). 꺼둔 PC 를 나열하면 그 행은 오프라인이라
  //  epoch 항목이 삭제돼 **영구 '확인 중'** 이 되고, 폰 화면에는 그 행이 아예 없어 두 화면이 갈라진다.
  eq("host 행 필터는 isHostRow 한 곳이다(인라인 role/runnerKind 조건 재등장 금지)",
    /\.filter\(isHostRow\)/.test(settings)
    && !/runnerKind !== "cloud" && d\.role !== "controller"/.test(settings), true);

  // ③-2 행동 행이 있으면 `reason`(데몬·서버 원문 40~70자)을 그리지 않는다 — 두 줄이 같은 사실을 다시
  //  말하거나 서로 상충하면(부트스트랩) 축약 효과가 상쇄된다. 앱은 같은 조건을 `!action` 으로 쓴다.
  eq("행동 행이 있으면 reason 을 숨긴다(설명문 0줄 유지)",
    settings.includes("e2ee.reason && !actionRowHtml"), true);

  // ④ 배지 문구는 **판정 함수의 반환 리터럴**로 고정한다(주석에 옛 문구가 남는 건 히스토리라 무해하다).
  //  앱 e2eeState.ts 와 같은 커밋에서만 바뀌어야 한다 — 동치 대조는 test/e2ee-crossimpl.mjs §4.
  eq("self 배지: '켜짐'/'이 기기 준비됨'/'준비 중' 을 반환하지 않는다",
    [`L("켜짐"`, `L("이 기기 준비됨"`, `L("준비 중"`].filter((t) => labelSrc.includes(t)), []);
  eq("self 배지 '열쇠 있음' + host 배지 '평문(열쇠 없음)' 을 반환한다",
    [`L("열쇠 있음", "on")`, `text: "평문(열쇠 없음)", tone: "off"`].filter((t) => !labelSrc.includes(t)), []);

  // ⑤ **화면 구성**(문구가 아니라 무엇이 그려지는가) — 2026-07-27 교차검증이 적출한 4건의 앵커.
  //  화면 조립은 DOM 없이 실행할 수 없으니 여기서도 소스로 고정한다(앱==PC 동치 대조는
  //  test/e2ee-crossimpl.mjs 4-B/5 절이 **함수를 실행해서** 본다 — 이 절은 그 함수를 실제로 쓰는지 본다).
  //  ⑤-1 자기 대기 화면(이 PC 가 새 기기)도 안전 코드가 없으면 **경고를 그린다**. 예전엔 칩·요청번호·
  //   경고를 전부 무음 생략해서, 승인하는 폰에는 3블록 코드가 크게 떠 있는데 이 화면에는 아무것도 없었다
  //   = 사용자가 대조 없이 승인하게 되는 구멍(§2.10 방어가 PC 에서만 비어 있었다).
  eq("자기 대기 화면도 안전 코드 부재 시 경고를 그린다(무음 생략 금지)",
    /e2ee\.safetyCode \? safetyChips[\s\S]{0,140}NoSafetyWarn\(\)/.test(settings), true);
  //  ⑤-2 요청번호·verified 경고는 안전 코드 유무와 **무관**하게 그린다(앱 DeviceTrustCard 와 같은 구성).
  //   안전 코드가 없다고 요청번호까지 감추면 동시 요청 여러 건에서 구분 표식이 하나도 없다.
  eq("요청번호는 안전 코드와 분리해 항상 그린다(승인 카드·대기 화면 둘 다)",
    [`${"${"}requestNo(p.verifyCode)}`, `${"${"}requestNo(e2ee.verifyCode)}`].filter((t) => !settings.includes(t)), []);
  eq("요청번호를 안전 코드 칩에 이어 붙이는 옛 형태가 남아 있지 않다",
    /safetyChips\([^)]*\) \+ requestNo\(/.test(settings), false);
  //   반대로 두 경고(noSafety · unverified)는 **한 번에 하나만** 그린다: 안전 코드를 못 만든 상태는 항상
  //   verified=false 를 동반하므로 겹치면 노이즈가 되고, 읽어야 하는 지시는 더 강한 쪽 하나다(앱 동일).
  eq("경고는 한 번에 하나만(noSafety 일 때 unverified 는 숨긴다)",
    settings.includes("!noSafety && p.verified === false"), true);
  //  ⑤-3 복구 코드 컨트롤은 `state` 값이 아니라 ready/노출 판정 함수로 분기한다(계약 §2.4 규약 3).
  eq("복구 코드 만들기 활성 = e2eeReady() · 복원 행 노출 = e2eeCanRestore()",
    [settings.includes(`id="e2eeRecBtn"${"${"}e2eeReady() ? "" : " disabled"}`), settings.includes("e2eeCanRestore()")],
    [true, true]);
  eq("복구 컨트롤에서 state 분기가 사라졌다",
    [`e2ee.state === "trusted" ? "" : " disabled"`, `e2ee.state !== "trusted" && e2ee.state !== "off"`]
      .filter((t) => settings.includes(t)), []);
  //  ⑤-4 host 행 집합은 host-lock.js 의 규칙 함수를 쓴다(꺼둔 PC 가 영구 '확인 중' 으로 남던 결함).
  eq("host 행은 isHostRow 로 고른다(오프라인 PC 나열 금지)",
    [settings.includes(".filter(isHostRow)"),
      settings.includes(`d.runnerKind !== "cloud" && d.role !== "controller"`)],
    [true, false]);

  // ⑥ **기기 목록 통합**(2026-07-27 개정 2 · 사용자 요구) — '종단간 암호화' 카드 안의 '열쇠를 가진 기기'
  //  목록 + 그 아래 '내 기기' 표 = 같은 기기가 한 화면에 두 번 나왔다. 한 섹션(`기기`)·한 목록으로 합쳤고
  //  기기 행이 단일 진실이다. 되돌아가면(목록 2개) 사용자는 어느 쪽이 정본인지 알 수 없다.
  //  ★ 주석에는 구 제목이 남는다(왜 지웠는지 근거) → 이 절만 **주석을 제거한 소스**로 본다.
  const code = settings.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
  eq("목록은 하나다('열쇠를 가진 기기' 제목 · '내 기기' 표 · deviceTable 컨테이너가 없다)",
    ["열쇠를 가진 기기", ">내 기기<", "deviceTable", "dev-th"].filter((t) => code.includes(t)), []);
  eq("섹션 제목은 `기기` 이고 self 배지는 그 행 우측이다", code.includes(`<div class="dev-title" style="margin:0;flex:1;min-width:0">기기</div>`), true);
  eq("기능명은 자세히 안 정책 행이 갖는다(화면에서 '종단간 암호화' 가 사라지지 않는다)",
    code.includes("<span>종단간 암호화<br>"), true);
  // 암호화 배지는 **근거가 있는 행에만** 그린다(온라인 PC = isHostRow). 오프라인·모바일 행에 배지를
  //  그리면 꺼둔 기기가 영구 '확인 중'(거짓 진행 신호)이 되고 폰 화면과 색·행 수가 갈라진다.
  eq("행 배지는 isHostRow 행에만 그린다(모름을 초록/평문으로 단정하지 않는다)",
    /isHostRow\(d\)\s*\n?\s*\? hostLockLabel\(/.test(code), true);
  // 기기 삭제 = 열쇠 해제 + 세대 회전까지. back revokeDevice 는 열쇠를 'revoked' 로 표시하고
  //  rotate_needed 만 팬아웃하므로, 회전 없이 지우면 지운 기기가 이미 가진 MK_epoch 로 이후 트래픽까지
  //  계속 열 수 있다(구 '신뢰 해제' 가 하던 회전을 기기 행이 이어받았다).
  eq("열쇠를 가진 기기를 지우면 회전까지 한다(data-dev-key → revokeTrust → revokeDevice)",
    [code.includes("data-dev-key="), /revokeTrust\(keyId\)/.test(code), code.includes("api.revokeDevice(")], [true, true, true]);
  // 기기 행이 없는 열쇠(고아)는 목록에 남는다 — 아니면 **해제할 방법이 사라진 열쇠**가 계정에 남는다.
  eq("기기 행이 없는 열쇠는 목록에 남아 해제할 수 있다", /orphans\s*=\s*devs\.filter/.test(code), true);

  // ⑦ **표(table) 구조**(2026-07-27 개정 3 · 사용자 요구: "기기 목록에서 카드 안에 카드 구조인데 그렇게
  //  안햇으면 좋겠어! 차라리 테이블 구조는 어떨까") — 행마다 카드(`.dev-row`: 배경+테두리+라운드)를
  //  그리면 섹션 카드(`.sm-card2`) 안에 카드가 겹쳐 보인다. 목록은 `<table class="dev-tbl">` 한 겹 +
  //  1px 구분선이고 행동 행도 그 표의 행이다(모바일 E2eeSettingsCard 의 ROW 상수와 같은 시각 규칙).
  eq("기기 목록은 표다(행 카드 .dev-row 폐기)",
    [code.includes(`<table class="dev-tbl">`), /class="dev-tr"/.test(code), code.includes(`class="dev-row"`)],
    [true, true, false]);
  // 헤더 행은 두지 않는다 — 지난 라운드에 표 헤더 3개를 텍스트 감축으로 지웠다(되살리면 감축을 되돌린다).
  eq("표에 헤더 행이 없다(카피 감축 유지)", /<th[\s>]|dev-th/.test(code), false);
  // 박스는 **한 곳만** 남긴다: 펼친 승인 카드(대조 + [거절]/[승인] 이 한 덩어리여야 하고 경고색 테두리
  //  자체가 보안 어포던스다). 여기가 2 이상이 되면 "카드 안에 카드" 로 되돌아간다.
  eq("예외 박스는 승인 카드 하나뿐이다(.appr-card 1곳)", (code.match(/class="appr-card"/g) || []).length, 1);
  // 행동 행·대기 행·로딩 행도 `<tr>` 이어야 한다: `<div>` 를 돌려주면 브라우저가 표 밖으로 끌어올려서
  //  (foster parenting) 열 정렬이 **조용히** 깨진다 — 화면을 실행하지 않으면 안 보이는 종류의 결함이다.
  eq("행동 행·대기 행·로딩 행도 표의 행(<tr>)이다", (code.match(/return `<tr/g) || []).length >= 3, true);
  // 무장(1탭) 경고는 **별도 행**(colspan)이다 — 같은 셀에 넣으면 그 행만 높이가 늘어 열 정렬이 흔들린다.
  eq("무장 경고는 colspan 행이다", /class="dev-tr-note" data-dev-armnote/.test(code), true);

  const css = readFileSync(`${dir}/../styles.css`, "utf8");
  eq("행에 배경·테두리·라운드를 주지 않는다(.dev-row 규칙 삭제)", /^\.dev-row\s*\{/m.test(css), false);
  // 구 '내 기기' 표(개정 2 에서 마크업이 사라진)의 죽은 규칙이 남아 있으면 안 된다 — `.dev-tr{display:grid}`
  //  가 새 `<tr>` 에 걸려 셀이 제 열을 벗어났다(실측: tr display=grid, 휴지통이 왼쪽 아래로 내려감).
  eq("죽은 grid 규칙이 없다(.dev-tr{display:grid} 가 <tr> 정렬을 깨뜨렸다)",
    /^\.dev-tr \{[^}]*display: grid/m.test(css), false);
  eq("행 구분은 1px 선 하나다(.dev-tbl td border-top)",
    /\.dev-tbl td \{[^}]*border-top: 1px solid var\(--border\)/.test(css), true);
  // 긴 기기명이 표를 밀어내지 않게 이름 열에 상한이 있다(상한 없으면 오른쪽 열들이 카드 밖으로 나갔다).
  eq("이름 열에 폭 상한이 있다(긴 기기명이 열을 밀어내지 않는다)", /\.dev-c-name \{[^}]*max-width:/.test(css), true);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
