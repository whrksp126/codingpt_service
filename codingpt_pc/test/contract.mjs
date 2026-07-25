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
eq("계정 열쇠 0개(확인 끝) = '준비 중' 이 아니라 '열쇠 없음'", E.e2eeStateLabel(), { text: "열쇠 없음", tone: "off" });
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

// 하위호환: keyState 를 아예 안 보내는 구 데몬은 예전 그대로 '준비 중'(모르는 것을 단정하지 않는다).
invokeImpl = async (cmd, args) => {
  if (cmd !== "e2ee_local") return {};
  if (args.cmd === "e2ee.state") return { available: true, state: "bootstrap", epoch: 0, policy: "preferred", scope: "rpc", ikX: selfIkX, userRef: "u77" };
  if (args.cmd === "e2ee.pending") return { pending: [] };
  if (args.cmd === "e2ee.keyring") return { epoch: 0, devices: [] };
  return {};
};
await E.refreshE2ee();
eq("구 데몬(keyState 없음) → '준비 중' 유지", [E.e2eeStateLabel(), E.e2ee.keyState], [{ text: "준비 중", tone: "wait" }, null]);
eq("구 데몬에는 '처음 켜기' 버튼 없음", E.e2eeNeedsBootstrap(), false);

invokeImpl = stateStub({ state: "trusted", keyState: "trusted", checking: false, phase: "trusted", epoch: 3 });
await E.refreshE2ee();
eq("열쇠 보유 = '이 기기 준비됨'", E.e2eeStateLabel(), { text: "이 기기 준비됨", tone: "on" });
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
eq("열쇠 없는 PC = '이 PC 는 평문(열쇠 없음)'", HL.hostLockLabel(true, HL.hostE2eeEpoch(13)).text, "이 PC 는 평문(열쇠 없음)");
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
eq("호스트 열쇠 0개는 세대 대조보다 먼저 판정한다", HL.hostLockLabel(true, 0, 4).text, "이 PC 는 평문(열쇠 없음)");
// 문구 집합도 앱과 동일해야 한다(사용자가 두 화면을 나란히 본다) — 새 문구가 슬며시 늘면 실패한다.
eq("라벨 문구 집합 = 4가지", [...new Set([
  HL.hostLockLabel(false, 3, 3).text, HL.hostLockLabel(true, undefined, 3).text,
  HL.hostLockLabel(true, 0, 3).text, HL.hostLockLabel(true, 3, 3).text,
  HL.hostLockLabel(true, 3, 4).text,
])].sort(), ["암호화됨", "이 PC 는 평문(열쇠 없음)", "평문", "확인 중"].sort());

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

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
