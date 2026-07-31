export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 시작하기</div>
      <h1>기기 연결(페어링)</h1>
      <p className="dx-lead">같은 계정으로 내 머신을 찾고, 인증을 거쳐 내 기기끼리 프라이빗하게 연결합니다.</p>

      <p>PC와 모바일 앱에서 같은 계정으로 로그인하면 내 머신이 모바일의 PC 목록에 자동으로 나타납니다. 연결할 PC를 선택하고 앱의 인증 안내를 마치면 종단 간 암호화된 연결이 준비돼요.</p>

      <h2>처음 연결하기</h2>
      <ol>
        <li>모바일에서 연결할 PC를 선택합니다.</li>
        <li>화면에 표시되는 기기 인증 안내를 따릅니다.</li>
        <li>인증이 끝나면 워크스페이스가 자동으로 열립니다.</li>
      </ol>

      <div className="dx-callout">
        <span className="dx-cb">프라이빗 연결</span>
        <div>인증 과정에서 종단 간 암호화 열쇠가 내 기기 사이에만 전달됩니다. 릴레이 서버는 원격 작업 내용을 읽거나 저장할 수 없어요.</div>
      </div>

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
