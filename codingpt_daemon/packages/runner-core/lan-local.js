/**
 * lan-local.js — cpt.sock 의 LAN 직결 커맨드(lan.probe / lan.status / lan.rpc) + 뷰어 grant 취득.
 *
 * 왜 이 파일인가(설계 근거):
 *  · PC 앱은 LAN 클라이언트를 직접 만들지 않는다. 핸드셰이크·프레이밍·히스테리시스는 이미 `lan.js`
 *    (잎 모듈)에 있고, 소켓 수명은 앱 재시작을 넘어 살아야 하므로 데몬이 주인이다(forward 선례).
 *    Rust 는 `{hostDeviceId, …}` 만 보내고 **grant secret 을 웹뷰 JS 에 절대 노출하지 않는다**
 *    (`cptsock.rs:84-88`) → grant 취득도 데몬이 `backFetch` 로 직접 한다.
 *  · lan.js 에 넣지 않는 이유: lan.js 는 node 내장만 쓰는 잎 모듈이어야 한다(control/config/back REST
 *    무의존). 여기서 back REST·설정·캐시 정책을 담당하고 lan.js 는 프로토콜만 담당한다.
 *  · cpt-server.js 에 인라인하지 않는 이유: 커맨드 3개 + grant 캐시·쿨다운·재발급이 붙으면
 *    디스패처가 읽을 수 없게 커진다(파일 상단 분류 규율).
 *
 * ── 절대 규율(어기면 조용히 죽는다) ─────────────────────────────────────────
 *  ① **PC 가 아는 코드만 돌려준다.** `codingpt_pc/src/js/lan.js:181-186` 은
 *     `LAN_UNSUPPORTED|LAN_SCOPE` → 30분 휴면, `LAN_TIMEOUT|LAN_UNREACHABLE|LAN_AUTH_FAILED` → 쿨다운,
 *     **그 밖의 코드는 throw** 한다. 정책성 거절을 새 코드로 표현하면 조용한 릴레이 폴백이
 *     **IDE 의 붉은 오류**로 바뀐다(계약 §4.8).
 *  ② 실패 문구/코드에 `DAEMON_OFFLINE`·"데몬이 연결" 을 절대 넣지 않는다 — 모바일이 에러 문구
 *     정규식으로 호스트 오프라인을 판정한다(`WorkspaceShellContext.tsx:1094`). LAN 은 `LAN_*` 만.
 *  ③ 실패도 `{ok:false, code}` **result** 로 회신한다(소켓 ok:true). 소켓 에러로 던지면 PC 가
 *     "커맨드 자체가 없는 구 데몬"으로 오해해 30분 미지원 처리한다 — 일시 실패엔 과한 벌이다.
 *     예외는 "이 데몬에 lan 모듈이 없다" 뿐(그건 실제로 구 데몬이라 그 판정이 맞다).
 *  ④ `lan.status` 는 clientKey 로 필터하지 않는다 — 경로 키가
 *     `<clientKey>|<hostDeviceId>|<netFingerprint>` 라서 포워딩(PC JS clientKey)과 lan.rpc(데몬
 *     clientKey)가 **다른 엔트리**를 갖는다. hostDeviceId 로만 집계해야 "프리뷰는 직결인데 배지가
 *     안 뜨는"(또는 반대) 어긋남이 없다(계약 §4.3).
 */
const lanLib = require('./lan');

const GRANT_REFRESH_MS = 8 * 60 * 1000;       // 서버 TTL 10분보다 짧게 선제 갱신(PC lan.js:27 미러)
const COOLDOWN_BASE_MS = 60 * 1000;
const COOLDOWN_MAX_MS = 15 * 60 * 1000;
const UNSUPPORTED_RETRY_MS = 30 * 60 * 1000;  // 서버/호스트 미지원은 오래 쉰다(PC lan.js:30 미러)
const RPC_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 1500;
// 승격용 2번째 측정(같은 세션의 ping)까지의 간격. 모바일 `lanLink.PROBE_GAP_MS`(1s)의 축소판 —
//  여기는 cpt.sock 커맨드 안이고 Rust 쪽 read 타임아웃이 10s 인 **동기 호출**이라 1s 를 그대로 쓰면
//  PC 스레드가 그만큼 붙잡힌다. 두 측정이 별개 왕복이면 플래핑 판정 목적은 달성된다.
const PROBE_PING_GAP_MS = 250;

// PC 가 이해하는 코드 집합 — 이 밖의 값은 절대 그대로 내보내지 않는다(규율 ①).
const TRANSPORT_CODE = new Map([
  ['LAN_TIMEOUT', 'LAN_TIMEOUT'],
  ['LAN_UNREACHABLE', 'LAN_UNREACHABLE'],
  ['LAN_AUTH_FAILED', 'LAN_AUTH_FAILED'],
  ['LAN_CLOSED', 'LAN_UNREACHABLE'],
  ['LAN_BUSY', 'LAN_UNREACHABLE'],
  ['LAN_PROTO', 'LAN_UNREACHABLE'],
  ['LAN_CH_EXHAUSTED', 'LAN_UNREACHABLE'],
  ['LAN_OPEN_FAILED', 'LAN_UNREACHABLE'],
  ['LAN_NOT_PRIVATE', 'LAN_UNSUPPORTED'],   // 공용망 = 시도 자체가 무의미 → 오래 쉰다
  ['LAN_BAD_ARGS', 'LAN_UNSUPPORTED'],
  ['LAN_SCOPE', 'LAN_SCOPE'],
  ['LAN_METHOD_NOT_ALLOWED', 'LAN_SCOPE'],  // 호스트 울타리 거절 = 정책성 → LAN_SCOPE 로 표현
  ['LAN_RPC_UNAVAILABLE', 'LAN_UNSUPPORTED'],
  ['LAN_PTY_UNAVAILABLE', 'LAN_UNSUPPORTED'],
]);

function safeCode(code, fallback = 'LAN_UNREACHABLE') {
  const c = String(code || '');
  return TRANSPORT_CODE.get(c) || fallback;
}

// hostDeviceId|clientKey → { grant, at, cooldownUntil, cooldownMs, unsupported }
const hosts = new Map();
// hostDeviceId → { p:Promise<session> }  lan.rpc 세션 재사용(연결마다 핸드셰이크하면 grant 단일 사용
//  정책과 충돌하고 지연도 커진다 — forward.js lanSession 과 같은 모델).
const sessions = new Map();
// hostDeviceId → {host, port}  마지막으로 붙었던(또는 시도한) 좌표. 배지(lan.status)에만 쓴다.
const lastEndpoint = new Map();

function hostState(hid, ck) {
  const k = `${hid}|${ck}`;
  let s = hosts.get(k);
  if (!s) { s = { grant: null, at: 0, cooldownUntil: 0, cooldownMs: COOLDOWN_BASE_MS, unsupported: false }; hosts.set(k, s); }
  return s;
}
function markUnsupported(s) { s.grant = null; s.unsupported = true; s.cooldownUntil = Date.now() + UNSUPPORTED_RETRY_MS; }
function markFail(s) {
  s.grant = null;
  s.cooldownUntil = Date.now() + s.cooldownMs;
  s.cooldownMs = Math.min(s.cooldownMs * 2, COOLDOWN_MAX_MS);
}

// 이 데몬(뷰어)의 안정 clientKey — PC JS 의 `cpt.deviceKey` 와 **달라도 된다**(경로 엔트리가 갈라지는
//  것은 lan.status 집계 규율 ④ 로 흡수된다). machineId 는 자격증명이 아니다.
function viewerClientKey() {
  let mid = '';
  try { mid = String(require('./config').machineId() || ''); } catch (_) { mid = ''; }
  return `pc-daemon-${mid ? mid.slice(0, 8) : 'local'}`;
}

function backFetch(method, path, body) {
  // 지연 require — cpt-server ↔ lan-local 순환을 피한다(cpt-server 가 이 모듈을 부른다).
  return require('./cpt-server').backFetch(method, path, body);
}

/**
 * back 에서 grant 취득(뷰어 자격). null = 직결 불가 → 호출측은 조용히 릴레이.
 *  실패 판정은 **문구가 아니라 code/status** 로 한다(backFetch 가 errorResponse 의 detail.code 와
 *  HTTP status 를 에러에 붙여 준다). 문구 정규식으로 분기하면 서버 문구가 바뀌는 순간 조용히 오작동한다.
 */
async function grantFor(hostDeviceId, scopes, { clientKey, force = false } = {}) {
  const hid = Number(hostDeviceId);
  if (!Number.isFinite(hid)) return null;
  const ck = clientKey || viewerClientKey();
  const s = hostState(hid, ck);
  if (!force && s.grant && Date.now() - s.at < GRANT_REFRESH_MS) return s.grant;
  if (!force && Date.now() < s.cooldownUntil) return null;
  let r = null;
  try {
    r = await backFetch('POST', '/api/daemon/lan/grant', {
      hostDeviceId: hid, clientKey: ck, kind: 'pc', scopes: scopes && scopes.length ? scopes : ['tcp'],
    });
  } catch (e) {
    const code = String((e && e.code) || '');
    const status = Number((e && e.status) || 0);
    // 서버/호스트가 직결을 아예 안 쓴다(스위치 OFF·구 데몬·클라우드 러너) = 오래 쉰다.
    //  429(레이트리밋)·5xx 는 일시 장애 → 짧은 쿨다운(재시도 여지).
    if (code === 'LAN_UNSUPPORTED' || code === 'LAN_SCOPE' || status === 404 || status === 501) markUnsupported(s);
    else markFail(s);
    return null;
  }
  const g = (r && (r.data || r)) || null;
  if (!g || !Array.isArray(g.endpoints) || !g.endpoints.length || !g.grantId || !g.secret) {
    markUnsupported(s);
    return null;
  }
  s.unsupported = false;
  s.cooldownMs = COOLDOWN_BASE_MS;
  s.cooldownUntil = 0;
  s.grant = { ...g, clientKey: ck };
  s.at = Date.now();
  const ep = g.endpoints[0];
  if (ep && ep.host) lastEndpoint.set(hid, { host: ep.host, port: Number(ep.port) || 0 });
  return s.grant;
}

// ── lan.probe ─────────────────────────────────────────────────────────────
// 왕복 **1회 커맨드로 승격까지** 끝낸다. 실패도 `{ok:false, code}` result 로 감싼다(Rust 주석의 형태 그대로).
//
// ★ 왜 한 커맨드에서 probe_ok 를 두 번 기록하는가(승격 데드락 근본 원인 — 계약 §4.2 승격 책임 소재):
//   lan.js 의 승격 조건은 `PROMOTE_OK_STREAK=2`(probe 2연속)인데 예전 구현은 연결→즉시 close 로
//   noteProbeOk 를 1회만 기록했다. 그래서 1회차 probe → okStreak=1 → state='probing' 이 되고,
//   PC 가 'probing' 을 "데몬이 판단 중"으로 읽고 손을 놓으면 2번째 probe 가 영원히 오지 않아
//   경로가 'probing' 에 **영구 고착**했다(경로 상태에는 TTL 이 없다) → '직결' 배지 미표시 +
//   PC lanRpc 의 `if (!s.direct) return null` 때문에 IDE 원격 fs 직결이 **한 번도 시작되지 않았다**
//   (로그·오류 0건, 30분 폴링 180회에 lan_probe 1회로 실측). 모바일 `lanLink.maybePromote` 는
//   한 번의 호출 안에서 ensureLink + pingRtt 로 2회를 채워 동작했다 = 두 플랫폼 비대칭이 정체였다.
//   계약은 "데몬이 성공한 probe 1회로 다음 lan.status 를 lan 으로 만든다"를 정본으로 못박았으므로
//   여기서 모바일과 같은 모양으로 맞춘다:
//     ① 핸드셰이크 RTT = 1번째 probe_ok   ② 같은 세션의 PING/PONG RTT = 2번째 probe_ok
//   세션을 새로 만들지 않으므로 grant(단일 사용)도 1장만 쓴다. (PC 도 'probing' 에서 계속 부추기게
//   고쳐졌지만 그건 이중 안전망이다 — 승격의 소유자는 여기다.)
async function probe(a = {}) {
  const hid = Number(a.hostDeviceId);
  if (!Number.isFinite(hid)) return { ok: false, code: 'LAN_BAD_ARGS' };
  if (!lanLib.enabled()) return { ok: false, code: 'LAN_UNSUPPORTED' };
  const ck = viewerClientKey();
  const grant = await grantFor(hid, lanLib.scopesForDaemon(), { clientKey: ck });
  if (!grant) return { ok: false, code: hostState(hid, ck).unsupported ? 'LAN_UNSUPPORTED' : 'LAN_UNREACHABLE' };
  const ep = grant.endpoints[0];
  const key = lanLib.pathKey(ck, hid, ep.host);
  const port = Number(ep.port);
  lastEndpoint.set(hid, { host: ep.host, port: port || 0 });
  const t0 = Date.now();
  let s = null;
  try {
    s = await lanLib.connect({
      host: ep.host, port, grantId: grant.grantId, secret: grant.secret,
      clientKey: ck, kind: 'pc', timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (e) {
    hostState(hid, ck).grant = null;   // grant 는 단일 사용 — 소모됐으니 다음엔 새로 받는다
    const code = safeCode(e && e.code);
    if (code === 'LAN_TIMEOUT') lanLib.noteSoftFail(key, code); else lanLib.noteHardFail(key, code);
    return { ok: false, code };
  }
  // grant 는 단일 사용이다 — probe 가 소모했으니 캐시를 비워 다음 사용이 새로 받게 한다.
  hostState(hid, ck).grant = null;
  const rtt1 = Number(s.rttMs) > 0 ? Number(s.rttMs) : Math.max(1, Date.now() - t0);
  lanLib.noteProbeOk(key, rtt1);
  let rtt2 = null;
  try {
    await new Promise((r) => { const t = setTimeout(r, PROBE_PING_GAP_MS); if (t.unref) t.unref(); });
    rtt2 = await s.ping(PROBE_TIMEOUT_MS);
  } catch (_) { rtt2 = null; }
  // 2번째 측정이 실패하면 승격하지 않는다(모바일과 동일: soft_fail). 핸드셰이크는 성공했으니
  //  ok:true 로 회신한다 — PC 는 성공 시 상태 캐시를 비워 다음 폴링에서 다시 판정한다.
  if (rtt2 == null) lanLib.noteSoftFail(key, 'LAN_TIMEOUT');
  else lanLib.noteProbeOk(key, rtt2);
  try { s.close(); } catch (_) { /* noop */ }
  return { ok: true, rttMs: rtt2 == null ? rtt1 : Math.min(rtt1, rtt2), endpoint: { host: ep.host, port } };
}

// ── lan.status ────────────────────────────────────────────────────────────
// 배지 전용. PC 는 `mode === 'lan'` 만 본다(그 외는 배지 없음) — 그래서 이 커맨드는 3개 중 유일하게
//  "없어도 무해"하다. 집계는 hostDeviceId 로만(규율 ④).
//  ★ pathSnapshot() 은 **무트래픽 TTL(10분)을 적용한** 값을 준다(계약 §4.10): 실트래픽으로 승격된
//   엔트리를 아무도 강등시키지 못해 거짓 '직결' 배지가 무기한 켜져 있던 문제의 바닥 방어다. 상태
//   조회만 들어오는(=실트래픽 0) 기기가 정확히 그 시나리오라, 여기서 스냅샷을 읽는 것으로 만료가 돈다.
const MODE_RANK = { lan: 4, probing: 3, cooldown: 2, relay: 1 };

function status(a = {}) {
  const hid = Number(a.hostDeviceId);
  if (!Number.isFinite(hid)) return { mode: 'unsupported', hostDeviceId: null };
  if (!lanLib.enabled()) return { mode: 'unsupported', hostDeviceId: hid };
  const now = Date.now();
  const snap = lanLib.pathSnapshot();
  let mode = 'relay';
  let since = 0;
  let cooldownUntil = 0;
  let matched = false;
  for (const [key, e] of Object.entries(snap)) {
    const parts = String(key).split('|');
    if (parts.length < 2 || parts[1] !== String(hid)) continue;   // 중간 세그먼트 = hostDeviceId
    matched = true;
    const eff = e.cooldownUntil > now ? 'cooldown' : (e.state || 'relay');
    if ((MODE_RANK[eff] || 0) > (MODE_RANK[mode] || 0)) { mode = eff; since = e.since || 0; }
    else if (eff === mode && (e.since || 0) > since) since = e.since || 0;
    if ((e.cooldownUntil || 0) > cooldownUntil) cooldownUntil = e.cooldownUntil || 0;
  }
  const ep = lastEndpoint.get(hid) || null;
  const cached = hosts.get(`${hid}|${viewerClientKey()}`);
  const scopes = (cached && cached.grant && Array.isArray(cached.grant.scopes) && cached.grant.scopes.length)
    ? cached.grant.scopes : lanLib.scopesForDaemon();
  return {
    mode,
    hostDeviceId: hid,
    ...(ep ? { endpoint: ep } : {}),
    since: since || 0,
    cooldownUntil: cooldownUntil || 0,
    scopes,
    ...(matched ? {} : { known: false }),   // 아직 아무 경로도 시도되지 않았다(진단용)
  };
}

// ── lan.rpc ───────────────────────────────────────────────────────────────
// 울타리는 **다이얼 전에** 전부 통과해야 한다(계약 §4.4): 데몬 스코프 → 메서드 화이트리스트 →
//  E2EE required 가드 → grant scope. 하나라도 불만족이면 왕복 0회로 `LAN_SCOPE`(= 조용한 릴레이).
function e2eeRequired() {
  // policy='required' 인데 LAN(프레임 암호 없는 평문 leg)으로 파일을 내보내면 "반드시 암호화"를 고른
  //  사용자의 내용이 조용히 평문으로 흐른다(결함 #12). PC JS 도 같은 가드를 갖고 있고 여기가 이중 방어다.
  try {
    const gate = require('./e2ee-gate');
    const e = gate.load();
    return !!(e && typeof e.policy === 'function' && e.policy() === 'required');
  } catch (_) { return false; }
}

function lanSession(hid, grant, ck) {
  const cur = sessions.get(hid);
  if (cur && cur.p) return cur.p;
  const ep = grant.endpoints[0];
  lastEndpoint.set(hid, { host: ep.host, port: Number(ep.port) || 0 });
  const p = lanLib.connect({
    host: ep.host, port: Number(ep.port), grantId: grant.grantId, secret: grant.secret,
    clientKey: ck, kind: 'pc', timeoutMs: 2500,
  }).then((s) => {
    s.onClose(() => { if (sessions.get(hid) && sessions.get(hid).p === p) sessions.delete(hid); });
    return s;
  }).catch((e) => {
    if (sessions.get(hid) && sessions.get(hid).p === p) sessions.delete(hid);
    throw e;
  });
  sessions.set(hid, { p });
  return p;
}

async function rpc(a = {}) {
  const hid = Number(a.hostDeviceId);
  const method = String(a.method || '');
  if (!Number.isFinite(hid) || !method) return { ok: false, code: 'LAN_BAD_ARGS', error: '직결 인자가 부족합니다' };
  if (!lanLib.enabled() || !lanLib.allows('rpc')) {
    return { ok: false, code: 'LAN_SCOPE', error: '이 데몬에서 직결 RPC 가 열려 있지 않습니다' };
  }
  // fs.watch/fs.unwatch·sealed·e2ee.* 는 여기서 이미 막힌다(전역 단일 watcher 사고 방지 — 영구 금지).
  if (!lanLib.rpcAllowed(method)) {
    return { ok: false, code: 'LAN_SCOPE', error: `직결로는 지원하지 않는 요청입니다(${method})` };
  }
  if (e2eeRequired()) return { ok: false, code: 'LAN_SCOPE', error: '암호화 정책이 항상(required)이라 직결을 쓰지 않습니다' };

  const ck = viewerClientKey();
  const grant = await grantFor(hid, ['rpc', 'tcp'], { clientKey: ck });
  if (!grant) return { ok: false, code: hostState(hid, ck).unsupported ? 'LAN_UNSUPPORTED' : 'LAN_UNREACHABLE' };
  // 정책 정본은 서버다 — LAN_SCOPES 에 rpc 가 없으면 grant 에 scope 가 실리지 않고 클라 코드 수정 없이
  //  fs 직결이 꺼진다.
  if (!Array.isArray(grant.scopes) || !grant.scopes.includes('rpc')) {
    return { ok: false, code: 'LAN_SCOPE', error: '서버가 이 기기에 직결 RPC 범위를 주지 않았습니다' };
  }
  const ep = grant.endpoints[0];
  const key = lanLib.pathKey(ck, hid, ep.host);
  if (!lanLib.shouldTry(key)) return { ok: false, code: 'LAN_UNREACHABLE', error: '직결 경로가 쿨다운 중입니다' };

  // useCached=true 는 첫 시도(방금 받은/캐시된 grant), false 는 재발급 재시도.
  const attempt = async (useCached) => {
    const g = useCached ? grant : await grantFor(hid, ['rpc', 'tcp'], { clientKey: ck, force: true });
    if (!g) throw Object.assign(new Error('grant 재발급 실패'), { code: 'LAN_AUTH_FAILED' });
    const s = await lanSession(hid, g, ck);
    return s.rpc(method, a.params || {}, Number(a.timeoutMs) > 0 ? Math.min(Number(a.timeoutMs), 60000) : RPC_TIMEOUT_MS);
  };

  try {
    const result = await attempt(true);
    lanLib.noteSuccess(key);
    return { ok: true, result: result === undefined ? null : result };
  } catch (e) {
    const raw = String((e && e.code) || '');
    // grant 소진/데몬 재기동 → **1회 재발급 재시도**(강등 카운터 무소모 — forward.js refresh 규약과 동일).
    if (raw === 'LAN_AUTH_FAILED') {
      sessions.delete(hid);
      try {
        const result = await attempt(false);
        lanLib.noteSuccess(key);
        return { ok: true, result: result === undefined ? null : result };
      } catch (e2) {
        const code2 = safeCode(e2 && e2.code, 'LAN_AUTH_FAILED');
        lanLib.noteHardFail(key, code2);
        return { ok: false, code: code2, error: '직결 인증에 실패했습니다' };
      }
    }
    if (TRANSPORT_CODE.has(raw)) {
      const code = safeCode(raw);
      if (code === 'LAN_TIMEOUT') lanLib.noteSoftFail(key, code); else lanLib.noteHardFail(key, code);
      return { ok: false, code, error: '직결 요청이 실패했습니다' };
    }
    // 원격 애플리케이션 오류(파일 없음·권한 등)는 **그대로** 올린다 — 릴레이가 줄 오류와 같아야 하고,
    //  여기서 LAN_* 로 뭉개면 성공한 변형(fs.write)을 릴레이가 한 번 더 실행할 수 있다.
    return { ok: false, code: raw || 'LAN_RPC_FAILED', error: (e && e.message) || '직결 요청 실패' };
  }
}

/**
 * forward.start(upstream) 의 grant 재발급 콜백 — 직결 세션이 `LAN_AUTH_FAILED` 로 죽었을 때
 *  forward.js 가 1회 부른다. **PC JS 가 쓰던 clientKey 그대로** 재발급해야 호스트 측 grant 바인딩이
 *  맞는다(clientKey 는 MAC 입력에 들어간다).
 */
async function refreshUpstream(hostDeviceId, clientKey, port) {
  const g = await grantFor(hostDeviceId, ['tcp'], { clientKey, force: true });
  if (!g) return null;
  const ep = g.endpoints[0];
  return { grantId: g.grantId, secret: g.secret, host: ep.host, lanPort: Number(ep.port), clientKey, remotePort: port };
}

function _reset() { hosts.clear(); sessions.clear(); lastEndpoint.clear(); }

module.exports = {
  probe, status, rpc, refreshUpstream, grantFor, viewerClientKey,
  _reset, _hosts: hosts, _sessions: sessions,
};
