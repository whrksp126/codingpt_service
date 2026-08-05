import type { CSSProperties } from 'react';
import { BUSINESS } from '@/config/business';

// 푸터 — 브랜드/링크 컬럼 + 전자상거래법 사업자정보(필수, 전 페이지 SSR 노출).
export default function Footer() {
  const b = BUSINESS;
  const colHead: CSSProperties = {
    color: 'var(--text3)',
    fontSize: 11.5,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '0 0 13px',
    fontWeight: 650,
  };
  const colLink: CSSProperties = {
    display: 'block',
    color: 'var(--text3)',
    marginBottom: 10,
    fontSize: 13.5,
  };
  return (
    <footer className="footer">
      <div className="container">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 1fr 1fr 1fr',
            gap: 28,
            paddingBottom: 36,
          }}
        >
          <div>
            <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
            <p
              style={{
                color: 'var(--dim)',
                fontSize: 13,
                lineHeight: 1.7,
                margin: '12px 0 0',
                maxWidth: 250,
              }}
            >
              내 머신의 코딩 에이전트를 어디서든 이어받는 원격 개발 환경. 코드도 에이전트도 내 머신에.
            </p>
          </div>
          <div>
            <h4 style={colHead}>제품</h4>
            <a href="/#features" style={colLink}>기능</a>
            <a href="/#pricing" style={colLink}>후원</a>
            <a href="/#start" style={colLink}>다운로드</a>
          </div>
          <div>
            <h4 style={colHead}>문서</h4>
            <a href="/docs" style={colLink}>시작하기</a>
            <a href="/docs/security" style={colLink}>보안 &amp; 프라이버시</a>
            <a href="/docs/troubleshooting" style={colLink}>문제 해결</a>
          </div>
          <div>
            <h4 style={colHead}>법적</h4>
            <a href="/legal/terms" style={colLink}>이용약관</a>
            <a href="/legal/privacy" style={colLink}>개인정보처리방침</a>
            <a href="/legal/refund" style={colLink}>환불·취소 정책</a>
          </div>
        </div>

        <div style={{ paddingTop: 20, borderTop: '1px solid var(--border)' }}>
          <p style={{ marginTop: 0 }}>
            {b.name} | 대표 {b.ceo} | 사업자등록번호 {b.bizRegNo} | 통신판매업신고 {b.mailOrderNo}
          </p>
          <p>{b.address}</p>
          <p>고객문의 {b.customerPhone} · {b.customerEmail}</p>
          <p style={{ marginTop: 12, color: 'var(--dim)' }}>
            개인 사용은 무료입니다. 월 4,900원 후원은 선택 사항이며 매월 자동갱신되고 다음 결제 전 언제든 해지할 수 있습니다.
          </p>
        </div>
      </div>
    </footer>
  );
}
