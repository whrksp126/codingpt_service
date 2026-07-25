// lan-crossimpl.mjs — LAN 직결(기능4) **교차 구현** 회귀 테스트.
//
// 왜 이 파일이 따로 있는가
//  · contract.mjs 는 데몬 응답을 **하드코딩 스텁**으로 먹인다. 그래서 "PC 는 probe 를 1회만 쏘는데
//    데몬은 2연속 성공에서만 승격한다" 같은 **경계의 어긋남**을 구조적으로 볼 수 없다(양쪽 단위
//    테스트가 각자 자기 가정으로 초록이 되는 사고 — 지난 라운드 교차검증 결함 #1/#2 가 정확히 이것).
//  · 그래서 이 테스트는 PC `src/js/lan.js` 실물과 데몬 `runner-core/lan.js`(경로 히스테리시스)·
//    `lan-local.js`(cpt.sock 커맨드 3개) **실물**을 한 프로세스에 맞물려 돌린다. 스텁은 최말단
//    2개뿐이다: back REST(grant 발급)와 실제 소켓 다이얼(lanLib.probe/connect).
//  · 시계는 주입한다(Date.now 대체 + lanLib.__setNow) — "30분간 폴링" 을 실시간으로 기다릴 수 없다.
//  · 데몬은 **기동하지 않는다**(리포 규율: 이 Mac 에서 데몬 추가 기동 금지). 모듈만 require 하고
//    HOME 은 격리 디렉터리로 바꾼다(config.machineId 가 홈을 읽는다).
//  · 데몬 리포가 없는 환경(PC 만 체크아웃)에서는 조용히 SKIP 한다 — PC 테스트가 남의 리포 존재를
//    전제로 붉어지면 안 된다.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── HOME 격리(데몬 config 가 ~/.codingpt 를 읽는다) ────────────────────────
process.env.HOME = mkdtempSync(path.join(tmpdir(), "cpt-pc-lan-test-"));
delete process.env.CPT_LAN;          // 기본값(=켜짐)
delete process.env.CPT_LAN_SCOPE;    // 기본 scope 'tcp' — 오늘의 단계적 개방 기본값 그대로 검증한다

const here = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(here, "../../codingpt_daemon/packages/runner-core");
if (!existsSync(path.join(coreDir, "lan-local.js"))) {
  console.log("SKIP lan-crossimpl (데몬 runner-core 없음 — 단독 체크아웃)");
  process.exit(0);
}

// 이벤트 루프 유지 — 데몬 probe 내부의 PING 대기 타이머가 `unref()` 라서(데몬이 종료를 막지 않는
//  규율) 다른 할 일이 없으면 노드가 그 타이머 전에 그냥 종료한다 = 테스트가 조용히 멈춘다.
const keepAlive = setInterval(() => {}, 1000);

// ── 시계 주입 ─────────────────────────────────────────────────────────────
let NOW = 1753432800000;
Date.now = () => NOW;
const advance = (ms) => { NOW += ms; };
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const require_ = createRequire(path.join(coreDir, "lan-local.js"));
const lanLib = require_("./lan");
const lanLocal = require_("./lan-local");
const cptServer = require_("./cpt-server");
lanLib.__setNow(() => NOW);

// back REST 스텁 — grant 발급만. (데몬이 뷰어로서 직접 받는다 = 계약 §4.3)
let grantScopes = ["tcp"];
let grantCalls = 0;
cptServer.backFetch = async (method, apiPath, body) => {
  if (method === "POST" && apiPath === "/api/daemon/lan/grant") {
    grantCalls++;
    return {
      grantId: `g${grantCalls}`, secret: "s3cr3t", ttlMs: 600000, scopes: grantScopes,
      hostDeviceId: body.hostDeviceId, proto: 1, lanEpoch: 1,
      endpoints: [{ host: "192.168.0.31", port: 47321, family: 4 }],
    };
  }
  throw Object.assign(new Error("unexpected back call " + apiPath), { status: 500 });
};

// 실제 소켓 다이얼 스텁 — 테스트가 성공/실패를 좌우한다. 데몬 lan-local.probe 는 **한 커맨드 안에서**
//  connect(핸드셰이크 RTT) + ping(2번째 RTT) 으로 승격 2단위를 채운다(계약 §4.3) → 여기서 세션 흉내를 낸다.
let dial = async () => ({ ok: true, rttMs: 5 });
let probeCalls = 0;
lanLib.connect = async (o) => {
  probeCalls++;
  const r = await dial(o);
  if (!r.ok) throw Object.assign(new Error(r.code || "LAN_UNREACHABLE"), { code: r.code || "LAN_UNREACHABLE" });
  const rtt = r.rttMs ?? 5;
  return {
    rttMs: rtt,
    ping: async () => (r.pingOk === false ? Promise.reject(Object.assign(new Error("LAN_TIMEOUT"), { code: "LAN_TIMEOUT" })) : rtt),
    rpc: async () => ({}),
    onClose() {}, close() {},
  };
};

// ── 브라우저 스텁(contract.mjs 와 동일 최소 집합) + IPC → 데몬 실물 배선 ──
const calls = [];
const invoke = async (cmd, args) => {
  calls.push([cmd, args]);
  if (cmd === "lan_status") return lanLocal.status({ hostDeviceId: args.hostDeviceId });
  if (cmd === "lan_probe") return lanLocal.probe({ hostDeviceId: args.hostDeviceId });
  if (cmd === "lan_rpc") return lanLocal.rpc({ hostDeviceId: args.hostDeviceId, method: args.method, params: args.params });
  if (cmd === "back_api") {
    // PC JS 가 직접 받는 grant(프리뷰 upstream 용) — back 라우트와 같은 형태.
    if (args && args.path === "/api/daemon/lan/grant") {
      grantCalls++;
      return { grantId: `pc${grantCalls}`, secret: "s3cr3t", scopes: grantScopes, endpoints: [{ host: "192.168.0.31", port: 47321, family: 4 }] };
    }
    return {};
  }
  return {};
};
globalThis.window = {
  __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
  addEventListener() {}, removeEventListener() {},
  location: { href: "http://localhost/" },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
globalThis.localStorage = {
  _m: new Map([["cpt.deviceKey", "pc-dev-key"]]),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };

const base = process.argv[2] || new URL("../src/js", import.meta.url).href;
const lan = (await import(`${base}/lan.js`)).default;

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const seenLan = () => calls.map((c) => c[0]).filter((c) => c.startsWith("lan_"));
const clear = () => { calls.length = 0; };

// 사이드바 배지 폴링(10초 주기)을 그대로 재현한다.
async function poll(hid, times, stepMs = 10000) {
  for (let i = 0; i < times; i++) {
    advance(stepMs);
    await lan.refreshStatus(hid);
    await tick(); // maybePromote 는 fire-and-forget
  }
}

// ══════════════════════════════════════════════════════════════════════════
// A. 승격 교착 — "probe 1회 = 승격 1단위" 가 아니다(데몬 PROMOTE_OK_STREAK=2)
//    PC 가 mode:'probing' 에서 손을 놓으면 두 번째 probe 가 영원히 오지 않는다 → 배지·fs 직결 死文.
// ══════════════════════════════════════════════════════════════════════════
lanLib.resetPaths(); lanLocal._reset(); lan.resetHost(12);
dial = async () => ({ ok: true, rttMs: 5 });
probeCalls = 0; clear();
await poll(12, 60); // 10분(60폴링) — 60s probe 간격이면 최대 10회 기회
eq("A-1 probing 에서도 승격이 진행된다(직결 배지 ON)", lan.isDirect(12), true);
eq("A-2 probe 가 실제로 발사됐다", probeCalls >= 1, true);
eq("A-3 데몬 경로 상태 = lan", lanLocal.status({ hostDeviceId: 12 }).mode, "lan");
// grant/probe 스팸 금지 — 10분에 10회(60s 간격) 이내
eq("A-4 probe 스팸 없음(10분에 10회 이하)", probeCalls <= 10, true);
// ★ 경계 계약 그 자체: "lan.probe 1회 = 승격 1단위"(계약 §4.3). 이게 깨지면 PC 가 몇 번을 쏘든
//   승격 판정이 어긋난다 — 그래서 데몬 실물로 못 박는다(PC 스텁으로는 절대 볼 수 없는 항목).
lanLib.resetPaths(); lanLocal._reset();
await lanLocal.probe({ hostDeviceId: 41 });
eq("A-5 lan.probe 1회 = 승격 1단위(데몬 책임)", lanLocal.status({ hostDeviceId: 41 }).mode, "lan");

// ══════════════════════════════════════════════════════════════════════════
// B. scope 오염 — 꺼진 scope(rpc) 거절 1건이 켜진 scope(tcp=프리뷰 포워딩)를 죽이면 안 된다.
//    기본 설정(LAN_SCOPES='tcp', CPT_LAN_SCOPE 미설정)에서 lan.rpc 는 정상적으로 LAN_SCOPE 를 준다.
// ══════════════════════════════════════════════════════════════════════════
lanLib.resetPaths(); lanLocal._reset(); lan.resetHost(21);
// 프리뷰 포워딩 실트래픽으로 경로가 승격된 상태를 만든다(PC JS clientKey 경로 엔트리).
const fwdKey = lanLib.pathKey("pc-dev-key", 21, "192.168.0.31");
lanLib.noteSuccess(fwdKey); advance(1000); lanLib.noteSuccess(fwdKey);
eq("B-0 데몬 경로 = lan(프리뷰 직결 중)", lanLocal.status({ hostDeviceId: 21 }).mode, "lan");
advance(10000);
await lan.refreshStatus(21);
eq("B-1 배지 ON", lan.isDirect(21), true);
let threw = false; let res;
try { res = await lan.lanRpc(21, "fs.read", { path: "a.ts" }); } catch (_) { threw = true; }
eq("B-2 LAN_SCOPE → 조용한 릴레이(throw 금지)", [threw, res], [false, null]);
const up = await lan.upstreamFor(21, 5173);
eq("B-3 프리뷰 직결 좌표(upstream)가 살아 있다", up && up.mode, "lan");
advance(10000);
await lan.refreshStatus(21);
eq("B-4 배지도 유지된다(데몬 경로는 여전히 lan)", lan.isDirect(21), true);
// 같은 메서드군을 다시 시도해도 왕복이 반복되지 않는다(억제는 rpc 에만 걸린다)
clear();
await lan.lanRpc(21, "fs.read", { path: "b.ts" });
eq("B-5 scope 거절은 rpc 만 억제(재왕복 없음)", seenLan(), []);

// ══════════════════════════════════════════════════════════════════════════
// C. 배지 거짓 표시 — 'lan' 이 된 뒤 아무도 경로를 검증하지 않으면 집을 떠나도 배지가 켜져 있다.
// ══════════════════════════════════════════════════════════════════════════
lanLib.resetPaths(); lanLocal._reset(); lan.resetHost(31);
dial = async () => ({ ok: true, rttMs: 5 });
await poll(31, 60);
eq("C-0 승격 완료(배지 ON)", lan.isDirect(31), true);
// 다른 네트워크로 이동 = 이제부터 모든 왕복이 타임아웃
dial = async () => ({ ok: false, code: "LAN_TIMEOUT" });
await poll(31, 180); // 30분
eq("C-1 30분 릴레이면 배지가 꺼진다", lan.isDirect(31), false);

clearInterval(keepAlive);
console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
