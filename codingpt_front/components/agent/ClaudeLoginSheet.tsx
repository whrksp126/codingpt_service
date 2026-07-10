'use client';

// BYO 로그인 시트(M5-웹 W5) — 러너(클라우드 컨테이너/PC)에서 사용자 본인 claude 계정 로그인.
//  앱 ClaudeLoginSheet 의 3-phase state machine 을 DOM 으로 이식(RN Modal→오버레이, InAppBrowser→window.open).
//  플로우: [시작]→데몬이 claude auth login→인증 URL→새 탭 오픈→코드 복사→붙여넣기→제출→완료.
//  크레덴셜(토큰)은 그 러너에만 안착. 앱/서버는 URL·코드만 중계(토큰 미열람).

import { useCallback, useEffect, useRef, useState } from 'react';
import { agentLoginStart, agentLoginSubmit, agentLoginCancel, type DaemonLoginStatus } from '@/lib/daemon';

type Phase = 'intro' | 'starting' | 'code' | 'submitting' | 'done' | 'error';

const C = {
  base: '#0A0D14', surface: '#11151F', border: '#1C2230', control: '#2A3344',
  text: '#F1F5F9', text2: '#CBD5E1', text3: '#64748B', accent: '#34D399', warn: '#F59E0B',
};

export default function ClaudeLoginSheet({
  visible, onClose, onLoggedIn, runnerId, targetLabel = '러너', targetKind = 'cloud',
}: {
  visible: boolean;
  onClose: () => void;
  onLoggedIn?: (status?: DaemonLoginStatus) => void;
  runnerId?: number;
  targetLabel?: string;
  targetKind?: 'cloud' | 'local';
}) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [status, setStatus] = useState<DaemonLoginStatus | null>(null);
  const aliveRef = useRef(false);

  useEffect(() => {
    if (visible) { setPhase('intro'); setUrl(''); setCode(''); setErrMsg(''); setStatus(null); aliveRef.current = true; }
    else { aliveRef.current = false; }
  }, [visible]);

  const openBrowser = useCallback((u: string) => { try { window.open(u, '_blank', 'noopener,noreferrer'); } catch (_) { /* 팝업 차단 등 — 링크 버튼으로 재시도 */ } }, []);

  const start = useCallback(async () => {
    setPhase('starting'); setErrMsg('');
    try {
      const r = await agentLoginStart({ runnerId });
      if (!aliveRef.current) return;
      setUrl(r.url); setPhase('code'); openBrowser(r.url);
    } catch (e) {
      if (!aliveRef.current) return;
      setErrMsg(e instanceof Error ? e.message : '로그인을 시작할 수 없어요.'); setPhase('error');
    }
  }, [runnerId, openBrowser]);

  const submit = useCallback(async () => {
    const c = code.trim();
    if (!c) return;
    setPhase('submitting'); setErrMsg('');
    try {
      const r = await agentLoginSubmit(c, { runnerId });
      if (!aliveRef.current) return;
      if (r.ok) { setStatus(r.status || null); setPhase('done'); onLoggedIn?.(r.status); }
      else { setErrMsg(r.message || '로그인을 완료하지 못했어요.'); setPhase('code'); }
    } catch (e) {
      if (!aliveRef.current) return;
      setErrMsg(e instanceof Error ? e.message : '코드를 제출할 수 없어요.'); setPhase('code');
    }
  }, [code, runnerId, onLoggedIn]);

  const close = useCallback(() => {
    if (phase === 'code' || phase === 'starting') agentLoginCancel({ runnerId }).catch(() => { /* noop */ });
    onClose();
  }, [phase, runnerId, onClose]);

  if (!visible) return null;

  const btn = (variant: 'accent' | 'ghost', label: string, onClick: () => void, disabled = false): React.ReactNode => (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        width: '100%', padding: '11px 14px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
        border: variant === 'ghost' ? `1px solid ${C.control}` : 'none',
        background: variant === 'ghost' ? 'transparent' : (disabled ? '#1E3A32' : C.accent),
        color: variant === 'ghost' ? C.text2 : (disabled ? '#5B7A6E' : '#052e16'),
      }}
    >{label}</button>
  );

  return (
    <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, border: `1px solid ${C.border}`, paddingBottom: 20, maxHeight: '86%', overflowY: 'auto' }}>
        {/* 헤더 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 18px 6px' }}>
          <span style={{ color: C.accent, fontSize: 18 }}>➜</span>
          <span style={{ color: C.text, fontSize: 17, fontWeight: 800 }}>Claude 로그인</span>
          <span style={{ marginLeft: 4, background: '#1A2130', borderRadius: 999, padding: '3px 9px', color: C.text3, fontSize: 11.5, fontWeight: 700 }}>
            {targetKind === 'cloud' ? '☁ ' : '💻 '}{targetLabel}
          </span>
        </div>

        {phase === 'intro' && (
          <div style={{ padding: '6px 18px 0' }}>
            <p style={{ color: C.text3, fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>
              {targetLabel === '러너' ? '이 러너' : targetLabel}에서 <b style={{ color: C.text2 }}>본인 Claude 계정</b>으로 로그인해요.
              로그인 자격증명은 {targetKind === 'cloud' ? '이 클라우드 컨테이너' : '이 PC'} 안에만 저장되고, 서버는 인증 링크와 코드만 전달해요.
            </p>
            <div style={{ background: C.base, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginTop: 12 }}>
              <Step n={1} text="아래 [로그인 시작] → 새 탭이 열려요." />
              <Step n={2} text="Claude 계정으로 인증하면 코드가 표시돼요." />
              <Step n={3} text="그 코드를 복사해 여기 붙여넣고 완료." />
            </div>
            <div style={{ marginTop: 16 }}>{btn('accent', '로그인 시작', start)}</div>
          </div>
        )}

        {(phase === 'starting' || phase === 'submitting') && (
          <div style={{ padding: '34px 18px', textAlign: 'center', color: C.text3, fontSize: 13 }}>
            {phase === 'starting' ? '인증 링크를 준비하는 중…' : '로그인을 확인하는 중…'}
          </div>
        )}

        {phase === 'code' && (
          <div style={{ padding: '6px 18px 0' }}>
            <p style={{ color: C.text3, fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>
              새 탭에서 로그인한 뒤 표시된 <b style={{ color: C.text2 }}>인증 코드</b>를 복사해 아래에 붙여넣으세요.
            </p>
            <button onClick={() => openBrowser(url)} style={{ width: '100%', marginTop: 12, padding: '10px', borderRadius: 8, border: `1px solid ${C.control}`, background: '#1A2130', color: C.text2, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              ↗ 로그인 페이지 다시 열기
            </button>
            <textarea
              value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="인증 코드 붙여넣기" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              style={{ width: '100%', marginTop: 12, minHeight: 46, boxSizing: 'border-box', background: C.base, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', color: C.text, fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical' }}
            />
            {!!errMsg && <div style={{ color: C.warn, fontSize: 12.5, marginTop: 10 }}>⚠ {errMsg}</div>}
            <div style={{ marginTop: 16 }}>{btn('accent', '완료', submit, !code.trim())}</div>
          </div>
        )}

        {phase === 'done' && (
          <div style={{ padding: '6px 18px 0' }}>
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <div style={{ color: C.accent, fontSize: 40 }}>✓</div>
              <div style={{ color: C.text, fontSize: 15, fontWeight: 800, marginTop: 6 }}>로그인 완료</div>
              {!!status?.email && <div style={{ color: C.text3, fontSize: 13, marginTop: 4 }}>{status.email}{status.subscriptionType ? ` · ${status.subscriptionType}` : ''}</div>}
            </div>
            <div style={{ marginTop: 8 }}>{btn('accent', '확인', onClose)}</div>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ padding: '6px 18px 0' }}>
            <div style={{ background: C.base, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, color: C.text2, fontSize: 13, lineHeight: 1.45 }}>⚠ {errMsg}</div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>{btn('ghost', '닫기', close)}</div>
              <div style={{ flex: 1 }}>{btn('accent', '다시 시도', start)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0' }}>
      <span style={{ width: 20, height: 20, borderRadius: 999, background: '#34D399', color: '#052e16', fontSize: 11.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</span>
      <span style={{ color: '#64748B', fontSize: 13 }}>{text}</span>
    </div>
  );
}
