import LegalDoc from '@/components/legal/LegalDoc';
import { TERMS, EFFECTIVE_DATE } from '@/config/legal';

export const metadata = { title: '이용약관 — CodingPT' };

export default function Terms() {
  return <LegalDoc title="이용약관" sections={TERMS} effectiveDate={EFFECTIVE_DATE} />;
}
