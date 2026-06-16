import { BUSINESS } from '@/config/business';

export const metadata = { title: '환불·취소 정책 — CodingPT' };

export default function Refund() {
  return (
    <article style={{ lineHeight: 1.8, maxWidth: 760 }}>
      <h1>환불·취소 정책</h1>
      <h3>1. 구독 해지</h3>
      <ul>
        <li>구독은 마이페이지에서 언제든 해지할 수 있으며, 해지 시 다음 결제일부터 갱신이 중단됩니다.</li>
        <li>해지 후에도 이미 결제된 당월 구독 기간 동안은 서비스를 계속 이용할 수 있습니다.</li>
      </ul>
      <h3>2. 환불</h3>
      <ul>
        <li>이미 결제된 당월 구독료는 디지털 서비스 특성상 원칙적으로 환불되지 않습니다.</li>
        <li>다만 서비스 미사용, 회사의 귀책 등 관계 법령(콘텐츠산업진흥법·전자상거래법 등)이 정하는 경우 환불됩니다.</li>
        <li>환불은 결제 시 사용한 결제수단(신용카드)으로 처리되며, 현금 환급은 불가합니다.</li>
      </ul>
      <h3>3. 결제 오류</h3>
      <p>중복 결제 등 결제 오류가 발생한 경우 확인 후 전액 환불해 드립니다.</p>
      <h3>4. 문의</h3>
      <p>{BUSINESS.complaintNotice}</p>
      <p>민원담당자: {BUSINESS.complaintManager} / {BUSINESS.complaintPhone} / {BUSINESS.customerEmail}</p>
    </article>
  );
}
