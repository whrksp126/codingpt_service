// 사업자 정보 — 푸터/법적 페이지에 그대로 노출(전자상거래법 + PG 심사 크롤러).
// 민원책임 고지 + 민원담당자 이름/연락처 필수.

export const BUSINESS = {
  name: '슬기로운 사업',
  ceo: '조건호',
  bizRegNo: '315-27-01645',
  mailOrderNo: '제2025-부산진-1148호',
  address: '부산광역시 부산진구 동천로 116, 3층 오픈오피스 12호(전포동, 한신빌딩 티움)',
  customerPhone: '010-2085-2374',
  customerEmail: 'ceo@ghmate.com',
  privacyOfficer: '조건호',
  privacyOfficerEmail: 'ceo@ghmate.com',
  // 민원책임 고지
  complaintNotice: '모든 거래에 대한 책임과 환불, 민원 등은 슬기로운 사업에서 진행합니다.',
  complaintManager: '조건호',
  complaintPhone: '010-2085-2374',
  refundNotice: '환불은 결제 시 사용한 결제수단(신용카드)으로만 가능하며, 현금 환급은 불가합니다.',
  serviceName: 'CodingPT',
} as const;

// 표시 통화
export const CURRENCY = 'KRW';
