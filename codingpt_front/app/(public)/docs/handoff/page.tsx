export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>여러 PC·기기 전환</h1>
      <p className="dx-lead">같은 워크스페이스가 기기를 따라와요.</p>
      <p>머신에서 하던 일을 폰에서, 다시 태블릿에서 이어가요. 레이아웃·열린 파일·터미널 세션이 기기 사이에서 공유됩니다.</p>
      <h2>핸드오프</h2>
      <p>여러 대의 머신을 연결하고, 활성 기기를 오가며 자유롭게 전환해요.</p>
      <nav className="dx-docnav">
        <a href="/docs/preview">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">실시간 미리보기</div>
        </a>
        <a href="/docs/notifications" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">알림 & 단축키</div>
        </a>
      </nav>
    </>
  );
}
