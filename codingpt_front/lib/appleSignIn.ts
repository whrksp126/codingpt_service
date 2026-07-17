// Apple 로그인(웹) — Apple JS SDK(appleid.auth) 팝업 플로우.
//  Services ID 로 팝업을 띄워 id_token 을 받아 백엔드 /api/users/apple-login 으로 넘긴다.
//  PC 앱은 이 웹 페이지를 브라우저로 열어 재사용하므로 PC 로그인도 동일 경로로 커버된다.

const APPLE_JS = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const SERVICES_ID = process.env.NEXT_PUBLIC_APPLE_SERVICES_ID || 'com.ghmate.codingpt.web';
// Apple Developer 포털 Services ID 의 Return URL 과 정확히 일치해야 한다.
const REDIRECT_URI = process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI
  || 'https://codingpt-back.ghmate.com/api/auth/apple/callback';

let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as any).AppleID?.auth) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = APPLE_JS;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { sdkPromise = null; reject(new Error('Apple SDK 로드 실패')); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

export interface AppleSignInResult {
  identityToken: string;
  name?: string;
}

// Apple 팝업 로그인 실행 → { identityToken, name }. 취소 시 null.
export async function appleSignIn(): Promise<AppleSignInResult | null> {
  await loadSdk();
  const AppleID = (window as any).AppleID;
  AppleID.auth.init({
    clientId: SERVICES_ID,
    scope: 'name email',
    redirectURI: REDIRECT_URI,
    usePopup: true,
  });
  try {
    const data = await AppleID.auth.signIn();
    const identityToken: string | undefined = data?.authorization?.id_token;
    if (!identityToken) throw new Error('Apple 인증 토큰이 없습니다.');
    // 이름은 최초 1회만 제공됨.
    const n = data?.user?.name;
    const name = n ? [n.firstName, n.lastName].filter(Boolean).join(' ').trim() || undefined : undefined;
    return { identityToken, name };
  } catch (e: any) {
    // 사용자가 팝업을 닫음 → 조용히 취소로 처리.
    if (e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize') return null;
    throw e;
  }
}
