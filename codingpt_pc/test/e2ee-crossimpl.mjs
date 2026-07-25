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
// 규율
//  · 데몬을 **기동하지 않는다**(이 Mac 에서 데몬 추가 기동 금지) — 모듈만 require 한다.
//  · HOME 격리: 데몬 e2ee 모듈은 `~/.codingpt/e2ee.json` 을 읽고 쓴다. 격리 없이 돌리면 개발자 PC 의
//    **실제 데몬 열쇠 파일을 덮어쓴다**. 모듈 로드 전에 임시 HOME 으로 바꾼다.
//  · 형제 리포(데몬/back)가 없는 단독 체크아웃에서는 조용히 SKIP 한다.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nc from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(here, "../../codingpt_daemon/packages/runner-core/e2ee.js");
const BACK = path.resolve(here, "../../codingpt_back/services/deviceTrustService.js");
if (!existsSync(DAEMON) || !existsSync(BACK)) {
  console.log("SKIP e2ee-crossimpl (형제 리포 없음 — 단독 체크아웃)");
  process.exit(0);
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
    console.log("SKIP e2ee.state 진행상태(데몬 모듈 없음)");
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

    // ① 갓 켠 데몬(아직 확인 시작 전) — 열쇠 0개 = 평문. '준비 중'(곧 켜진다는 뜻) 이면 안 된다.
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
{
  const APPST = path.resolve(here, "../../../codingpt_app/src/services/e2ee/e2eeState.ts");
  const HL = await import("../src/js/host-lock.js");
  if (!existsSync(APPST)) {
    console.log("SKIP 앱↔PC 자물쇠 라벨 동치(codingpt_app 없음 — 단독 체크아웃)");
  } else {
    const src = readFileSync(APPST, "utf8");
    // 본문 추출: 시그니처의 반환 타입 객체(`: { text: string; … }`)를 먼저 지나친 뒤 열리는 `{` 가 본문이다.
    const balancedFrom = (s, i) => {
      let d = 0;
      for (let j = i; j < s.length; j++) {
        if (s[j] === "{") d += 1;
        else if (s[j] === "}") { d -= 1; if (d === 0) return j; }
      }
      return -1;
    };
    let appFn = null;
    let why = "";
    const at = src.indexOf("export function hostLockLabel(");
    if (at < 0) why = "앱에 hostLockLabel 이 없다(이름이 바뀌었는가?)";
    else {
      const retOpen = src.indexOf("{", at);            // 반환 타입 객체
      const retClose = balancedFrom(src, retOpen);
      const bodyOpen = src.indexOf("{", retClose + 1); // 함수 본문
      const bodyClose = balancedFrom(src, bodyOpen);
      if (retClose < 0 || bodyOpen < 0 || bodyClose < 0) why = "앱 함수 본문을 오려낼 수 없다(형식 변경)";
      else {
        const body = src.slice(bodyOpen + 1, bodyClose);
        try { appFn = new Function("selfReady", "hostEpoch", "myEpoch", body); }
        catch (e) { why = `앱 본문을 실행할 수 없다(TS 문법 유입?): ${e.message}`; }
      }
    }
    ok("앱 hostLockLabel 본문을 오려내 실행할 수 있다", !!appFn, why);
    if (appFn) {
      // 전 조합 대조 — selfReady × hostEpoch(모름/0/세대) × myEpoch(모름/0/세대).
      const epochs = [undefined, null, 0, 1, 3, 4];
      let n = 0, mism = 0;
      const bad = [];
      const seen = new Set();
      for (const selfReady of [true, false]) {
        for (const he of epochs) {
          for (const me of epochs) {
            n += 1;
            const a = appFn(selfReady, he, me);
            const p = HL.hostLockLabel(selfReady, he, me);
            seen.add(`${p.text}|${p.tone}`);
            if (JSON.stringify(a) !== JSON.stringify(p)) {
              mism += 1;
              if (bad.length < 3) bad.push(`(${selfReady},${he},${me}) app=${JSON.stringify(a)} pc=${JSON.stringify(p)}`);
            }
          }
        }
      }
      ok(`앱==PC 자물쇠 라벨 ${n - mism}/${n} 조합 일치(문구+톤)`, mism === 0, bad.join(" | "));
      // 상태 집합도 고정한다 — 어느 한쪽이 새 문구를 추가하면 위 대조가 잡지만, 집합 자체가 계약이다.
      ok("라벨 도메인 = 4가지(암호화됨/이 PC 는 평문(열쇠 없음)/확인 중/평문)",
        [...seen].sort().join(",") === ["암호화됨|on", "이 PC 는 평문(열쇠 없음)|off", "평문|off", "확인 중|wait"].sort().join(","),
        [...seen].sort().join(","));
      // 이 라운드의 실측 결함(회전 직후 15분 거짓 자물쇠)을 이름으로 못 박아 둔다.
      ok("세대 불일치는 양쪽 다 '확인 중'(회전 직후 거짓 자물쇠 금지)",
        appFn(true, 3, 4).text === "확인 중" && HL.hostLockLabel(true, 3, 4).text === "확인 중");
    }
  }
}

try { rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* noop */ }
console.log(fail ? `\n${fail} MISMATCH` : "\nALL CONFORMANT");
process.exit(fail ? 1 : 0);
