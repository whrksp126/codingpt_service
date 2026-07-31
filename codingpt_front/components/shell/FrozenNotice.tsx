'use client';

// 웹 바이브코딩 동결 안내 — BYO 원격 개발 서비스 피벗(M0)으로 웹 AI 화면은 잠시 비활성.
// 랜딩/구독/약관/내정보는 그대로 동작한다. 에이전트 스택을 import 하지 않는다.
export default function FrozenNotice({ title }: { title?: string }) {
  return (
    <div style={{ height: '100%', minHeight: 360, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{title || '웹 바이브코딩은 잠시 쉬어가요'}</div>
        <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.7, marginTop: 12 }}>
          지금은 내 PC·서버에서 하던 작업을 모바일에서 이어서 하는 서비스로 전환 중이에요.
          웹 화면은 곧 새 모습으로 다시 찾아올게요.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 20 }}>
          <a
            href="/download"
            style={{ textDecoration: 'none', padding: '11px 20px', borderRadius: 12, background: 'var(--cta)', color: 'var(--on-accent)', fontWeight: 700, fontSize: 14.5 }}
          >
            데스크톱 앱 받기
          </a>
          <a
            href="/docs"
            style={{ textDecoration: 'none', padding: '11px 20px', borderRadius: 12, border: '1px solid var(--border)', color: 'var(--text)', fontWeight: 700, fontSize: 14.5 }}
          >
            연결 방법 보기
          </a>
        </div>
        <a href="/me" className="muted" style={{ display: 'inline-block', marginTop: 16, fontSize: 13 }}>
          내 정보
        </a>
      </div>
    </div>
  );
}
