export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>코드 에디터 (IDE)</h1>
      <p className="dx-lead">내 머신 파일을 모바일에서 바로 편집.</p>
      <p>파일 트리·문법 하이라이트·전체 검색·에디터 그룹 분할까지 PC와 동일하게. 저장하면 내 머신에 즉시 반영돼요.</p>
      <h2>제스처</h2>
      <ul>
        <li>파일 탭 드래그로 분할·재배치</li>
        <li>트리에서 에디터·터미널로 드래그해 열기</li>
      </ul>
      <nav className="dx-docnav">
        <a href="/docs/byo-ai">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">BYO AI (claude/codex)</div>
        </a>
        <a href="/docs/preview" style={{ textAlign: "right" }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">실시간 미리보기</div>
        </a>
      </nav>
    </>
  );
}
