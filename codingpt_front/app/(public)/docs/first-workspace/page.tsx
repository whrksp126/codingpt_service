export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 시작하기</div>
      <h1>첫 워크스페이스</h1>
      <p className="dx-lead">내 머신의 폴더를 골라 워크스페이스로 열어요.</p>

      <p>연결된 머신에서 작업할 폴더를 고르면 워크스페이스가 만들어져요. 그 안에서 터미널·에디터·미리보기를 한 화면에 배치해 씁니다.</p>

      <nav className="dx-docnav">
        <a href="/docs/pairing">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">기기 연결(페어링)</div>
        </a>
        <a href="/docs/how-it-works" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">작동 원리</div>
        </a>
      </nav>
    </>
  );
}
