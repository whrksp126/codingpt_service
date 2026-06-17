// 랜딩 — 정적(Static) 렌더. 입문자가 직접 만들며 배우는 모바일 코딩 교육 서비스 소개 + 요금/구독.
// 외부 import 없음(순수 서버 컴포넌트) — lib/api 등 import 시 prod SSG 가 빈 본문이 되는 문제 회피.
const formatKRW = (n: number) => '₩' + Number(n || 0).toLocaleString('ko-KR');
// 가격·플랜 설명은 정적 상수로 노출 — PG 크롤러가 JS/백엔드 없이도 상품·가격을 항상 읽도록(빌드 시 back 미도달 무관).
// ⚠️ 순수 서버 컴포넌트 유지(외부 import 금지 — SSG 빈 본문 버그 회피) → DB 시드(subscription_plan)를 여기 그대로 미러.
//    런타임 단일 출처는 DB(/api/subscription/plans, /me·앱이 동적 렌더). 가격/카피 변경 시 이 상수도 함께 갱신.
const PLANS = [
  {
    code: 'free', name: 'Free', price_krw: 0, badge: null as string | null, mult: null as string | null,
    desc: '코딩이 처음인 분께. 부담 없이 먼저 경험해 보세요.',
    features: ['AI 채팅으로 코딩 질문·학습', '코딩 개념별 레슨 추천', '사용량 한도 내 이용 (5시간마다 자동 충전)'],
  },
  {
    code: 'pro', name: 'Pro', price_krw: 20000, badge: '가장 인기' as string | null, mult: null as string | null,
    desc: '매일 꾸준히 만들고 배우고 싶은 분께.',
    features: [
      'AI 바이브코딩 워크스페이스 (코드 자동 생성·수정·실행)',
      '코드 에디터·터미널·실시간 미리보기 IDE',
      'GitHub 연동 및 결과물 저장',
      'Pro 사용량 한도 (5시간·주간 자동 충전)',
    ],
  },
  {
    code: 'max', name: 'Max', price_krw: 100000, badge: null as string | null, mult: '5x' as string | null,
    desc: '하루 종일 몰입해서 작업하는 분께.',
    features: ['Pro의 모든 기능 포함', 'Pro 대비 5배 사용량 한도', '대규모·장시간 작업에 적합'],
  },
];

const STEPS = [
  { t: '떠올린다', d: '만들고 싶은 걸 평소 말로 이야기해요. “운동 기록 앱을 만들고 싶어.”' },
  { t: '함께 만든다', d: 'AI가 코드를 제안하고 바로 실행해, 동작하는 결과를 눈으로 확인해요.' },
  { t: '이해한다', d: '이 코드가 왜 이렇게 쓰였는지 쉬운 말로 짚어줘요. 따라 읽다 보면 감이 와요.' },
  { t: '내 것이 된다', d: '직접 고쳐 보고, 막히면 다시 물어보며 점점 스스로 할 수 있게 돼요.' },
];

const POINTS = [
  { t: '0부터 시작', d: '전공도 학원도 필요 없어요. 코딩 용어와 개념을 실제로 만드는 맥락 안에서 자연스럽게 익혀요.' },
  { t: '손에서 바로', d: '복잡한 설치나 노트북 없이, 휴대폰 앱 하나로 언제 어디서나 코딩을 시작해요.' },
  { t: '혼자서도 끝까지', d: '모르면 물어보고, 새 개념이 나오면 그 자리에서 배우니까 중간에 막혀 포기하지 않아요.' },
];

const GAP = 104; // 섹션 간 세로 여백

export default function Home() {
  const plans = PLANS;

  return (
    <div>
      {/* Hero */}
      <section style={{ padding: '88px 0 60px' }}>
        <span className="pill">입문자를 위한 모바일 코딩 교육</span>
        <h1 style={{ fontSize: 'clamp(32px, 7vw, 48px)', lineHeight: 1.12, marginTop: 20, maxWidth: 660 }}>
          만들면서 배우는 코딩
        </h1>
        <p className="muted" style={{ fontSize: 18, maxWidth: 620, lineHeight: 1.7, marginTop: 16 }}>
          AI와 대화하며 직접 앱을 만드는 ‘바이브코딩’으로 코딩을 <span style={{ color: 'var(--text2)' }}>처음부터</span> 배워요.
          노트북도, 사전 지식도 필요 없이 휴대폰 하나로 시작해요.
        </p>
      </section>

      {/* Conversation illustration */}
      <section style={{ marginTop: 8 }}>
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '22px 24px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13.5, lineHeight: 2, color: 'var(--text2)' }}>
          <div><span style={{ color: 'var(--dim)' }}>나</span>  운동 기록 앱을 만들고 싶어요.</div>
          <div style={{ marginTop: 8 }}><span style={{ color: 'var(--accent)' }}>CodingPT</span>  좋아요, 같이 만들어 봐요. 먼저 화면부터요.</div>
          <div style={{ marginTop: 2, paddingLeft: 18 }}>
            <span style={{ color: 'var(--info)' }}>const</span> App = () =&gt; <span style={{ color: 'var(--dim)' }}>{'{ … }'}</span>
            <span style={{ color: 'var(--dim)' }}>   바로 실행 → 미리보기</span>
          </div>
        </div>
      </section>

      {/* 이렇게 배워요 */}
      <section style={{ marginTop: GAP }}>
        <h2>이렇게 배워요</h2>
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

      {/* 막히면 그 자리에서 배워요 — 레슨 추천 + 배우기 탭 (핵심 차별점) */}
      <section style={{ marginTop: GAP }}>
        <span className="pill">코딩을 배우면서</span>
        <h2 style={{ marginTop: 16 }}>막히면, 그 자리에서 배워요</h2>
        <p className="muted" style={{ fontSize: 17, maxWidth: 640, lineHeight: 1.7, marginTop: 12 }}>
          만들다 보면 모르는 개념이 나오기 마련이에요. 그때 CodingPT가 그 개념에 딱 맞는 레슨을 추천해 줘요.
          탭 한 번이면 짧은 레슨으로 개념을 익히고, 멈췄던 곳으로 다시 돌아와요.
        </p>

        {/* 추천 칩 시연 */}
        <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '20px 22px', marginTop: 24, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13.5, lineHeight: 1.9, color: 'var(--text2)' }}>
          <div>const [count, setCount] = <span style={{ color: 'var(--accent)', borderBottom: '1px dashed var(--accent)' }}>useState</span>(0)</div>
          <div style={{ marginTop: 14 }}>
            <span style={{ display: 'inline-block', background: 'var(--accent-tint)', color: 'var(--accent)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 600 }}>
              이 개념 배우기 · 상태(state) →
            </span>
          </div>
        </div>

        <div className="grid cols-2" style={{ marginTop: 32 }}>
          <div>
            <div style={{ width: 24, height: 2, background: 'var(--accent)', marginBottom: 12 }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>나올 때마다 추천</div>
            <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 6 }}>
              새로운 개념이 등장하면 관련 레슨을 그 자리에서 제안해요. 만드는 흐름이 끊기지 않아요.
            </p>
          </div>
          <div>
            <div style={{ width: 24, height: 2, background: 'var(--accent)', marginBottom: 12 }} />
            <div style={{ fontWeight: 700, fontSize: 16 }}>‘배우기’ 탭에서 차근차근</div>
            <p className="muted" style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 6 }}>
              궁금한 게 있으면 ‘배우기’ 탭의 다양한 개발 클래스를 원할 때 골라서 직접 들을 수도 있어요.
            </p>
          </div>
        </div>
      </section>

      {/* 왜 입문자에게 좋을까요 */}
      <section style={{ marginTop: GAP }}>
        <h2>왜 입문자에게 좋을까요</h2>
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

      {/* 요금 / 구독 */}
      <section id="plans" style={{ marginTop: GAP, scrollMarginTop: 80 }}>
        <h2>월 구독</h2>
        <p className="muted" style={{ fontSize: 14.5, marginTop: 6 }}>
          정해진 양만큼 마음껏 사용하고, 다 쓰면 시간이 지나며 다시 채워져요. 언제든 해지할 수 있어요.
        </p>
        <div className="grid cols-3" style={{ marginTop: 28 }}>
          {(plans || []).map((p) => (
            <div key={p.code} style={{ paddingTop: 20, borderTop: `2px solid ${p.badge ? 'var(--accent)' : p.price_krw > 0 ? 'var(--accent)' : 'var(--border)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</span>
                {p.mult ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-tint)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 999, padding: '2px 8px' }}>{p.mult}</span> : null}
                {p.badge ? <span style={{ fontSize: 11, fontWeight: 700, color: '#0A0D14', background: 'var(--accent)', borderRadius: 999, padding: '2px 8px' }}>{p.badge}</span> : null}
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.03em', margin: '10px 0 2px' }}>
                {p.price_krw > 0 ? formatKRW(p.price_krw) : '무료'}
                {p.price_krw > 0 ? <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}> / 월</span> : null}
              </div>
              <p className="muted" style={{ fontSize: 13.5, marginTop: 12, lineHeight: 1.6, minHeight: 40 }}>{p.desc}</p>
              <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 8 }}>
                {p.features.map((f) => (
                  <li key={f} style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.5, color: 'var(--text2)' }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {p.price_krw > 0 ? (
                <div style={{ marginTop: 18 }}>
                  <a className="btn" href={`/login?next=${encodeURIComponent('/me?subscribe=' + p.code)}`} style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>구독하기</a>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 20, lineHeight: 1.7 }}>
          구독은 매월 자동 갱신되며, 마이페이지에서 언제든 해지할 수 있어요. 환불은 <a href="/legal/refund">환불·취소 정책</a>을 따라요.
        </p>
      </section>

      {/* 정기결제 상품 상세 안내 (결제 시 제공 서비스 명시) */}
      <section id="subscription-detail" style={{ marginTop: 56, scrollMarginTop: 80 }}>
        <h2>구독 상품 상세 안내</h2>
        <div style={{ marginTop: 24, border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '24px 26px', display: 'grid', gap: 22 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>서비스 개요</div>
            <p className="muted" style={{ fontSize: 14, lineHeight: 1.7, margin: 0 }}>
              CodingPT는 AI와 대화하며 직접 앱·웹을 만드는 ‘바이브코딩’과 코딩 학습을 제공하는 디지털 콘텐츠 구독 서비스입니다.
              구독 결제 시 아래의 디지털 서비스를 이용 기간 동안 제공받습니다.
            </p>
          </div>

          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>결제 시 제공되는 서비스</div>
            <div className="grid cols-2" style={{ gap: 18 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)', marginBottom: 6 }}>Pro · 월 ₩20,000</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                  {['AI 바이브코딩 워크스페이스 — AI 에이전트가 코드를 자동 생성·수정·실행', '클라우드 개발 환경 — 코드 에디터·터미널·실시간 미리보기(브라우저)', 'GitHub 연동 및 작업 결과물 저장', '코딩 학습 콘텐츠 및 개념별 레슨', '5시간·주간 사용량 한도 내 이용(한도 자동 충전)'].map((t) => (
                    <li key={t} style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text2)' }}><span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span><span>{t}</span></li>
                  ))}
                </ul>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)', marginBottom: 6 }}>Max · 월 ₩100,000</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                  {['Pro에서 제공되는 모든 서비스 포함', 'Pro 대비 5배 사용량 한도', '대규모·장시간 프로젝트 작업에 적합'].map((t) => (
                    <li key={t} style={{ display: 'flex', gap: 8, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text2)' }}><span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span><span>{t}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>결제 및 이용 조건</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <tbody>
                {[
                  ['상품 종류', '월 정기결제(자동결제) 방식의 디지털 콘텐츠 이용권'],
                  ['결제 주기', '매월 1회, 최초 결제일 기준 매월 같은 날 자동 갱신'],
                  ['결제 금액', 'Pro 월 20,000원 / Max 월 100,000원 (부가가치세 포함)'],
                  ['결제 수단', '신용카드·체크카드 (KG이니시스 정기결제)'],
                  ['이용 기간', '결제일로부터 다음 결제일 전일까지 (해지 전까지 매월 자동 연장)'],
                  ['해지 방법', '마이페이지 > 구독에서 즉시 해지. 해지 시 다음 결제일부터 자동결제가 중단됩니다.'],
                  ['환불', '「전자상거래 등에서의 소비자보호에 관한 법률」 및 환불·취소 정책에 따름'],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px 10px 0', color: 'var(--text3)', whiteSpace: 'nowrap', verticalAlign: 'top', fontWeight: 600, width: 110 }}>{k}</td>
                    <td style={{ padding: '10px 0', color: 'var(--text2)', lineHeight: 1.6 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.7 }}>
              자세한 내용은 <a href="/legal/terms">이용약관</a>, <a href="/legal/refund">환불·취소 정책</a>, <a href="/legal/privacy">개인정보처리방침</a>을 확인해 주세요.
            </p>
          </div>
        </div>
      </section>

      <div style={{ height: 64 }} />
    </div>
  );
}
