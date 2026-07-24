export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 시작하기</div>
      <h1>기기 연결(페어링)</h1>
      <p className="dx-lead">폰·태블릿에서 로그인하면 내 머신이 목록에 나타나요.</p>

      <p>모바일 앱에서 같은 계정으로 로그인하면, 연결된 내 머신들이 사이드바에 뜹니다. 코드 입력 같은 페어링 절차 없이 로그인만으로 이어져요.</p>

      <h2>여러 머신</h2>
      <p>집·회사 머신을 각각 연결하면 기기 목록에서 오가며 전환할 수 있어요.</p>

      <nav className="dx-docnav">
        <a href="/docs/install">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">설치</div>
        </a>
        <a href="/docs/first-workspace" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">첫 워크스페이스</div>
        </a>
      </nav>
    </>
  );
}
