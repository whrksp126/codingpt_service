import LegalDoc from '@/components/legal/LegalDoc';
import { REFUND, EFFECTIVE_DATE } from '@/config/legal';

export const metadata = { title: '환불·취소 정책 — CodingPT' };

export default function Refund() {
  return <LegalDoc title="환불·취소 정책" sections={REFUND} effectiveDate={EFFECTIVE_DATE} />;
}
