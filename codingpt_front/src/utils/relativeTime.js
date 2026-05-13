// YouTube 스타일 한국어 상대 시점 ("방금 전", "3분 전", "2시간 전" …).
// 어드민 트리에서 항목 옆에 노출하는 용도. 외부 라이브러리 없이 동작.

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatRelativeTime(input) {
  if (!input) return '';
  const t = new Date(input).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 60) return '방금 전';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}일 전`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}주 전`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}개월 전`;
  return `${Math.floor(diff / YEAR)}년 전`;
}
