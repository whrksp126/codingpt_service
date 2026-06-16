import { BUSINESS } from '@/config/business';

export const metadata = { title: '이용약관 — CodingPT' };

export default function Terms() {
  return (
    <article style={{ lineHeight: 1.8, maxWidth: 760 }}>
      <h1>이용약관</h1>
      <h3>제1조 (목적)</h3>
      <p>본 약관은 {BUSINESS.name}(이하 "회사")가 제공하는 {BUSINESS.serviceName} 서비스(이하 "서비스")의 이용 조건 및 절차, 회사와 이용자의 권리·의무를 규정함을 목적으로 합니다.</p>
      <h3>제2조 (서비스의 내용)</h3>
      <p>서비스는 AI 기반 코딩 어시스턴트 사용권을 제공하는 디지털 상품입니다. 이용자는 월 구독 플랜을 통해 서비스를 이용합니다. 실물 배송은 없습니다.</p>
      <h3>제3조 (구독 및 결제)</h3>
      <p>구독은 월 단위 정기결제이며, 등록한 결제수단으로 매 주기 자동 청구됩니다. 각 플랜은 일정 시간 단위의 사용량 한도를 가지며, 한도는 시간이 지나면 자동 초기화됩니다.</p>
      <h3>제4조 (이용자의 의무)</h3>
      <p>이용자는 관계 법령과 본 약관을 준수해야 하며, 서비스를 부정한 목적으로 이용해서는 안 됩니다.</p>
      <h3>제5조 (환불)</h3>
      <p>환불은 별도의 <a href="/legal/refund">환불·취소 정책</a>에 따릅니다.</p>
      <h3>제6조 (책임)</h3>
      <p>{BUSINESS.complaintNotice}</p>
      <p className="muted">상호: {BUSINESS.name} | 대표: {BUSINESS.ceo} | 사업자등록번호: {BUSINESS.bizRegNo}</p>
    </article>
  );
}
