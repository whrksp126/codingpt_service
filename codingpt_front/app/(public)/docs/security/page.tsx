export default function Page() {
  return (
    <>
      <div className="dx-crumb">문서 · 보안</div>
      <h1>보안 &amp; 프라이버시</h1>
      <p className="dx-lead">소스와 자격증명은 내 머신에 남고, 원격 데이터는 내 기기 사이에서 종단 간 암호화됩니다.</p>

      <h2>설계상 안전</h2>
      <p>릴레이는 암호화된 데이터를 전달하지만 내용을 복호화하거나 저장하지 않아요. 종단 간은 <b>내 기기들 사이</b>이고, 서버는 그 사이를 이어줄 뿐입니다.</p>

      <h2>내 머신에 남는 것</h2>
      <ul>
        <li>소스 파일 · 터미널 프로세스</li>
        <li>내 AI CLI와 API 키</li>
      </ul>

      <h2>릴레이가 보는 것(과 못 보는 것)</h2>
      <p>릴레이는 라우팅용 메타데이터(기기 ID·연결 상태)와 암호화된 데이터 패킷을 처리합니다. 코드·명령·출력의 평문 내용은 볼 수 없고 저장하지 않습니다.</p>

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
