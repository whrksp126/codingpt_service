export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>실시간 미리보기</h1>
      <p className="dx-lead">내 머신 개발 서버를 앱 안 브라우저로.</p>
      <p>
        포트 포워딩으로 <b>진짜 localhost 오리진</b> 그대로 열려요. 뒤로/앞으로·주소창·개발자도구까지 브라우저처럼 쓰고, 코드를 고치면 즉시 반영됩니다.
      </p>
      <nav className="dx-docnav">
        <a href="/docs/editor">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">코드 에디터 (IDE)</div>
        </a>
        <a href="/docs/handoff" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">여러 PC·기기 전환</div>
        </a>
      </nav>
    </>
  );
}
