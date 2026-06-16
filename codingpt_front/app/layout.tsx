import type { Metadata } from 'next';
import './globals.css';

// 루트 레이아웃 — html/body + 전역 스타일/메타데이터만. 크롬(Nav/Footer/사이드바)은
// 라우트 그룹별 레이아웃에서 부여: (public)=공개 Nav+Footer, (shell)=인증 앱셸 사이드바.
export const metadata: Metadata = {
  metadataBase: new URL('https://codingpt.ghmate.com'),
  title: 'CodingPT — 만들면서 배우는 코딩, 모바일 바이브코딩',
  description: '휴대폰에서 AI와 대화하며 앱을 만들고, 코드를 보고 고치며 코딩을 배우는 바이브코딩 입문 서비스.',
  alternates: { canonical: '/' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
