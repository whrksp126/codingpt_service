export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 레퍼런스</div>
      <h1>문제 해결 / FAQ</h1>
      <p className="dx-lead">연결이 안 되거나 이상할 때.</p>

      <h2>머신이 목록에 안 보여요</h2>
      <p>메뉴바 앱이 실행 중이고 로그인돼 있는지 확인하세요. 네트워크가 바뀌면 자동으로 재연결됩니다.</p>

      <h2>터미널이 안 열려요</h2>
      <p>앱을 다시 열면 세션이 복구돼요. 계속되면 워크스페이스를 다시 선택하세요.</p>

      <h2>비용이 있나요?</h2>
      <p>무료입니다. AI는 내 구독을 그대로 쓰니 별도 과금이 없어요.</p>

      <nav className="dx-docnav">
        <a href="/docs/security">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">보안 &amp; 프라이버시</div>
        </a>
        <span style={{ flex: 1 }} />
      </nav>
    </>
  );
}
