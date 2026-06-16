import { BUSINESS } from '@/config/business';

// 푸터 — 전자상거래법 사업자정보 + 법적 페이지 링크 (전 페이지 SSR 노출).
export default function Footer() {
  const b = BUSINESS;
  return (
    <footer className="footer">
      <div className="container">
        <p style={{ marginTop: 0 }}>
          <a href="/legal/terms">이용약관</a> · <a href="/legal/privacy">개인정보처리방침</a> · <a href="/legal/refund">환불·취소 정책</a>
        </p>
        <p>
          {b.name} | 대표 {b.ceo} | 사업자등록번호 {b.bizRegNo} | 통신판매업신고 {b.mailOrderNo}
        </p>
        <p>{b.address}</p>
        <p>고객문의 {b.customerPhone} · {b.customerEmail}</p>
      </div>
    </footer>
  );
}
