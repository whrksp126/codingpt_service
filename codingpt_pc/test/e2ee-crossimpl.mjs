// e2ee-crossimpl.mjs — **사람이 눈으로 대조하는 값**의 3구현체 바이트 동치 검증.
//
// 왜 이 파일이 따로 있는가
//  · PC `src/vendor/e2ee/e2ee-proto.js` 는 한동안 4바이트 OKM 의 앞 4바이트로 확인 숫자를 뽑았고,
//    데몬(`runner-core/e2ee.js fingerprint`)·back(`deviceTrustService fingerprintOf`)은 16바이트 OKM 의
//    정해진 오프셋을 썼다 → **표시값이 100% 어긋난 채로** 두 구현이 각자 초록이었다. 그러면 pickCode
//    규칙에 따라 화면이 항상 "서버가 준 숫자" 를 그리고(verified=false), 사용자가 두 화면 숫자를
//    대조하는 유일한 오프라인 방어 채널이 통째로 사라진다. 단위 테스트로는 절대 볼 수 없는 종류의 결함이다.
//  · back `test/e2ee-crossimpl.test.js` 는 back↔데몬만 비교했고, 앱 `scripts/e2ee-conformance.mjs` 는
//    앱↔데몬만 비교했다. **PC 를 보는 눈은 여기밖에 없다.**
//  · 앱 proto 를 직접 import 하지 않는 이유: codingpt_app 은 CJS 패키지(package.json 에 type:module
//    없음)라 node 가 그 .js 를 CommonJS 로 해석해 `import` 문에서 SyntaxError 가 난다. 대신 계약 §2.10 의
//    정본 구현 2개(데몬·back)와 대조한다 — 앱은 자기 conformance 로 같은 두 구현체에 물려 있으므로
//    (앱 == 데몬 == back == PC) 가 전이적으로 고정된다.
//
// 무엇을 대조하는가(절 번호)
//  1 표시값 파생(PC=데몬=back) · 2 봉투 nonce/AAD · 3 진행상태 계약(데몬 실물 출력 → PC 판정)
//  4 host 배지 · 4-B **self 배지** · 5 **행/컨트롤 노출 규칙**(host 행 집합 · 복원 행) · 6 **카피표 전량**
//  ★ 4-B/5/6 은 2026-07-27 추가다: 그전까지 앱·PC 는 **각자 자기 리포의 리터럴**만 단정해서, 같은 논리
//   상태에서 다른 라벨을 내거나(self 배지) 한쪽에만 행이 뜨거나(꺼둔 PC) 한쪽만 문구를 다듬어도
//   두 리포의 테스트가 다 초록이었다 = 이 프로젝트가 반복해 당한 "양쪽 절반이 각자 초록" 사고.
//
// 규율
//  · 데몬을 **기동하지 않는다**(이 Mac 에서 데몬 추가 기동 금지) — 모듈만 require 한다.
//  · HOME 격리: 데몬 e2ee 모듈은 `~/.codingpt/e2ee.json` 을 읽고 쓴다. 격리 없이 돌리면 개발자 PC 의
//    **실제 데몬 열쇠 파일을 덮어쓴다**. 모듈 로드 전에 임시 HOME 으로 바꾼다.
//  · 형제 리포(데몬/back/앱)가 없는 단독 체크아웃에서는 SKIP 하되 **조용히 넘기지 않는다**: 건너뛴 절을
//    세어 마지막 줄에 남기고(`CONFORMANT (n SKIPPED)`), `CPT_CROSSIMPL_STRICT=1` 이면 실패로 승격한다.
//    "ALL CONFORMANT" 만 보고 앱==PC 동치가 검증됐다고 믿으면 그 강제 장치가 개발자 머신 밖에서 사라진다.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nc from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(here, "../../codingpt_daemon/packages/runner-core/e2ee.js");
const BACK = path.resolve(here, "../../codingpt_back/services/deviceTrustService.js");
// SKIP 은 **초록이 아니다**: 형제 리포가 없는 CI 에서 조용히 건너뛰면 "앱==PC 동치" 를 강제하는 장치가
//  개발자 머신에만 존재한다(2026-07-27 교차검증 지적 #7). 그래서 건너뛴 절을 세어 요약에 남기고,
//  `CPT_CROSSIMPL_STRICT=1` 이면 실패로 승격한다(리포 둘을 나란히 두는 CI 에서 켤 수 있다).
const STRICT = /^(1|true|yes|on)$/i.test(String(process.env.CPT_CROSSIMPL_STRICT || ""));
const skipped = [];
const skip = (name, why) => {
  skipped.push(name);
  console.log(`SKIP ${name}${why ? " — " + why : ""}`);
};
if (!existsSync(DAEMON) || !existsSync(BACK)) {
  skip("e2ee-crossimpl 전량", "형제 리포 없음 — 단독 체크아웃");
  console.log(`\n${STRICT ? "1 FAILURE(S) (STRICT: SKIP)" : "SKIPPED: 1 (e2ee-crossimpl 전량)"}`);
  process.exit(STRICT ? 1 : 0);
}

const tmpHome = mkdtempSync(path.join(tmpdir(), "cpt-pc-e2ee-conf-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.CPT_E2EE = "1";

const core = await import("../src/vendor/e2ee/e2ee-core.js");
const proto = await import("../src/vendor/e2ee/e2ee-proto.js");
core.setRandomSource((n) => nc.randomBytes(n));

const D = createRequire(DAEMON)(DAEMON);
// back 모듈은 로드 시 모델 목록을 stdout 에 쏟는다(테스트 출력 오염) → require 동안만 입 막는다.
const B = (() => {
  const log = console.log;
  console.log = () => {};
  try { return createRequire(BACK)(BACK); } finally { console.log = log; }
})();

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log(`PASS ${name}`);
  else { fail += 1; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};
const hex = (b) => Buffer.from(b).toString("hex");

// ══════════════════════════════════════════════════════════════════════════
// 1. 표시값 파생 — 무작위 키 200개 **전량** 일치(계약 §2.10)
//    okm = HKDF(ikm=ikX, salt="cpt-e2ee/v1/fp", info=utf8(userId), 16B)
//      safety = okm[0..8] → base32 12글자 · fp6 = u32BE(okm[8])%10^6 · code4 = u32BE(okm[12])%10^4
// ══════════════════════════════════════════════════════════════════════════
const N = 200;
let mSafety = 0, mFp = 0, mCode = 0, mFmt = 0;
const firstBad = [];
for (let i = 0; i < N; i++) {
  const kp = core.x25519Keypair();
  const uid = 70 + (i % 7); // 계정 바인딩도 같이 흔든다(info=userId)
  const pcS = proto.safetyCode(kp.pub, String(uid));
  const pcF = proto.fingerprint6(kp.pub, String(uid));
  const pcC = proto.verifyCode4(kp.pub, String(uid));
  const dae = D.fingerprint(Buffer.from(kp.pub), uid);
  const bak = B._fingerprintOf(uid, Buffer.from(kp.pub));
  if (pcS === dae.safety && pcS === bak.safetyCode) mSafety++;
  else if (firstBad.length < 3) firstBad.push(`safety pc=${pcS} daemon=${dae.safety} back=${bak.safetyCode}`);
  if (pcF === dae.legacy && pcF === bak.fingerprint) mFp++;
  else if (firstBad.length < 3) firstBad.push(`fp6 pc=${pcF} daemon=${dae.legacy} back=${bak.fingerprint}`);
  if (pcC === dae.short && pcC === bak.verifyCode) mCode++;
  else if (firstBad.length < 3) firstBad.push(`code4 pc=${pcC} daemon=${dae.short} back=${bak.verifyCode}`);
  // 표기 형식(사람이 4글자씩 3그룹으로 읽는다 — 앱 SafetyCode 칩과 같은 그룹 구분)
  if (/^[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$/.test(pcS)
    && /^\d{3} \d{3}$/.test(pcF) && /^\d{4}$/.test(pcC)) mFmt++;
}
ok(`안전코드(60비트) PC=데몬=back ${mSafety}/${N}`, mSafety === N, firstBad.join(" | "));
ok(`지문(6자리) PC=데몬=back ${mFp}/${N}`, mFp === N, firstBad.join(" | "));
ok(`요청번호(4자리) PC=데몬=back ${mCode}/${N}`, mCode === N, firstBad.join(" | "));
ok(`표기 형식(4-4-4 / NNN NNN / NNNN) ${mFmt}/${N}`, mFmt === N);
// userId 바인딩(같은 키·다른 계정 = 다른 값). 이게 깨지면 계정 간 대조가 통과해 버린다.
{
  const kp = core.x25519Keypair();
  ok("userId 바인딩(같은 키·다른 계정은 값이 다르다)",
    proto.safetyCode(kp.pub, "77") !== proto.safetyCode(kp.pub, "78"));
}

// ══════════════════════════════════════════════════════════════════════════
// 2. 봉투 nonce 분할 — [8B 부팅난수][4B 카운터 BE]
//    PC 는 MK 를 JS 로 받지 않으므로 이 경로를 실제로 쓰지 않지만, proto 가 앱과 **바이트 동일 사본**
//    이라는 것이 이 파일의 계약이다. 4B 난수(구버전)면 데몬 리플레이 창 집계가 어긋나고 생일충돌로
//    nonce 재사용(= 키스트림 복원 + 위조)이 현실화된다.
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = nc.randomBytes(32);
  D.setMasterKey(2, mk);
  const boot = core.randomBytes(8);
  const n1 = proto.makeNonce(boot, 1);
  ok("nonce = 부팅난수 8B 그대로", hex(n1.subarray(0, 8)) === hex(boot));
  ok("nonce 카운터는 하위 4B BE", hex(n1.subarray(8)) === "00000001");
  ok("카운터 u32 를 넘으면 랩(상위 비트가 난수 자리를 침범하지 않는다)",
    hex(proto.makeNonce(boot, 0x1_0000_0001).subarray(0, 8)) === hex(boot));

  const env = proto.sealRpc(mk, 2, 12, boot, 1, { id: "x", m: "fs.read", p: { path: "a.ts" }, ts: 1 });
  const opened = D.openRpc(env, { hostDeviceId: 12 });
  ok("PC 봉투 → 데몬 개봉(AAD hostDeviceId 바인딩)", opened && opened.m === "fs.read");
  let replayed = false;
  try { D.openRpc(proto.sealRpc(mk, 2, 12, boot, 1, { id: "x", m: "fs.read", p: {}, ts: 1 }), { hostDeviceId: 12 }); }
  catch (_) { replayed = true; }
  ok("같은 nonce 재사용은 데몬이 거절(리플레이 창이 같은 분할로 집계된다)", replayed);
  const env2 = proto.sealRpc(mk, 2, 12, boot, 2, { id: "y", m: "fs.write", p: {}, ts: 2 });
  ok("카운터 증가분은 정상 통과", D.openRpc(env2, { hostDeviceId: 12 }).m === "fs.write");
  const resp = D.sealRpcResult({ content: "hi" }, { epoch: 2, hostDeviceId: 12 });
  ok("데몬 응답 봉투 → PC 개봉", proto.openRpcResponse(mk, resp, 12).r.content === "hi");
  ok("다른 hostDeviceId 로는 못 연다(AAD 바인딩)", proto.openRpcResponse(mk, resp, 13) === null);
}

// ══════════════════════════════════════════════════════════════════════════
// 3. `e2ee.state` 진행상태 계약 — **데몬 모듈의 실제 출력**을 PC 판정 함수에 그대로 먹인다.
//    왜 하드코딩이 아니라 실물인가: PC 는 데몬이 새로 싣기 시작한 keyState/checking 을 한 줄도 읽지
//    않은 채 "대응 완료" 로 보고된 적이 있다(PC 는 `state` 에 'none'/'enrolled' 가 온다고 가정했고,
//    그때 데몬 pcState() 는 그 값을 반환하지 않았다 = 죽은 분기). 결과는 계정 열쇠 0개(= 사람이
//    켜기 전엔 **영구 평문**)가 화면에 '준비 중'(대기색)으로 보이는 것 — 이 라운드가 없애려던 모호함.
//    ★ 그래서 어서션은 **`state` 값에 기대지 않는다**: 정본은 `keyState`+`checking` 이고, `state` 는
//     데몬 버전에 따라 좁은 도메인(bootstrap/pending)일 수도 넓은 도메인(none/enrolled)일 수도 있다.
//     양쪽 데몬 모두에서 PC 라벨이 같아야 한다 = 그게 "한쪽만 고치면 조용히 죽는다" 의 해독제다.
// ══════════════════════════════════════════════════════════════════════════
{
  const LOCAL = path.resolve(here, "../../codingpt_daemon/packages/runner-core/e2ee-local.js");
  const ACC = path.resolve(here, "../../codingpt_daemon/packages/runner-core/e2ee-account.js");
  const label = await import("../src/js/e2ee-label.js");
  if (!existsSync(LOCAL) || !existsSync(ACC)) {
    skip("e2ee.state 진행상태", "데몬 모듈 없음");
  } else {
    const L = createRequire(LOCAL)(LOCAL);
    const A = createRequire(ACC)(ACC);
    // 2절이 봉투 검증을 위해 심어 둔 MK 를 지운다 — 남기면 `hasKey()` 가 참이라 전부 'trusted' 로 보인다
    //  (진행상태 판정은 열쇠가 **없는** 구간이 본론이다).
    try { D.removeState(); D.clearCache(); } catch (_) { /* noop */ }
    ok("열쇠 없는 상태로 초기화됨(진행상태 절의 전제)", D.hasKey() === false);
    const acc = A._state;                        // 데몬 내부 상태(테스트 노출) — 실제 phase 를 구동한다
    const snap = async (over) => {
      Object.assign(acc, over);
      return await L.state();                    // 네트워크 없음(state 는 왕복하지 않는다)
    };

    // ① 갓 켠 데몬(아직 확인 시작 전) — 열쇠 0개 = 평문. '확인 중'(곧 켜진다고 읽힌다) 이면 안 된다.
    const boot = await snap({ keyState: "none", phase: "boot", running: false, lastRunAt: 0, nextAt: 0 });
    ok("진행상태 정본은 keyState+checking 이다(state 는 데몬 버전에 따라 다르다)",
      boot.keyState === "none" && boot.checking === false, `state=${boot.state} keyState=${boot.keyState} checking=${boot.checking}`);
    ok("갓 켠 데몬 → PC 라벨 '열쇠 없음'(대기색 금지)",
      label.selfStateLabel(boot).text === "열쇠 없음", `state=${boot.state} → ${JSON.stringify(label.selfStateLabel(boot))}`);
    // 좁은 도메인(구 데몬 'bootstrap')이 와도 같은 라벨이어야 한다 = state 를 믿지 않는다는 증명.
    ok("구 데몬(state='bootstrap')이 같은 keyState 를 실어도 라벨 동일",
      label.selfStateLabel({ ...boot, state: "bootstrap" }).text === "열쇠 없음");

    // ② 계정에 열쇠 0개(서버가 bootstrap 이라고 답했다) — 사람이 켜야 한다 = 버튼 노출.
    const bs = await snap({ keyState: "none", phase: "bootstrap", running: false, lastRunAt: Date.now(), nextAt: Date.now() + 300000 });
    ok("계정 열쇠 0개 = 확인 중이 아니다(checking=false)", bs.checking === false && bs.phase === "bootstrap", `state=${bs.state}`);
    ok("계정 열쇠 0개 → '열쇠 없음' + 처음 켜기 버튼",
      label.selfStateLabel(bs).text === "열쇠 없음" && label.needsBootstrap(bs) === true, JSON.stringify(label.selfStateLabel(bs)));
    ok("좁은 도메인 데몬에서도 처음 켜기 버튼은 phase 로 판정한다",
      label.needsBootstrap({ ...bs, state: "bootstrap" }) === true);

    // ③ 확인 중(왕복/재시도 예약) — 여기서만 대기색이다.
    const chk = await snap({ keyState: "none", phase: "enroll", running: true, lastRunAt: Date.now(), nextAt: Date.now() + 5000 });
    ok("확인 중 → '확인 중'(wait)",
      chk.checking === true && label.selfStateLabel(chk).tone === "wait", JSON.stringify(label.selfStateLabel(chk)));

    // ④ 승인 대기 — 데몬 keyState='pending'.
    const pen = await snap({ keyState: "pending", phase: "pending", running: false, lastRunAt: Date.now(), nextAt: Date.now() + 5000 });
    ok("승인 대기 → keyState=pending", pen.keyState === "pending", `state=${pen.state}`);
    ok("승인 대기 → '승인 대기'", label.selfStateLabel(pen).text === "승인 대기", JSON.stringify(label.selfStateLabel(pen)));

    // ⑤ 봉인문(열쇠) 전달 대기 — keyState='enrolled'. `state` 는 구 데몬 'pending' / 신 데몬 'enrolled'
    //  둘 다 실측됐다(2026-07-26 pcState 확장). **어느 쪽이 와도 같은 화면**이어야 한다.
    const enr = await snap({ keyState: "enrolled", phase: "pending", running: false, lastRunAt: Date.now(), nextAt: Date.now() + 5000 });
    ok("봉인문 대기 → keyState=enrolled", enr.keyState === "enrolled", `state=${enr.state}`);
    ok("keyState=enrolled → '승인 대기'(state 값과 무관)",
      label.selfStateLabel(enr).text === "승인 대기"
      && label.selfStateLabel({ ...enr, state: "pending" }).text === "승인 대기"
      && label.selfStateLabel({ ...enr, state: "enrolled" }).text === "승인 대기");

    // ⑥ 와이어 계약 필드 존재(구 PC 가 무시해도 안전한 additive 필드들 — 계약 §2.4).
    ok("계약 필드가 전부 실려 있다(keyState·checking·nextCheckInMs·phase·accountEpoch)",
      ["keyState", "checking", "nextCheckInMs", "phase", "accountEpoch"].every((k) => k in boot));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 4. 호스트별 자물쇠 라벨 — **앱 == PC** 동치(계약 §2.7)
//    왜 이 절이 필요한가(실측): 앱은 2026-07-25 에 `hostLockLabel(selfReady, hostEpoch, myEpoch)` 로
//    세대 대조를 넣었는데 PC 는 `hostEpoch > 0` 만 보는 구 규칙에 남아 **같은 입력에서 두 화면이 다른
//    색**을 그렸다(앱 '확인 중' / PC 초록 '암호화됨'). 사용자는 두 화면을 나란히 놓고 쓰므로 이런
//    비대칭 자체가 신뢰를 깨고, 어느 쪽이 거짓인지 사용자가 판단할 방법이 없다.
//    각 구현의 단위 테스트로는 절대 볼 수 없다(양쪽 다 자기 규칙으로 초록) → 여기서 **앱 소스를 읽어**
//    같은 함수를 실행하고 전 조합을 대조한다.
//    ★ 앱 파일은 TS 라 import 할 수 없다(그리고 codingpt_app 은 CJS 패키지다) → `hostLockLabel` 의
//     본문만 오려 내 new Function 으로 실행한다. 본문에 TS 문법이 들어오면 이 테스트가 실패하는데,
//     그건 "앱 규칙이 바뀌었으니 PC 도 같이 보라" 는 정확한 신호다(조용한 비대칭보다 낫다).
//    ★ 2026-07-27: 인자가 4개로 늘었다(accountEpoch = 서버가 말하는 계정 세대, 한계 ③-2). 한쪽만
//     인자를 늘리면 여기서 `ReferenceError`/불일치로 즉시 터진다 = 의도된 강제 장치다.
{
  const APPST = path.resolve(here, "../../../codingpt_app/src/services/e2ee/e2eeState.ts");
  const HL = await import("../src/js/host-lock.js");
  if (!existsSync(APPST)) {
    skip("앱↔PC 자물쇠 라벨 동치", "codingpt_app 없음 — 단독 체크아웃");
  } else {
    const src = readFileSync(APPST, "utf8");
    /**
     * 앱 TS 함수의 **본문만** 오려 new Function 으로 실행한다.
     *  시그니처에는 브레이스 그룹이 0~2개 붙는다(파라미터 객체 타입 `s: { … }` · 반환 타입 `: { text … }`)
     *  → 어느 그룹이 본문인지 TS 문법으로 세지 않고 **`return` 을 포함한 첫 그룹**으로 고른다(타입 객체
     *  에는 return 이 없다). 함수마다 다른 형태를 쓰는 앱 소스에서 이 판별이 가장 덜 깨진다.
     */
    const balancedFrom = (s, i) => {
      let d = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === "{") d += 1;
        else if (s[j] === "}") { d -= 1; if (d === 0) return j; }
      }
      return -1;
    };
    const sliceFn = (name, args) => {
      const at = src.indexOf(`export function ${name}(`);
      if (at < 0) return { why: `앱에 ${name} 이 없다(이름이 바뀌었는가?)` };
      let open = src.indexOf("{", at);
      for (let guard = 0; guard < 6 && open > 0; guard++) {
        const close = balancedFrom(src, open);
        if (close < 0) return { why: `${name} 본문을 오려낼 수 없다(형식 변경)` };
        const body = src.slice(open + 1, close);
        if (/\breturn\b/.test(body)) {
          try { return { fn: new Function(...args, body) }; }
          catch (e) { return { why: `${name} 본문을 실행할 수 없다(TS 문법 유입?): ${e.message}` }; }
        }
        open = src.indexOf("{", close + 1);
      }
      return { why: `${name} 본문을 찾지 못했다(return 없는 함수?)` };
    };
    const cut = sliceFn("hostLockLabel", ["selfReady", "hostEpoch", "myEpoch", "accountEpoch"]);
    const appFn = cut.fn || null;
    const why = cut.why || "";
    ok("앱 hostLockLabel 본문을 오려내 실행할 수 있다", !!appFn, why);
    if (appFn) {
      // 전 조합 대조 — selfReady × hostEpoch × myEpoch × accountEpoch(각각 모름/0/세대).
      const epochs = [undefined, null, 0, 1, 3, 4];
      let n = 0, mism = 0;
      const bad = [];
      const seen = new Set();
      for (const selfReady of [true, false]) {
        for (const he of epochs) {
          for (const me of epochs) {
            for (const ae of epochs) {
              n += 1;
              const a = appFn(selfReady, he, me, ae);
              const p = HL.hostLockLabel(selfReady, he, me, ae);
              seen.add(`${p.text}|${p.tone}`);
              if (JSON.stringify(a) !== JSON.stringify(p)) {
                mism += 1;
                if (bad.length < 3) bad.push(`(${selfReady},${he},${me},${ae}) app=${JSON.stringify(a)} pc=${JSON.stringify(p)}`);
              }
            }
          }
        }
      }
      ok(`앱==PC 자물쇠 라벨 ${n - mism}/${n} 조합 일치(문구+톤)`, mism === 0, bad.join(" | "));
      // 상태 집합도 고정한다 — 어느 한쪽이 새 문구를 추가하면 위 대조가 잡지만, 집합 자체가 계약이다.
      // 문구 정본 = docs/구현설계-2026-07-25/14-설정-카피-감사.md §4-2. 2026-07-27 개정:
      //  '이 PC 는 평문(열쇠 없음)' → `평문(열쇠 없음)`(행 안에 PC 이름이 이미 있다). **의미·톤·판정
      //  순서는 불변**이고, 앱 e2eeState.ts 와 같은 커밋에서 바뀌어야 위 조합 대조가 통과한다.
      ok("라벨 도메인 = 4가지(암호화됨/평문(열쇠 없음)/확인 중/평문)",
        [...seen].sort().join(",") === ["암호화됨|on", "평문(열쇠 없음)|off", "평문|off", "확인 중|wait"].sort().join(","),
        [...seen].sort().join(","));
      // 이 라운드의 실측 결함(회전 직후 15분 거짓 자물쇠)을 이름으로 못 박아 둔다.
      ok("세대 불일치는 양쪽 다 '확인 중'(회전 직후 거짓 자물쇠 금지)",
        appFn(true, 3, 4).text === "확인 중" && HL.hostLockLabel(true, 3, 4).text === "확인 중");
      // 한계 ③-2: **내가** 계정 세대에 뒤처진 경우. 상대도 같은 옛 세대면 3인자 규칙은 초록을 그린다.
      //  PC 의 자기 행은 hostEpoch 를 자기 epoch 로 채우므로 이 경우가 곧 "자기 행 항상 초록" 이었다.
      ok("내가 계정 세대에 뒤처지면 양쪽 다 '확인 중'(자기 행 거짓 자물쇠 금지)",
        appFn(true, 3, 3, 4).text === "확인 중" && HL.hostLockLabel(true, 3, 3, 4).text === "확인 중",
        `app=${JSON.stringify(appFn(true, 3, 3, 4))} pc=${JSON.stringify(HL.hostLockLabel(true, 3, 3, 4))}`);
      ok("계정 세대를 모르면(구 데몬/응답 전) 대조를 건너뛴다 — 모름을 평문으로 단정하지 않는다",
        appFn(true, 3, 3, null).text === "암호화됨" && HL.hostLockLabel(true, 3, 3, null).text === "암호화됨"
        && HL.hostLockLabel(true, 3, 3).text === "암호화됨");
    }

    // ── 4-B. **self 배지** 동치(2026-07-27 추가 — 교차검증 지적 #7) ─────────────────────────────
    //  4절은 host 배지만 대조했다. self 배지(앱 stateLabel ↔ PC selfStateLabel)는 각자 자기 리포의
    //  리터럴 단정으로만 고정돼 있어서 **같은 논리 상태에서 두 구현이 다른 라벨을 내는 것을 아무도
    //  대조하지 않았다** — 앱이 '꺼짐' 을 그리는 상태에서 PC 가 '확인 중'/'열쇠 없음' 을 그린 실측
    //  결함이 정확히 이 구멍으로 통과했다. 앱 입력({state,policy,ready})을 PC 의 대응 입력
    //  ({state,policy} + ready 인자)으로 옮겨 전 조합을 대조한다.
    //  ★ '열쇠 없음' 은 **PC 전용 산출**이다(앱은 열쇠 0개 계정을 자동 부트스트랩하므로 과도상태가
    //   '확인 중' 이다) → 도메인은 공유하고 산출 주체만 다르다는 사실까지 여기서 못 박는다.
    const LB = await import("../src/js/e2ee-label.js");
    const cutSelf = sliceFn("stateLabel", ["s"]);
    ok("앱 stateLabel 본문을 오려내 실행할 수 있다", !!cutSelf.fn, cutSelf.why || "");
    if (cutSelf.fn) {
      // ⚠ `state:'off'` 는 **두 플랫폼에서 뜻이 다르다** — 유일한 의도적 비대칭이라 격자에서 뺀다:
      //   · PC: 데몬이 준 값이다(policy='off' 이거나 phase='off' = 서버 킬스위치) = **확정된 꺼짐**.
      //     여기에 대기색을 그리면 아무도 켜 주지 않는 상태에서 '확인 중' 이 영원히 돈다.
      //   · 앱: enroll 왕복 전 **초기값**이다 = 미결정 → '확인 중'.
      //  같은 문자열이지만 같은 논리 상태가 아니다. 그 차이는 아래에서 **이름으로** 단정한다
      //  (조용한 비대칭 금지 — 나중에 누가 한쪽을 고치면 이 단정이 먼저 터진다).
      //  알 수 없는 값('quantum')은 양쪽 다 미결정이므로 격자에 넣는다.
      const states = ["unavailable", "unsupported", "bootstrap", "pending", "trusted", "error", "quantum"];
      const policies = ["off", "preferred", "required"];
      let n = 0, mism = 0;
      const bad = [];
      const appSeen = new Set();
      for (const state of states) {
        for (const policy of policies) {
          for (const ready of [true, false]) {
            n += 1;
            const a = cutSelf.fn({ state, policy, ready });
            const p = LB.selfStateLabel({ state, policy }, ready);
            appSeen.add(`${a.text}|${a.tone}`);
            if (JSON.stringify(a) !== JSON.stringify(p)) {
              mism += 1;
              if (bad.length < 3) bad.push(`(${state},${policy},${ready}) app=${JSON.stringify(a)} pc=${JSON.stringify(p)}`);
            }
          }
        }
      }
      ok(`앱==PC self 배지 ${n - mism}/${n} 조합 일치(문구+톤, state='off' 제외)`, mism === 0, bad.join(" | "));
      // 의도적 비대칭 1건 — 위 주석의 이유(양쪽 문구·톤은 카피표 §4-1 안이다). 한쪽을 고치면 여기가 터진다.
      ok("state='off': PC 는 '꺼짐'(데몬이 끈 확정 상태) · 앱은 '확인 중'(초기값=미결정)",
        LB.selfStateLabel({ state: "off", policy: "preferred" }, false).text === "꺼짐"
        && cutSelf.fn({ state: "off", policy: "preferred", ready: false }).text === "확인 중",
        `pc=${JSON.stringify(LB.selfStateLabel({ state: "off", policy: "preferred" }, false))}`
        + ` app=${JSON.stringify(cutSelf.fn({ state: "off", policy: "preferred", ready: false }))}`);
      ok("사용자가 끈 것(policy='off')은 양쪽 다 '꺼짐'(이건 단정해도 되는 유일한 근거다)",
        LB.selfStateLabel({ state: "trusted", policy: "off" }, true).text === "꺼짐"
        && cutSelf.fn({ state: "trusted", policy: "off", ready: true }).text === "꺼짐");
      // 이 라운드가 실제로 잡은 것: 데몬이 진행상태(keyState/checking)를 실어 주면 PC 만 '열쇠 없음' 을
      //  그린다(= 확인이 끝났고 계정 열쇠 0개 = 영구 평문). 그 입력이 없을 때는 위 격자대로 앱과 같다.
      ok("진행상태를 모르면 앱과 같은 라벨 · keyState='none'+확인 끝이면 PC 만 '열쇠 없음'",
        LB.selfStateLabel({ state: "bootstrap", policy: "preferred" }, false).text
          === cutSelf.fn({ state: "bootstrap", policy: "preferred", ready: false }).text
        && LB.selfStateLabel({ state: "bootstrap", policy: "preferred", keyState: "none", checking: false }, false).text === "열쇠 없음");
      // PC 는 진행상태 정본(keyState/checking)까지 받으므로 도메인이 1개 넓다 — 그 전량이 카피표 8종이다.
      const pcSeen = new Set();
      for (const keyState of [undefined, "none", "pending", "enrolled", "trusted"]) {
        for (const checking of [undefined, true, false]) {
          for (const state of states) {
            for (const policy of policies) {
              for (const ready of [true, false]) {
                const l = LB.selfStateLabel({ state, policy, keyState, checking }, ready);
                pcSeen.add(`${l.text}|${l.tone}`);
              }
            }
          }
        }
      }
      // 문구 정본 = docs/구현설계-2026-07-25/14-설정-카피-감사.md §4-1.
      const DOMAIN = ["열쇠 있음|on", "승인 대기|wait", "확인 중|wait", "열쇠 없음|off",
        "꺼짐|off", "미지원|off", "사용 불가|off", "오류|off"];
      ok("PC self 배지 도메인 = 카피표 8종(열쇠 있음/승인 대기/확인 중/열쇠 없음/꺼짐/미지원/사용 불가/오류)",
        [...pcSeen].sort().join(",") === DOMAIN.slice().sort().join(","), [...pcSeen].sort().join(","));
      ok("앱 도메인 ⊂ 그 8종 · '열쇠 없음' 만 PC 전용 산출(앱은 자동 부트스트랩)",
        [...appSeen].every((k) => DOMAIN.includes(k)) && !appSeen.has("열쇠 없음|off"),
        [...appSeen].sort().join(","));
      ok("어느 쪽도 '켜짐' 을 쓰지 않는다(자기 열쇠 보유 ≠ 트래픽 암호화 — §2.7)",
        ![...appSeen, ...pcSeen].some((k) => k.startsWith("켜짐")));
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 화면에 **어떤 행/컨트롤이 존재하는가** — 앱 == PC (2026-07-27 교차검증 지적 #1/#4/#6)
//    문구가 같아도 행 집합이 다르면 두 화면은 다른 화면이다(사용자는 폰과 PC 를 나란히 놓고 본다).
//    실측 결함 2건:
//     ① host 행: PC 는 `runnerKind!=='cloud' && role!=='controller'` 만 봐서 **꺼둔 PC 까지** 나열했고,
//       오프라인이면 epoch 항목이 삭제되므로 그 행이 **영구히 '확인 중'**(= 거짓 진행 신호)이었다.
//       앱은 `d.online` 을 요구해 그 행이 아예 없었다 → PC 3대·2대 꺼둔 사용자는 폰에 1행/PC 에 3행.
//     ② 복구 코드 복원 행: PC 는 `state !== 'trusted' && state !== 'off'`(계약 §2.4 규약 3 위반),
//       앱은 `!ready && state !== 'unavailable' && state !== 'off'` → 사용 불가 상태에서 PC 만 행이 떴다.
//    앱 쪽 규칙은 컴포넌트 안의 **식**이므로(순수 함수가 아니다) 소스에서 그 식만 오려 실행한다 —
//    형태가 바뀌면 추출이 실패해 이 절이 터진다 = "앱이 규칙을 바꿨으니 PC 도 보라" 는 정확한 신호다.
{
  const CARD = path.resolve(here, "../../../codingpt_app/src/components/e2ee/E2eeSettingsCard.tsx");
  const HL = await import("../src/js/host-lock.js");
  const LB = await import("../src/js/e2ee-label.js");
  if (!existsSync(CARD)) {
    skip("앱↔PC 행/컨트롤 노출 동치", "codingpt_app 없음 — 단독 체크아웃");
  } else {
    const card = readFileSync(CARD, "utf8");
    // ★ 2026-07-27 개정 2(기기 목록 통합): 앱 카드가 목록을 직접 그리면서 `S.devices.filter(...)` 가
    //  여러 개(클라우드 제외 필터 등)로 늘었다 → 위치가 아니라 **이름**으로 오려낸다. 앱은 PC
    //  `host-lock.js isHostRow()` 와 같은 이름의 화살표 함수 한 줄을 두고 그것만 배지 판정에 쓴다
    //  (그 이름이 사라지면 이 절이 즉시 터진다 = "앱이 규칙을 바꿨으니 PC 도 보라" 는 신호).
    const mHosts = card.match(/const isHostRow = \(d: AccountDevice\) =>([\s\S]*?);\n/);
    let appHost = null;
    try { if (mHosts) appHost = new Function("d", `return (${mHosts[1]});`); } catch (_) { /* 아래 ok 가 잡는다 */ }
    ok("앱 host 행 규칙(isHostRow)을 오려내 실행할 수 있다", !!appHost, mHosts ? "실행 실패(TS 문법 유입?)" : "isHostRow 식을 찾지 못했다");
    // ★ 개정 4: '복구 코드로 복원' 행은 **양쪽 다 UI 째로 삭제**됐다(카피 감사 §3 개정 4 블록).
    //  canRestore 판정 함수(e2ee-label.js)는 존치하지만 화면이 참조하면 안 된다 — 참조가 되살아나면
    //  "PC 만/앱만 복구 행이 있는" 비대칭이 된다.
    ok("앱 카드에 canRestore 참조가 없다(복구 UI 삭제 — 개정 4)", !/canRestore/.test(card));
    if (appHost) {
      let n = 0, mism = 0;
      const bad = [];
      for (const role of ["host", "controller", undefined]) {
        for (const online of [true, false, undefined]) {
          for (const runnerKind of ["local", "cloud", undefined]) {
            for (const id of [7, "cloud", undefined]) {
              for (const isCurrent of [true, false]) {
                n += 1;
                const d = { role, online, runnerKind, id, isCurrent, name: "PC" };
                const a = !!appHost(d);
                const p = HL.isHostRow(d);
                if (a !== p) { mism += 1; if (bad.length < 3) bad.push(`${JSON.stringify(d)} app=${a} pc=${p}`); }
              }
            }
          }
        }
      }
      ok(`앱==PC host 행 집합 규칙 ${n - mism}/${n} 조합 일치`, mism === 0, bad.join(" | "));
      // 이번 라운드의 실측 결함을 이름으로 못 박는다 — 꺼둔 PC 는 **어느 화면에도** 행이 없다.
      const offPc = { role: "host", online: false, runnerKind: "local", id: 7, name: "MacBook" };
      ok("꺼둔 PC 는 host 행에 없다(영구 '확인 중' 금지 · 폰과 같은 행 수)",
        appHost(offPc) === false && HL.isHostRow(offPc) === false);
      ok("논리 클라우드 호스트는 양쪽 다 제외(BYO 피벗)",
        !appHost({ role: "host", online: true, runnerKind: "cloud", id: "cloud" })
        && !HL.isHostRow({ role: "host", online: true, runnerKind: "cloud", id: "cloud" }));
    }
    // ★ 개정 4: 복원 행 노출 격자 대조는 UI 삭제로 소멸했다. 판정 함수(e2ee-label.js canRestore)의
    //  계약 §2.4 규약 3 앵커만 남긴다 — UI 를 되살리는 날 이 함수가 정본이다(재발명 금지).
    ok("canRestore 판정 함수는 존치·규약 유지(keyState/ready 기반 · state 분기 아님)",
      LB.canRestore({ state: "trusted" }, true) === false
      && LB.canRestore({ state: "unavailable" }, false) === false
      && LB.canRestore({ state: "bootstrap", keyState: "none", checking: false }, false) === true);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 6. **카피 표 ↔ PC 소스** 직접 대조 (2026-07-27 교차검증 지적 #3)
//    지금까지 앱은 `__tests__/e2eeCopy.test.ts`(자기 표), PC 는 `test/contract.mjs`(자기 소스)를 각자
//    하드코딩한 기대값으로 고정했다 → **한쪽만 문구를 다듬으면 두 리포의 테스트가 다 초록인 채** 두
//    화면이 갈라진다(이 프로젝트가 반복해 당한 "양쪽 절반이 각자 초록" 사고와 동형). 이 절은 앱 카피
//    정본 파일(`e2eeCopy.ts`)의 한글 문구 전량이 PC 소스에 **글자까지** 존재하는지 본다.
//    ⚠ by-design 예외만 목록으로 둔다(앱 전용 화면·PC 에 없는 상태). 예외를 늘릴 때는 왜인지 적을 것.
{
  const APPCOPY = path.resolve(here, "../../../codingpt_app/src/components/e2ee/e2eeCopy.ts");
  if (!existsSync(APPCOPY)) {
    skip("앱 카피표 ↔ PC 소스 대조", "codingpt_app 없음 — 단독 체크아웃");
  } else {
    // 주석은 카피가 아니다(양쪽 다 "왜 지웠는가" 를 주석에 남긴다) → 비교 전에 제거한다.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
    const copySrc = strip(readFileSync(APPCOPY, "utf8"));
    //  ★ 개정 6(2026-07-28): 승인 카드 문구는 설정 밖으로 나갔다 — 전역 카드(device-approval.js) ·
    //   공유 조각(e2ee-card.js) · 알림 행 인라인(notifications.js). 앱 카피표는 여전히 **한 표**이므로
    //   PC 측 대조 대상에 그 파일들을 더한다(빠뜨리면 이 절이 "PC 에 문구가 없다" 로 오탐한다).
    const pcSrc = strip(readFileSync(path.resolve(here, "../src/js/settings.js"), "utf8"))
      + strip(readFileSync(path.resolve(here, "../src/js/notifications.js"), "utf8"))
      + strip(readFileSync(path.resolve(here, "../src/js/e2ee.js"), "utf8"))
      + strip(readFileSync(path.resolve(here, "../src/js/e2ee-label.js"), "utf8"))
      + strip(readFileSync(path.resolve(here, "../src/js/host-lock.js"), "utf8"));
    // 앱 전용(PC 에 대응 화면·상태가 없다):
    //  · needUpdate = 앱 보안 저장소 부재(storageMissing) — PC 데몬에는 그 상태가 없다.
    //  · sheet.* = 앱은 승인을 **바텀시트**로 띄운다(PC 는 카드 인라인이라 헤더/빈 상태가 없다).
    //  · '내 PC에서 승인해 주세요' = **짝 문구**다: 대기 화면은 상대 기기 종류를 가리켜야 하므로 폰은
    //    PC 를, PC 는 폰을 부른다. PC 가 쓰는 짝(`wait.titleFromMobile` = '폰·태블릿에서 승인해 주세요')은
    //    같은 표에 있고 이 대조가 그것을 검사한다(둘 다 표에 있으니 한쪽만 다듬는 사고는 여전히 잡힌다).
    //  · '나중에' = 앱 시트 전용 탈출로(5초 뒤 노출). PC 대기 화면은 설정 안 인라인이라 나갈 문이 이미 있다.
    //  · ★ 개정 8 `link.*` = **모바일 첫 로그인의 연동 안내**(온보딩식 전체 화면)다. PC 에는 대응 화면이
    //    없다: PC 는 데몬을 가진 승인자 쪽이고, PC 가 대기하는 경우의 문구는 이미 `wait.titleFromMobile`
    //    짝으로 표에 있다(그쪽은 이 대조가 검사한다). 즉 이 7개는 요청자-모바일 전용 화면의 문구다.
    //  ★ 개정 13: PC 는 사용자가 연동할 폰을 들고 설정을 열었을 때 바로 입력할 수 있도록 코드를
    //   항상 자동 발급한다. 따라서 모바일의 접기/수동 재발급 문구 2개는 PC 에 의도적으로 없다.
    const APP_ONLY = ["앱을 업데이트하면 켜집니다", "자세히 보기", "코드 새로 만들기"];
    const literals = [...copySrc.matchAll(/'([^'\\\n]*)'/g)].map((m) => m[1])
      .filter((s) => /[가-힣]/.test(s) || s.includes("…"))
      .filter((s) => !APP_ONLY.includes(s));
    const missing = [...new Set(literals)].filter((s) => !pcSrc.includes(s));
    ok(`앱 카피표 문구 ${[...new Set(literals)].length}개가 PC 소스에 글자까지 있다`, missing.length === 0,
      missing.map((s) => `없음: "${s}"`).join(" | "));
    // 템플릿 문구(백틱)는 위 추출에 안 걸리므로 조립 결과를 따로 고정한다 — 치환값만 다르고 나머지는 같다.
    //  ★ 개정 9: 구 요약 줄(`새 기기 N대가 승인을 기다려요`)은 양쪽에서 삭제됐고, 대기 사실은 **기기 행**이
    //   말한다 → 양쪽 다 `승인 대기 · {최근}` 형태여야 한다(앱 `row.waitingApproval` = PC 인라인 문구).
    //  ★ 개정 12: 승인·요청번호 템플릿은 사라졌다. 두 화면이 공유하는 템플릿은 **연동 코드 남은 시간**뿐.
    ok("템플릿 문구도 같은 형태다(연동 코드 `m:ss 남음`)", /남음/.test(pcSrc) && /다른 기기에서 이 코드를 입력하세요/.test(pcSrc));
    // 예외 목록이 조용히 늘어나는 것을 막는다(앱 전용 화면·상태 + 개정 5 짝 문구/시트 탈출로 + 개정 8 안내).
    ok("by-design 예외는 3개뿐이다(needUpdate + PC 자동 코드 표시)", APP_ONLY.length === 3);
  }
}

try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* noop */ }
// 건너뛴 절은 **요약에 남긴다**: "ALL CONFORMANT" 만 보고 동치가 검증됐다고 믿으면 앱==PC 강제 장치가
//  개발자 머신 밖에서 사라진다. STRICT 면 종료 코드에도 반영한다.
if (skipped.length) console.log(`\nSKIPPED: ${skipped.length} (${skipped.join(", ")})`);
const bad = fail + (STRICT ? skipped.length : 0);
console.log(bad
  ? `\n${fail} MISMATCH${STRICT && skipped.length ? ` + ${skipped.length} SKIP(STRICT)` : ""}`
  // 'ALL' 은 **전부 검증했을 때만** 쓴다 — 건너뛴 절이 있으면 그 사실이 마지막 줄에 남아야 한다.
  : (skipped.length ? `\nCONFORMANT (${skipped.length} SKIPPED — 앱==PC 동치 미검증)` : "\nALL CONFORMANT"));
process.exit(bad ? 1 : 0);
