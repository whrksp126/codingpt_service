'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startPreview, previewUrl } from '@/lib/agent';
import type { PreviewState } from '@/lib/agentTypes';

// 라이브 프리뷰 — /api/preview/dev/start 로 dev 서버 띄우고 iframe 으로 표시.
// 무인증 프록시(/api/preview/{token}/)라 iframe src 로 바로 로드 가능.

export default function Preview({ wsId, reloadSignal }: { wsId: string; reloadSignal?: number }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const start = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const s = await startPreview(wsId);
      setState(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '프리뷰를 시작할 수 없습니다.');
    } finally {
      setBusy(false);
    }
  }, [wsId]);

  // 에이전트 턴 종료(reloadSignal 변경) → dev 서버면 iframe 새로고침(HMR 못 잡는 변경 대비)
  useEffect(() => {
    if (reloadSignal && state?.mode === 'dev') setIframeKey((k) => k + 1);
  }, [reloadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = state?.url ? previewUrl(state.url) : state?.token ? previewUrl(state.token) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--base)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text2)' }}>미리보기</span>
        {state ? <span style={{ fontSize: 11, color: 'var(--dim)' }}>{state.mode === 'dev' ? 'dev 서버' : '정적'}</span> : null}
        <div style={{ flex: 1 }} />
        {state ? (
          <button onClick={() => setIframeKey((k) => k + 1)} style={miniBtn}>새로고침</button>
        ) : null}
        <button onClick={start} disabled={busy} style={{ ...miniBtn, opacity: busy ? 0.5 : 1 }}>
          {busy ? '시작 중…' : state ? '재시작' : '실행'}
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {src ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={src}
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: 'var(--dim)', fontSize: 13.5, padding: 20, textAlign: 'center' }}>
            {err ? <span style={{ color: 'var(--error)' }}>{err}</span> : <span>‘실행’을 누르면 만든 결과를 바로 볼 수 있어요.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, cursor: 'pointer',
};
