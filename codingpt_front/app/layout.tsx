import type { Metadata } from 'next';
import './globals.css';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';

export const metadata: Metadata = {
  metadataBase: new URL('https://codingpt.ghmate.com'),
  title: 'CodingPT — 만들면서 배우는 코딩, 모바일 바이브코딩',
  description: '휴대폰에서 AI와 대화하며 앱을 만들고, 코드를 보고 고치며 코딩을 배우는 바이브코딩 입문 서비스.',
  alternates: { canonical: '/' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'rgba(10,13,20,0.85)', backdropFilter: 'blur(8px)', zIndex: 10 }}>
          <div className="container">
            <Nav />
          </div>
        </header>
        <main className="container" style={{ paddingTop: 24, minHeight: '60vh' }}>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
