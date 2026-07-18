'use client';

// 클라이언트 토큰 보관 + 앱→웹 핸드오프 캡처.
// 앱이 인앱 브라우저로 ?handoff=<JWT> 를 붙여 열면, 그 토큰을 저장해 같은 user_id 로 결제한다.

const KEY = 'cpt_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  let t = window.localStorage.getItem(KEY);
  // 핸드오프(?handoff=) 지연 캡처 — 자식 페이지의 인증 가드가 부모 레이아웃의 captureHandoff
  // 보다 먼저 실행돼 /login 으로 튕기는 문제 방지(딥링크 진입에서도 토큰 즉시 인식).
  if (!t) {
    try {
      const h = new URL(window.location.href).searchParams.get('handoff');
      if (h) { setToken(h); t = h; }
    } catch (_) { /* noop */ }
  }
  return t;
}

export function setToken(token: string) {
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, token);
}

export function clearToken() {
  if (typeof window !== 'undefined') window.localStorage.removeItem(KEY);
}

// URL 의 ?handoff= 토큰을 저장하고 쿼리에서 제거. 페이지 진입 시 1회 호출.
//  (레거시 경로 — 신규는 ?hc= 일회용 코드 방식(redeemHandoffCode)을 쓴다. 토큰 URL 노출 방지.)
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

// URL 의 ?hc= 일회용 코드를 서버에서 토큰으로 교환하고 쿼리에서 제거(토큰을 URL 에 싣지 않는 방식).
//  성공 시 true 를 반환하고 setToken 으로 저장 — 진입 시 1회 await 호출.
export async function redeemHandoffCode(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('hc');
  if (!code) return false;
  // 코드는 즉시 제거(재시도/로그 노출 방지) — 실패해도 URL 에 남기지 않음.
  url.searchParams.delete('hc');
  window.history.replaceState({}, '', url.toString());
  try {
    const base = process.env.NEXT_PUBLIC_BACKEND_URL || '';
    const r = await fetch(`${base}/api/users/handoff/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.accessToken) { setToken(d.accessToken); return true; }
  } catch { /* noop */ }
  return false;
}
