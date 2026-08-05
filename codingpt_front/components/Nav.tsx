// 상단 네비 — 공개 제품 소개와 다운로드만 노출한다.
export default function Nav() {
  return (
    <nav className="nav">
      <a href="/" style={{ display: 'flex', alignItems: 'center' }}>
        <img src="/logo.png" alt="CodingPT" height={22} style={{ display: 'block' }} />
      </a>
      <span style={{ flex: 1 }} />
      <a href="/#features" className="nav-secondary">기능</a>
      <a href="/#pricing" className="nav-secondary">후원</a>
      <a
        href="/#start"
        style={{
          background: 'var(--elevated2)',
          color: 'var(--text)',
          border: '1px solid var(--border-control)',
          padding: '8px 16px',
          borderRadius: 9,
          fontWeight: 680,
          fontSize: 13.5,
          marginLeft: 8,
        }}
      >
        다운로드
      </a>
    </nav>
  );
}
