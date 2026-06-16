import { BUSINESS } from '@/config/business';

export const metadata = { title: '개인정보처리방침 — CodingPT' };

export default function Privacy() {
  return (
    <article style={{ lineHeight: 1.8, maxWidth: 760 }}>
      <h1>개인정보처리방침</h1>
      <p>{BUSINESS.name}(이하 "회사")는 이용자의 개인정보를 중요시하며 관계 법령을 준수합니다.</p>
      <h3>1. 수집하는 개인정보 항목</h3>
      <p>이메일, 닉네임, 결제 내역(결제수단 정보는 PG사가 보관). 서비스 이용 기록(사용량).</p>
      <h3>2. 이용 목적</h3>
      <p>회원 식별, 서비스 제공, 결제 및 정산, 고객 문의 대응.</p>
      <h3>3. 결제 처리 위탁(중요)</h3>
      <p>회사는 안전한 결제를 위해 결제 처리 업무를 다음에 위탁합니다.</p>
      <ul>
        <li>수탁자: 주식회사 코리아포트원(PortOne) 및 결제대행 신용카드사(KG이니시스 등)</li>
        <li>위탁업무: 결제 승인·취소·정산 및 부정거래 방지</li>
      </ul>
      <h3>4. 보유 및 이용 기간</h3>
      <p>회원 탈퇴 시 지체 없이 파기합니다. 단, 전자상거래법 등 관계 법령에 따라 일정 기간 보관해야 하는 거래 기록은 해당 기간 동안 보관합니다.</p>
      <h3>5. 개인정보보호책임자</h3>
      <p>{BUSINESS.privacyOfficer} ({BUSINESS.privacyOfficerEmail})</p>
    </article>
  );
}
