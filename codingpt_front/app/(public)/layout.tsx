import Footer from '@/components/Footer';
import Nav from '@/components/Nav';

// 공개 영역 크롬 — 상단 Nav + 좁은 컬럼 본문 + Footer.
// 랜딩/로그인/약관 등 비로그인 페이지. PG 크롤러용 정적 HTML(상품·가격·약관·사업자정보) 노출 유지.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'rgba(10,13,20,0.85)', backdropFilter: 'blur(8px)', zIndex: 10 }}>
        <div className="container">
          <Nav />
        </div>
      </header>
      <main className="container" style={{ paddingTop: 24, minHeight: '60vh' }}>{children}</main>
      <Footer />
    </>
  );
}
