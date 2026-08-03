'use client';

// 레거시 한도/플랜 게이트 응답의 안전한 안내. Supporter는 기능 잠금 해제 상품이 아니므로 결제로 유도하지 않는다.

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

  const title = planRequired ? '잠시 이용할 수 없어요' : '사용량 한도에 도달했어요';
  const body = planRequired
    ? 'Personal의 핵심 원격 기능은 무료예요. 잠시 후 다시 시도해 주세요.'
    : (info.reason === 'weekly_exceeded' ? '이번 주 사용 한도를 모두 사용했어요.' : '현재 사용 구간의 한도를 모두 사용했어요.');

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
        <div style={{ marginTop: 20 }}>
          <button onClick={onClose} className="btn secondary" style={{ width: '100%', padding: '11px 0', fontSize: 14 }}>확인</button>
        </div>
      </div>
    </div>
  );
}
