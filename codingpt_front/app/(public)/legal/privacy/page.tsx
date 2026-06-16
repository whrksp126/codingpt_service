import LegalDoc from '@/components/legal/LegalDoc';
import { PRIVACY, EFFECTIVE_DATE } from '@/config/legal';

export const metadata = { title: '개인정보처리방침 — CodingPT' };

export default function Privacy() {
  return <LegalDoc title="개인정보처리방침" sections={PRIVACY} effectiveDate={EFFECTIVE_DATE} />;
}
