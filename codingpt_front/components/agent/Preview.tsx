'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startPreview, previewUrl } from '@/lib/agent';
import type { PreviewState } from '@/lib/agentTypes';
import { BrowserIcon } from '@/components/ide/ideIcons';

// 라이브 프리뷰 — 앱 MobileIDE 브라우저 패널과 동일 크롬(탭 스트립 + 주소창 #16181D).
// /api/preview/dev/start → iframe(무인증 프록시).

export default function Preview({ wsId, reloadSignal, onClose }: { wsId: string; reloadSignal?: number; onClose?: () => void }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setState(await startPreview(wsId)); }
    catch (e) { setErr(e instanceof Error ? e.message : '프리뷰를 시작할 수 없습니다.'); }
    finally { setBusy(false); }
  }, [wsId]);

  // 패널이 열리면 1회 자동 시작(앱 openPreview 동작)
  useEffect(() => { if (!startedRef.current) { startedRef.current = true; start(); } }, [start]);

  useEffect(() => {
    if (reloadSignal && state?.mode === 'dev') setIframeKey((k) => k + 1);
  }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = state?.url ? previewUrl(state.url) : state?.token ? previewUrl(state.token) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      {/* 탭 스트립 */}
      <div style={{ display: 'flex', alignItems: 'center', background: '#0A0D14', borderBottom: '1px solid #1C2230', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, background: '#11151F', borderTop: '2px solid #3B82F6' }}>
          <BrowserIcon size={15} color="#fff" />
          <span style={{ color: '#fff', fontSize: 13 }}>미리보기</span>
          {onClose ? (
            <button onClick={onClose} aria-label="닫기" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', marginLeft: 2 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="#64748B" strokeWidth={2} strokeLinecap="round" /></svg>
            </button>
          ) : null}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ color: '#64748B', fontSize: 11, paddingRight: 12 }}>{state ? (state.mode === 'dev' ? 'dev 서버' : '정적') : ''}</span>
      </div>

      {/* 주소/컨트롤 바 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 10, paddingTop: 8, paddingBottom: 8, background: '#16181D', borderBottom: '1px solid #1C2230', flexShrink: 0 }}>
        <button onClick={() => setIframeKey((k) => k + 1)} aria-label="새로고침" style={{ padding: 4, background: 'none', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 17 }}>↻</button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#2A2F3A', borderRadius: 18, paddingLeft: 14, paddingRight: 14, height: 34 }}>
          <span style={{ flex: 1, color: '#fff', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{src || '미리보기 주소'}</span>
        </div>
        <button onClick={start} disabled={busy} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #2A2F3A', background: '#1F2430', color: '#93C5FD', fontSize: 12, cursor: 'pointer', opacity: busy ? 0.5 : 1, whiteSpace: 'nowrap' }}>
          {busy ? '시작 중…' : state ? '재시작' : '실행'}
        </button>
      </div>

      {/* 화면 */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, background: '#fff' }}>
        {src ? (
          <iframe
            key={iframeKey}
            src={src}
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, fontSize: 13.5, padding: 20, textAlign: 'center', background: '#0A0D14' }}>
            {err ? <span style={{ color: '#F87171' }}>{err}</span> : <span style={{ color: '#94A3B8' }}>{busy ? '미리보기를 준비하고 있어요…' : '‘실행’을 누르면 만든 결과를 바로 볼 수 있어요.'}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
