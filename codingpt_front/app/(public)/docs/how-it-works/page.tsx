export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 기본 개념</div>
      <h1>작동 원리</h1>
      <p className="dx-lead">
        CodingPT가 어떻게 내 머신과 폰을 잇는지 — 그리고 서버가 무엇을 보고 무엇을 볼 수 없는지.
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
        릴레이는 연결을 위한 메타데이터를 처리하고 데이터를 전달해요. 파일 읽기·쓰기 같은{' '}
        <b>원격 제어 요청</b>은 내 기기 사이에서 종단 간 암호화되어 서버가 풀 수 없습니다. 터미널 화면과
        미리보기 트래픽은 전송 구간(TLS)만 암호화된 채 릴레이를 거쳐요.
      </p>

      <div className="dx-callout">
        <span className="dx-cb">핵심</span>
        <div>
          원격 제어 요청은 정책상 &quot;안 본다&quot;가 아니라 구조상 <b>볼 수 없게</b> 봉인했어요. 터미널 화면·미리보기는
          아직 그 범위 밖이에요. 자세한 건{' '}
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
