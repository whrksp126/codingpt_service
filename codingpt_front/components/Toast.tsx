'use client';

// 토스트 — 하단 중앙에 잠깐 떠 있는 안내. globals.css 의 .cpt-toast 토큰(elevated/border)으로 디자인 일관성 유지.
// 자동 사라짐 타이머는 호출부에서 관리(메시지 state 를 null 로).
export default function Toast({ message, tone = 'neutral' }: { message: string | null; tone?: 'neutral' | 'success' }) {
  if (!message) return null;
  return (
    <div className="cpt-toast-wrap">
      <div className="cpt-toast" style={tone === 'success' ? { borderColor: 'rgba(52,211,153,0.4)' } : undefined}>
        {message}
      </div>
    </div>
  );
}
