export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 보안</div>
      <h1>보안 &amp; 프라이버시</h1>
      <p className="dx-lead">소스와 자격증명은 내 머신에 남고, 원격 제어 요청·터미널 화면·미리보기 트래픽은 내 기기 사이에서 종단 간 암호화됩니다.</p>

      <h2>설계상 안전</h2>
      <p>모든 연결은 전송 구간(TLS)에서 암호화돼요. 그 위에 파일 읽기·쓰기 같은 <b>원격 제어 요청</b>, <b>터미널 입출력</b>, <b>미리보기 트래픽</b>은 내 기기들끼리만 가진 열쇠로 한 번 더 봉인되어, 서버는 그 내용을 풀 수 없습니다.</p>

      <h2>내 머신에 남는 것</h2>
      <ul>
        <li>소스 파일 · 터미널 프로세스</li>
        <li>내 AI CLI와 API 키</li>
      </ul>

      <h2>릴레이가 보는 것(과 못 보는 것)</h2>
      <p>릴레이는 라우팅용 메타데이터(기기 ID·연결 상태)를 처리하고, 원격 제어 요청·터미널 화면·미리보기 트래픽은 <b>봉인된 채로 전달</b>합니다. 연결마다 새 세션 열쇠를 만들고, 호스트 PC 가 계정 열쇠를 가졌는지 확인한 뒤에만 연결돼요 — 릴레이가 중간에서 열쇠를 바꿔치기할 수 없습니다.</p>

      <h2>BYO 키 처리</h2>
      <p>AI는 내 머신의 내 CLI로 실행돼요. CodingPT가 모델 자격증명을 프록시하거나 보관하지 않습니다.</p>

      <nav className="dx-docnav">
        <a href="/docs/notifications">
          <div className="dx-nav-lbl">← 이전</div>
          <div className="dx-nav-tt">알림 &amp; 단축키</div>
        </a>
        <a href="/docs/troubleshooting" style={{ textAlign: 'right' }}>
          <div className="dx-nav-lbl">다음 →</div>
          <div className="dx-nav-tt">문제 해결 / FAQ</div>
        </a>
      </nav>
    </>
  );
}
