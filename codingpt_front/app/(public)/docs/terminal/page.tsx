export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>터미널 &amp; 내 AI CLI</h1>
      <p className="dx-lead">내 머신 터미널을 폰에서 그대로 이어받아요.</p>

      <p>
        실행 중이던 세션이 끊기지 않아요.{' '}
        <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>claude</code> 같은 TUI도
        폰 터치로 조작하고, 보조 키패드로 특수키를 입력합니다.
      </p>

      <div className="dx-code">
        <div>
          <span className="p">❯</span> claude
        </div>
        <div>
          <span className="c"># 폰에서 이어서 대화</span>
        </div>
      </div>

      <h2>여러 터미널</h2>
      <p>탭으로 여러 터미널을 열고, 기기 사이에서 같은 세션을 공유해요.</p>

      <nav className="dx-docnav">
        <a href="/docs/how-it-works">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">작동 원리</div>
        </a>
        <a href="/docs/byo-ai" style={{ textAlign: 'right' }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">BYO AI (claude/codex)</div>
        </a>
      </nav>
    </>
  );
}
