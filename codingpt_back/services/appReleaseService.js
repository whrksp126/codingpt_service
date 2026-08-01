/**
 * 모바일 앱 릴리스 — "지금 스토어에서 받을 수 있는 버전"을 알려준다.
 *
 * 왜 자동 감지인가: 이 값이 손으로 고치는 env 하나뿐이면 **반드시 썩는다**. 실제로 2026-08-01
 * 시점에 prod 는 `APP_LATEST_*=0.2.5` 인데 앱은 0.2.9 라, 앱의 업데이트 확인이 늘 "최신 버전입니다"
 * 를 돌려주고 있었다(= 스토어에 새 버전을 올려도 아무도 안내를 못 받는 상태). 사람이 잊어도
 * 스스로 맞춰지는 경로가 필요하다.
 *
 * 정본 우선순위:
 *   1) 스토어 실조회 성공 → **그게 진실**(env 가 낡았어도 자동 보정)
 *   2) 조회 실패/미지원 → env(APP_LATEST_*) → 그마저 없으면 '0.1.0'
 *
 * iOS 는 무인증 공개 lookup API 로 자동. Android 는 공식 조회 API 가 없어(Play Developer API 는
 * 서비스계정 필요) 공개 상세 페이지의 내장 데이터를 읽는 **보조 경로**를 쓴다 — 부서지기 쉬우므로
 * "env 보다 높을 때만 채택" 규칙으로 감싼다(파싱이 깨져도 최악이 기존 동작 유지).
 * 조회 실패는 예외가 아니라 폴백이다(이 API 가 앱 부팅 경로를 막으면 안 됨).
 */

const IOS_APP_ID = '6751457159';
const ANDROID_PKG = 'com.ghmate.codingpt.app';

const LOOKUP_TTL_MS = Number(process.env.APP_STORE_LOOKUP_TTL_MS || 6 * 60 * 60 * 1000);
const LOOKUP_TIMEOUT_MS = Number(process.env.APP_STORE_LOOKUP_TIMEOUT_MS || 3000);
// 앱이 게시된 스토어 국가(us 는 미게시 — 빈 결과가 온다).
const STORE_COUNTRY = process.env.APP_STORE_COUNTRY || 'kr';

// { version, at } — 실패는 캐시하지 않는다(다음 요청이 다시 시도).
const cache = new Map();

function isVersion(v) { return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v.trim()); }

// 단순 semver 비교(프리릴리스 미사용 전제) — pcReleaseService.cmpVersion 과 같은 규칙.
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// App Store 공개 lookup — 인증/키 불필요. 실패는 전부 null(호출측이 env 로 폴백).
//  ⚠ **캐시버스터 필수**(2026-08-01 실측): 같은 URL 을 반복 조회하면 iTunes CDN 이 오래된 값을
//   고정으로 돌려준다. 실제로 ASC 는 0.2.9 게시(READY_FOR_SALE)인데 plain URL 은 계속 0.2.5 를
//   답했고, 쿼리 하나만 덧붙이면 즉시 0.2.9 가 나왔다(재현됨). 이걸 빼면 "자동 감지" 가
//   조용히 낡은 값을 고정해 손으로 고치던 시절과 똑같아진다.
async function fetchIosStoreVersion() {
  const url = `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=${encodeURIComponent(STORE_COUNTRY)}`
    + `&_cb=${Date.now().toString(36)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    const v = body?.results?.[0]?.version;
    return isVersion(v) ? String(v).trim() : null;
  } catch (_) {
    return null;
  }
}

// Play 는 공식 조회 API 가 없다(Developer API = 서비스계정 필요). 대신 공개 상세 페이지의
//  내장 데이터에서 버전을 읽는다 — **부서지기 쉬운 경로라 보조로만 쓴다.**
//  안전장치: 아래 latestFor 가 "env 보다 높을 때만" 채택하므로, 파싱이 깨지거나 엉뚱한 값이
//  나와도 최악이 "env 그대로"다(현재 동작 유지). 낮은 값으로 안내가 역행하는 일은 없다.
async function fetchAndroidStoreVersion() {
  const url = `https://play.google.com/store/apps/details?id=${ANDROID_PKG}&hl=ko&_cb=${Date.now().toString(36)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 내장 JSON 블롭의 버전 슬롯: "141":[[["0.2.9"]]  (2026-08-01 실측 형태)
    const m = /"141":\s*\[\[\["([0-9]+(?:\.[0-9]+)*)"\]\]/.exec(html);
    return m && isVersion(m[1]) ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// 캐시된 스토어 조회.
async function storeVersion(platform) {
  const hit = cache.get(platform);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.version;
  const version = platform === 'ios' ? await fetchIosStoreVersion() : await fetchAndroidStoreVersion();
  if (version) cache.set(platform, { version, at: Date.now() });
  // 조회 실패 시엔 만료된 캐시라도 쓴다 — env 보다 최근 사실일 가능성이 높다.
  return version || hit?.version || null;
}

function envVersion(platform) {
  const raw = platform === 'ios' ? process.env.APP_LATEST_IOS : process.env.APP_LATEST_ANDROID;
  return isVersion(raw) ? String(raw).trim() : null;
}

function minVersion(platform) {
  const raw = platform === 'ios' ? process.env.APP_MIN_IOS : process.env.APP_MIN_ANDROID;
  return isVersion(raw) ? String(raw).trim() : null;
}

function storeUrl(platform) {
  if (platform === 'ios') {
    // ★ 이 링크는 3곳이 같은 값이어야 한다: 여기 · 랜딩 `codingpt_front/app/(public)/page.tsx`
    //   · PC `codingpt_pc/src/js/store-qr.js`(QR 이미지까지 재생성 필요).
    return process.env.APP_STORE_URL_IOS || `https://apps.apple.com/app/id${IOS_APP_ID}`;
  }
  return process.env.APP_STORE_URL_ANDROID || `https://play.google.com/store/apps/details?id=${ANDROID_PKG}`;
}

/**
 * 한 플랫폼의 릴리스 정보. 응답 필드는 **덧붙이기만** 한다 — 구 앱은 {version,url} 만 읽는다.
 *  minVersion: 설정돼 있으면 이 미만 클라이언트는 차단 대상(킬스위치). 평소엔 비워 둔다.
 *  source: 'store' | 'env' | 'default' — 진단용(값이 어디서 왔는지 로그 없이 확인).
 */
async function latestFor(platform) {
  const p = platform === 'ios' ? 'ios' : 'android';
  const fromStore = await storeVersion(p);
  const fromEnv = envVersion(p);
  let version = fromStore || fromEnv || '0.1.0';
  let source = fromStore ? 'store' : (fromEnv ? 'env' : 'default');
  // 스토어 조회가 env 보다 낮게 나오는 경우(막 올린 빌드가 아직 전파 안 됨 등)는 높은 쪽을 쓴다 —
  // 안내 버전이 내려가면 이미 새 버전을 받은 사용자에게 "구버전" 취급이 되어 혼란스럽다.
  if (fromStore && fromEnv && cmpVersion(fromEnv, fromStore) > 0) { version = fromEnv; source = 'env'; }
  const min = minVersion(p);
  return { version, url: storeUrl(p), ...(min ? { minVersion: min } : {}), source };
}

module.exports = { latestFor, cmpVersion, IOS_APP_ID, ANDROID_PKG, _cache: cache };
