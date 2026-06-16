'use client';

// 클라이언트 토큰 보관 + 앱→웹 핸드오프 캡처.
// 앱이 인앱 브라우저로 ?handoff=<JWT> 를 붙여 열면, 그 토큰을 저장해 같은 user_id 로 결제한다.

const KEY = 'cpt_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}

export function setToken(token: string) {
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, token);
}

export function clearToken() {
  if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
}

// URL 의 ?handoff= 토큰을 저장하고 쿼리에서 제거. 페이지 진입 시 1회 호출.
export function captureHandoff() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const handoff = url.searchParams.get('handoff');
  if (handoff) {
    setToken(handoff);
    url.searchParams.delete('handoff');
    window.history.replaceState({}, '', url.toString());
  }
}
