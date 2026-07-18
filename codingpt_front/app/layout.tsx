import type { Metadata } from 'next';
import './globals.css';

// 루트 레이아웃 — html/body + 전역 스타일/메타데이터만. 크롬(Nav/Footer/사이드바)은
// 라우트 그룹별 레이아웃에서 부여: (public)=공개 Nav+Footer, (shell)=인증 앱셸 사이드바.
export const metadata: Metadata = {
  metadataBase: new URL('https://codingpt.ghmate.com'),
  title: 'CodingPT — 내 PC 작업을 폰·태블릿에서 이어서',
  description: '집·사무실 PC의 터미널·코드 에디터·실시간 미리보기를 휴대폰·태블릿에서 그대로 이어서 작업하는 개발 워크스페이스. 무료 데스크톱 앱으로 간편하게 연결하세요.',
  alternates: { canonical: '/' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
