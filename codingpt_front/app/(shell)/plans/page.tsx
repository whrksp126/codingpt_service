'use client';

import PlansPanel from '@/components/PlansPanel';

// 구독 플랜 전용 페이지 (워크스페이스 잠금 등 외부 진입점). 내정보에서는 /me 의 '플랜' 패널을 사용.
//  핸드오프(?hc=) 토큰 교환은 상위 (shell) 레이아웃에서 처리한다.
export default function PlansPage() {
  return (
    <div style={{ padding: '32px 28px 64px' }}>
      <a href="/me" className="dim" style={{ fontSize: 13, textDecoration: 'none' }}>← 내정보</a>
      <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', margin: '10px 0 18px' }}>구독 플랜</h1>
      <PlansPanel />
    </div>
  );
}
