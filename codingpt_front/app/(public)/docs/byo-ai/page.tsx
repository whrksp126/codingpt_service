export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 워크스페이스 사용</div>
      <h1>BYO AI (claude/codex)</h1>
      <p className="dx-lead">
        이미 쓰는 AI CLI를 그대로 — 키는 내 머신 밖으로 안 나가요.
      </p>

      <p>
        터미널에서 도는 CLI라면 무엇이든 됩니다. AI는 <b>내 머신에서 내 계정으로</b> 실행되고,
        CodingPT는 모델 자격증명을 대신 호출하거나 저장하지 않아요.
      </p>
      <ul>
        <li>Claude Code · Codex · Gemini CLI · Aider · opencode …</li>
        <li>구독·API 키는 그대로 내 머신에</li>
      </ul>

      <nav className="dx-docnav">
        <a href="/docs/terminal">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">터미널 &amp; 내 AI CLI</div>
        </a>
        <a href="/docs/editor" style={{ textAlign: 'right' }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">코드 에디터 (IDE)</div>
        </a>
      </nav>
    </>
  );
}
