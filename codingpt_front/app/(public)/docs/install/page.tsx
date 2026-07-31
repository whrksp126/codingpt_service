export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 시작하기</div>
      <h1>설치</h1>
      <p className="dx-lead">Apple Silicon Mac용 무료 데스크톱 앱을 설치하면 메뉴바에서 항상 실행됩니다.</p>

      <p>받은 파일을 실행해 CodingPT를 설치하면 메뉴바에 아이콘이 상주해요. Node·터미널 같은 별도 프로그램은 필요 없습니다. 현재 데스크톱 앱은 Apple Silicon(M1 이상) Mac을 지원합니다.</p>

      <h2>macOS · Apple Silicon</h2>
      <div className="dx-code">
        <div><span className="c"># 1. CodingPT-arm64.dmg 다운로드 후 실행</span></div>
        <div><span className="c"># 2. 메뉴바 아이콘 → 로그인 → [이 머신 연결하기]</span></div>
      </div>

      <div className="dx-callout">
        <span className="dx-cb">Windows</span>
        <div>Windows 호스트 앱은 준비 중입니다. 현재 모바일에서 원격 작업하려면 연결할 Apple Silicon Mac이 필요합니다.</div>
      </div>

      <nav className="dx-docnav">
        <span style={{ flex: 1 }} />
        <a href="/docs/pairing" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">기기 연결(페어링)</div>
        </a>
      </nav>
    </>
  );
}
