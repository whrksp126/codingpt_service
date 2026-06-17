'use client';

// 한도/플랜 게이트 모달 — 에이전트 응답 403(PLAN_REQUIRED) / 429·402(USAGE_LIMIT_REACHED) 시 표시.
// 사용량 한도: "업그레이드 하기 / 기다리기". 플랜 게이트: "업그레이드 하기 / 닫기".

interface LimitInfo {
  code?: string;
  reason?: string;
  message?: string;
  windowResetAt?: string | null;
  weeklyResetAt?: string | null;
}

function resetText(info: LimitInfo): string | null {
  const at = info.reason === 'weekly_exceeded' ? info.weeklyResetAt : info.windowResetAt;
  if (!at) return null;
  return new Date(at).toLocaleString('ko-KR');
}

export default function LimitModal({ info, onClose }: { info: LimitInfo | null; onClose: () => void }) {
  if (!info) return null;
  const planRequired = info.code === 'PLAN_REQUIRED';
  const reset = resetText(info);

  const title = planRequired ? '워크스페이스는 Pro부터예요' : '사용량 한도에 도달했어요';
  const body = planRequired
    ? '워크스페이스 바이브코딩은 Pro 이상 플랜에서 사용할 수 있어요. 채팅은 Free에서도 계속 쓸 수 있어요.'
    : (info.reason === 'weekly_exceeded' ? '이번 주 사용 한도를 모두 사용했어요.' : '현재 사용 구간의 한도를 모두 사용했어요.');

  const go = () => { window.location.href = '/me#plans'; };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 400, background: 'var(--elevated, #11151F)', border: '1px solid var(--border)', borderRadius: 16, padding: 24 }}>
        <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.02em' }}>{title}</div>
        <p className="muted" style={{ fontSize: 14, lineHeight: 1.6, marginTop: 10 }}>{body}</p>
        {!planRequired && reset ? (
          <p className="dim" style={{ fontSize: 13, marginTop: 8 }}>{reset}에 한도가 자동으로 초기화돼요.</p>
        ) : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button onClick={go} className="btn" style={{ flex: 1, padding: '11px 0', fontSize: 14 }}>업그레이드 하기</button>
          <button onClick={onClose} className="btn secondary" style={{ flex: 1, padding: '11px 0', fontSize: 14 }}>
            {planRequired ? '닫기' : '기다리기'}
          </button>
        </div>
      </div>
    </div>
  );
}
