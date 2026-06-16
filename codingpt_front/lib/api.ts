// 백엔드(codingpt_back) 연동. SSR(서버 컴포넌트)은 internal URL, 클라이언트는 public URL + bearer.

export const BACKEND_PUBLIC = process.env.NEXT_PUBLIC_BACKEND_URL || 'https://codingpt-back.ghmate.com';
const BACKEND_INTERNAL = process.env.BACKEND_INTERNAL_URL || BACKEND_PUBLIC;

// 서버 컴포넌트(SSR)용 — 공개 카탈로그(플랜/크레딧팩). 크롤러가 읽을 정적 HTML 생성에 사용.
export async function serverGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND_INTERNAL}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface ClientResult<T> { ok: boolean; status: number; data: T | null; message?: string }

// 클라이언트용 — bearer 토큰 자동 첨부.
export async function clientFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<ClientResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    const res = await fetch(`${BACKEND_PUBLIC}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* noop */ }
    return { ok: res.ok, status: res.status, data: data as T, message: data?.message };
  } catch (e) {
    return { ok: false, status: 0, data: null, message: e instanceof Error ? e.message : 'network error' };
  }
}

export interface Plan {
  id: number; code: string; name: string; price_krw: number;
  window_seconds: number; window_unit_limit: number; weekly_unit_limit: number | null; sort_order: number;
}
export const getPlansSSR = () => serverGet<Plan[]>('/api/subscription/plans');

export function formatKRW(n: number): string {
  return '₩' + Number(n || 0).toLocaleString('ko-KR');
}
export function formatUnits(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}
