export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 기본 개념</div>
      <h1>작동 원리</h1>
      <p className="dx-lead">
        CodingPT가 어떻게 내 머신과 폰을 잇는지 — 그리고 서버가 왜 원격 작업 내용을 읽을 수 없는지.
      </p>

      <p>
        CodingPT는 클라우드에서 코드를 실행하지 않아요. 내가 가진 기기들 — 머신·폰·태블릿 — 사이를
        이어주는 <b>암호화 릴레이</b>일 뿐입니다. 터미널·파일·미리보기는 모두 <b>내 머신에서</b>{' '}
        돌아가고, 폰은 그 화면을 원격으로 조작할 뿐이에요.
      </p>

      <div className="dx-relay">
        <div className="dx-node">
          <div className="t">내 머신</div>
          <div className="s">터미널·파일·AI CLI</div>
        </div>
        <span className="dx-wire">◀ 암호화 ▶</span>
        <div className="dx-node dx-node-mid">
          <div className="t">릴레이</div>
          <div className="s">메타데이터·암호화 패킷</div>
        </div>
        <span className="dx-wire">◀ 암호화 ▶</span>
        <div className="dx-node">
          <div className="t">폰·태블릿</div>
          <div className="s">원격 조작</div>
        </div>
      </div>

      <h2>무엇이 내 머신에 남나</h2>
      <ul>
        <li>
          <b>소스 코드·파일</b> — 원본은 내 머신 디스크에만 보관돼요.
        </li>
        <li>
          <b>터미널 프로세스</b> — claude 같은 CLI가 내 머신에서 실행돼요.
        </li>
        <li>
          <b>AI 구독·API 키</b> — 릴레이가 대신 호출하거나 보관하지 않아요.
        </li>
      </ul>

      <h2>릴레이가 보는 것 / 못 보는 것</h2>
      <p>
        릴레이는 연결을 위한 메타데이터와 암호화된 패킷을 전달해요. 코드·명령·출력 같은{' '}
        <b>평문 내용</b>은 내 기기 사이에서 종단 간 암호화되어 서버가 읽거나 저장할 수 없습니다.
      </p>

      <div className="dx-callout">
        <span className="dx-cb">핵심</span>
        <div>
          정책상 &quot;안 본다&quot;가 아니라, 구조상 <b>볼 수 없게</b> 설계했어요. 자세한 건{' '}
          <a href="/docs/security">보안 &amp; 프라이버시</a>에서.
        </div>
      </div>

      <nav className="dx-docnav">
        <a href="/docs/first-workspace">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">첫 워크스페이스</div>
        </a>
        <a href="/docs/terminal" style={{ textAlign: 'right' }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">터미널 &amp; 내 AI CLI</div>
        </a>
      </nav>
    </>
  );
}
