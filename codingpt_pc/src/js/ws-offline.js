// 워크스페이스 목록 "오프라인(캐시)" 판정 — 느림과 끊김을 구분한다.
//
// Rust fetch_workspaces 는 실패·타임아웃이면 last-known 캐시를 stale:true 로 돌려준다. 예전엔 그 한 번으로
//  곧장 "오프라인 — 마지막으로 본 목록" + 서버 필수 조작 차단으로 뒤집혔다. 2026-11-26 실사고: 서버가
//  objectstore 를 Cloudflare 경유로 부르던 탓에 목록 응답이 가끔 10초를 넘겼고, 그때마다 멀쩡히 연결된
//  PC 가 오프라인으로 보였다(데몬 연결은 정상). 게다가 다음 확인이 60초 뒤라 복구도 늦었다.
//
// 규칙:
//  - 온라인이던 중 stale 응답은 연속 WS_STALE_GRACE 회까지는 화면을 바꾸지 않고(지금 목록 유지)
//    WS_GRACE_RETRY_MS 뒤 다시 확인한다 — 한 번 늦은 응답은 오프라인이 아니다.
//  - 처음부터 온라인 확인이 안 된 상태(부팅 직후 등)는 캐시를 바로 보여준다(빈 화면보다 낫다).
//  - 오프라인 표시 중엔 WS_OFFLINE_RETRY_MS 간격으로 재확인해 서버가 돌아오면 곧장 풀린다.

export const WS_STALE_GRACE = 2;
export const WS_GRACE_RETRY_MS = 5000;
export const WS_OFFLINE_RETRY_MS = 10000;

/**
 * @param {{ wasOnline: boolean, misses: number }} p  wasOnline=직전까지 서버 응답으로 온라인이었나, misses=연속 stale 횟수(이번 포함)
 * @returns {{ showOffline: boolean, retryMs: number }}
 */
export function staleDecision({ wasOnline, misses }) {
  if (wasOnline && misses < WS_STALE_GRACE) return { showOffline: false, retryMs: WS_GRACE_RETRY_MS };
  return { showOffline: true, retryMs: WS_OFFLINE_RETRY_MS };
}
