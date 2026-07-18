// 랜딩 — 정적(Static) 렌더. "내 PC 작업을 폰·태블릿에서 이어서" 제품 소개 + PC 앱 다운로드.
// 외부 import 없음(순수 서버 컴포넌트) — lib/api 등 import 시 prod SSG 가 빈 본문이 되는 문제 회피.
// (2026-07 BYO 피벗: 교육/레슨·월구독 랜딩 → 원격 개발 워크스페이스로 개편.)

const STEPS = [
  { t: '내 PC 연결', d: '무료 데스크톱 앱을 설치하고 로그인 한 번이면 끝. 복잡한 설정 없이 메뉴바에서 바로 연결돼요.' },
  { t: '어디서든 이어서', d: '폰·태블릿에서 내 PC의 터미널·코드 에디터·미리보기를 그대로 열어 작업해요.' },
  { t: '작업 이어가기', d: 'PC에서 하던 일을 폰에서, 다시 태블릿에서 — 같은 워크스페이스가 기기 사이를 따라와요.' },
];

const FEATURES = [
  { t: 'PC 터미널 이어받기', d: '내 컴퓨터의 터미널을 폰에서 그대로 이어받아요. 실행 중이던 CLI·AI 에이전트 세션도 끊기지 않아요.' },
  { t: '코드 에디터', d: '내 PC 폴더의 파일을 열어 바로 편집. 문법 하이라이트·파일 트리·전체 검색을 모바일에서 그대로.' },
  { t: '실시간 미리보기', d: '내 PC에서 돌아가는 개발 서버를 앱 안 브라우저로 확인. 코드를 고치면 결과가 즉시 반영돼요.' },
  { t: '여러 PC·기기', d: '여러 대의 컴퓨터를 연결하고, PC·태블릿·폰을 오가며 자유롭게 전환해요.' },
];

const POINTS = [
  { t: '밖에서도 내 PC로', d: '집·회사 컴퓨터의 개발 환경을 그대로 들고 다녀요. 이동 중에도 작업이 끊기지 않아요.' },
  { t: '내 PC에서 실행', d: '코드는 클라우드로 올라가지 않아요. 내 컴퓨터와 안전하게 릴레이로 연결될 뿐이에요.' },
  { t: '설치는 간단하게', d: '메뉴바 앱 하나. 별도 프로그램 없이 로그인 한 번으로 이 PC를 연결해요.' },
];

const GAP = 104; // 섹션 간 세로 여백

export default function Home() {
  return (
    <div>
      {/* Hero */}
      <section style={{ padding: '88px 0 60px' }}>
        <span className="pill">내 PC ↔ 폰·태블릿 원격 개발</span>
        <h1 style={{ fontSize: 'clamp(32px, 7vw, 48px)', lineHeight: 1.12, marginTop: 20, maxWidth: 680 }}>
          내 컴퓨터를 어디서든
        </h1>
        <p className="muted" style={{ fontSize: 18, maxWidth: 620, lineHeight: 1.7, marginTop: 16 }}>
          집이나 사무실의 PC에서 하던 작업을 <span style={{ color: 'var(--text2)' }}>휴대폰·태블릿에서 그대로</span> 이어가세요.
          터미널·코드 에디터·미리보기를 손안에서 이어서, 어디서든 코딩할 수 있어요.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 28, flexWrap: 'wrap' }}>
          <a className="btn" href="/download" style={{ textDecoration: 'none' }}>PC 앱 다운로드</a>
          <a href="#how" style={{ display: 'inline-flex', alignItems: 'center', padding: '12px 18px', borderRadius: 12, border: '1px solid var(--border)', color: 'var(--text2)', textDecoration: 'none', fontSize: 15, fontWeight: 600 }}>어떻게 쓰나요?</a>
        </div>
      </section>

      {/* Terminal illustration */}
      <section style={{ marginTop: 8 }}>
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '22px 24px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13.5, lineHeight: 2, color: 'var(--text2)' }}>
          <div><span style={{ color: 'var(--dim)' }}>~/my-mac/app</span> <span style={{ color: 'var(--accent)' }}>❯</span> npm run dev</div>
          <div style={{ marginTop: 2 }}><span style={{ color: 'var(--info)' }}>▲</span> ready on http://localhost:3000<span style={{ color: 'var(--dim)' }}>   ← 폰에서 미리보기</span></div>
          <div style={{ marginTop: 8 }}><span style={{ color: 'var(--dim)' }}>~/my-mac/app</span> <span style={{ color: 'var(--accent)' }}>❯</span> <span style={{ color: 'var(--text2)' }}>내 PC의 터미널이 폰으로 그대로 이어집니다.</span></div>
        </div>
      </section>

      {/* 이렇게 이어집니다 */}
      <section id="how" style={{ marginTop: GAP, scrollMarginTop: 80 }}>
        <h2>이렇게 이어집니다</h2>
        <div style={{ marginTop: 28, borderTop: '1px solid var(--border)' }}>
          {STEPS.map((s, i) => (
            <div key={s.t} style={{ display: 'flex', gap: 20, padding: '24px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--accent)', fontWeight: 800, fontFamily: 'ui-monospace, monospace', minWidth: 30, fontSize: 14 }}>{String(i + 1).padStart(2, '0')}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{s.t}</div>
                <div className="muted" style={{ fontSize: 14.5, marginTop: 5, lineHeight: 1.6 }}>{s.d}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 무엇을 할 수 있나요 */}
      <section style={{ marginTop: GAP }}>
        <span className="pill">손안의 개발 환경</span>
        <h2 style={{ marginTop: 16 }}>폰에서, 내 PC 그대로</h2>
        <div className="grid cols-2" style={{ marginTop: 28 }}>
          {FEATURES.map((f) => (
            <div key={f.t}>
              <div style={{ width: 24, height: 2, background: 'var(--accent)', marginBottom: 12 }} />
              <div style={{ fontWeight: 700, fontSize: 16 }}>{f.t}</div>
              <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 6 }}>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 왜 좋을까요 */}
      <section style={{ marginTop: GAP }}>
        <h2>왜 좋을까요</h2>
        <div className="grid cols-3" style={{ marginTop: 28 }}>
          {POINTS.map((p) => (
            <div key={p.t}>
              <div style={{ width: 24, height: 2, background: 'var(--accent)', marginBottom: 12 }} />
              <div style={{ fontWeight: 700, fontSize: 16 }}>{p.t}</div>
              <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 6 }}>{p.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 다운로드 CTA */}
      <section style={{ marginTop: GAP }}>
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '40px 32px', textAlign: 'center' }}>
          <h2 style={{ fontSize: 24 }}>지금 내 PC를 연결하세요</h2>
          <p className="muted" style={{ fontSize: 15, marginTop: 10, lineHeight: 1.7, maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>
            무료 데스크톱 앱을 설치하면 메뉴바에서 바로 실행돼요. 그다음 폰·태블릿 앱에서 로그인하면 어디서든 이어집니다.
          </p>
          <div style={{ marginTop: 22 }}>
            <a className="btn" href="/download" style={{ textDecoration: 'none' }}>PC 앱 다운로드</a>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>
            CodingPT는 사용자 PC의 터미널·파일을 안전하게 릴레이하는 연결 앱입니다. 구독료 없이 무료로 사용해요.
          </p>
        </div>
      </section>

      <div style={{ height: 64 }} />
    </div>
  );
}
