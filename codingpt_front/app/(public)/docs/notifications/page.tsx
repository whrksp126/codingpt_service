export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>알림 &amp; 단축키</h1>
      <p className="dx-lead">에이전트가 기다릴 때 폰으로 알려줘요.</p>

      <p>AI 세션이 응답을 기다리거나 끝나면 푸시 알림으로 받아요. 다른 기기에서 확인하면 배너가 정리됩니다. 머신이 활성일 땐 폰 알림을 조용히 하는 설정도 있어요.</p>

      <nav className="dx-docnav">
        <a href="/docs/handoff">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">여러 PC·기기 전환</div>
        </a>
        <a href="/docs/security" style={{ textAlign: 'right' }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">보안 &amp; 프라이버시</div>
        </a>
      </nav>
    </>
  );
}
