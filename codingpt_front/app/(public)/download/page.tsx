// PC용 CodingPT(데스크톱 트레이 앱) 다운로드 페이지 — 순수 서버 컴포넌트(정적).
//  앱의 "내 PC 연결 → CodingPT 다운로드" 버튼이 이 페이지(codingpt.ghmate.com/download)를 연다.
//  ⚠️ 외부 import 금지(SSG 빈 본문 버그 회피) — 랜딩 페이지 규칙과 동일.

export const metadata = {
  title: 'CodingPT for Mac · Windows — 내 PC 연결',
  description: '내 컴퓨터를 CodingPT에 연결해 폰에서 PC 폴더로 바이브코딩하세요. 설치만 하면 메뉴바에서 실행됩니다.',
};

// 다운로드 파일 URL(objectstore 공개 경로). 새 버전 배포 시 이 상수만 갱신.
//  Windows 는 준비되면 EXE_URL 을 채우고 아래 disabled 를 해제.
const MAC_DMG_URL = 'https://objectstore.ghmate.com/codingpt/common/downloads/CodingPT-arm64.dmg';
const WIN_EXE_URL = ''; // 준비 중

const STEPS = [
  { t: '설치', d: '받은 파일을 실행해 CodingPT를 설치하면 메뉴바(트레이)에 아이콘이 상주합니다. Node·터미널 같은 별도 프로그램은 필요 없어요.' },
  { t: '연결', d: 'CodingPT를 처음 열면 로그인 버튼 하나가 보여요. 누르면 브라우저가 열리고, CodingPT 계정으로 로그인 후 [이 PC 연결하기]를 누르면 끝 — 코드 입력도 필요 없습니다.' },
  { t: '어디서든', d: '연결되면 폰·태블릿·다른 PC에서 이 컴퓨터의 폴더를 IDE로 열어 편집하고, 터미널의 claude 같은 CLI 에이전트를 이어서 조작할 수 있어요.' },
];

export default function DownloadPage() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', paddingBottom: 60 }}>
      <section style={{ textAlign: 'center', paddingTop: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--accent, #46e35a)', fontWeight: 700, letterSpacing: 1 }}>CodingPT for Desktop</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, marginTop: 8, lineHeight: 1.25 }}>
          내 컴퓨터를 CodingPT에 연결하세요
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text2, #aeb8c8)', marginTop: 12, lineHeight: 1.6 }}>
          설치만 하면 메뉴바에서 항상 실행됩니다. 폰에서 내 PC 폴더로 바이브코딩하고,
          PC 터미널을 이어서 조작할 수 있어요.
        </p>
      </section>

      {/* 다운로드 버튼 */}
      <section style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap', marginTop: 28 }}>
        <a
          href={MAC_DMG_URL}
          style={{
            display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            minWidth: 220, padding: '16px 24px', borderRadius: 14,
            background: 'var(--accent, #46e35a)', color: '#052e16', fontWeight: 800,
            textDecoration: 'none',
          }}
        >
          <span style={{ fontSize: 16 }}>macOS 다운로드</span>
          <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.75 }}>.dmg · Apple Silicon</span>
        </a>

        <span
          aria-disabled
          style={{
            display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            minWidth: 220, padding: '16px 24px', borderRadius: 14,
            background: 'var(--surface2, #1a2130)', color: 'var(--text2, #aeb8c8)', fontWeight: 700,
            border: '1px solid var(--border, #232c3d)',
          }}
        >
          <span style={{ fontSize: 16 }}>Windows</span>
          <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7 }}>{WIN_EXE_URL ? '.exe' : '준비 중'}</span>
        </span>
      </section>

      {/* macOS 미서명 안내(공증 전까지) */}
      <p style={{ fontSize: 12.5, color: 'var(--dim, #6b7688)', textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
        macOS에서 “확인되지 않은 개발자” 안내가 뜨면, 앱을 <b>마우스 오른쪽 클릭 → 열기</b>로 한 번 실행하면 됩니다.
      </p>

      {/* 사용 방법 */}
      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 16 }}>연결 방법</h2>
        <ol style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {STEPS.map((s, i) => (
            <li key={s.t} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                flex: 'none', width: 30, height: 30, borderRadius: 999,
                background: 'var(--surface2, #1a2130)', border: '1px solid var(--border, #232c3d)',
                color: 'var(--accent, #46e35a)', fontWeight: 800, fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{i + 1}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{s.t}</div>
                <div style={{ fontSize: 13.5, color: 'var(--text2, #aeb8c8)', marginTop: 3, lineHeight: 1.6 }}>{s.d}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p style={{ fontSize: 12, color: 'var(--dim, #6b7688)', marginTop: 32, lineHeight: 1.6 }}>
        CodingPT 데스크톱 앱은 사용자 PC의 터미널·파일을 모바일 앱으로 안전하게 릴레이하는 연결 프로그램입니다.
        AI 자격증명을 다루거나 외부로 전송하지 않습니다.
      </p>
    </div>
  );
}
