'use client';

import { useEffect, useRef, useState } from 'react';
import { startTerminal, buildTerminalWsUrl } from '@/lib/daemon';

// BYO 터미널(M5-웹 W3) — 사용자 러너(PC 데몬/클라우드)의 실제 PTY 를 xterm 에 브리지.
//  startTerminal(cwd)→불투명 토큰→WSS. 와이어: 바이너리=stdin(키입력), 텍스트 JSON {type:'resize',cols,rows},
//  서버→클라 = PTY 출력 raw. 로컬 에코/프롬프트 없음(셸이 직접 그림). 앱 TerminalWebView 와 동일 계약.

export default function Terminal({ cwd = '', projectName, onClose }: { cwd?: string; projectName?: string; onClose?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');

  useEffect(() => {
    let disposed = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !hostRef.current) return;
      const term = new XTerm({
        fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace', cursorBlink: true,
        theme: { background: '#0A0D14', foreground: '#CBD5E1', cursor: '#34D399' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try { fit.fit(); } catch (_) { /* noop */ }
      termRef.current = term;
      setReady(true);

      // 러너 PTY 세션 시작 → WSS 브리지. 데몬 오프라인이면 startTerminal 이 throw.
      let token: string;
      try { token = await startTerminal(cwd); }
      catch (e) {
        if (disposed) return;
        term.write(`\r\n\x1b[31m${e instanceof Error ? e.message : '터미널을 시작할 수 없어요.'}\x1b[0m\r\n`);
        setStatus('error');
        return;
      }
      if (disposed) return;
      const ws = new WebSocket(buildTerminalWsUrl(token));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      const sendResize = () => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        } catch (_) { /* noop */ }
      };

      ws.onopen = () => { if (disposed) return; setStatus('open'); sendResize(); term.focus(); };
      ws.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        if (ev.data instanceof ArrayBuffer) term.write(decoder.decode(new Uint8Array(ev.data)));
        else term.write(String(ev.data));
      };
      ws.onerror = () => { if (!disposed) setStatus('error'); };
      ws.onclose = () => { if (!disposed) { setStatus('closed'); term.write('\r\n\x1b[90m[연결 종료됨]\x1b[0m\r\n'); } };

      // 키 입력 → 바이너리 stdin. 리사이즈 → JSON.
      term.onData((d: string) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d)); } catch (_) { /* noop */ } });
      term.onResize(() => sendResize());
      const onWinResize = () => { try { fit.fit(); } catch (_) { /* noop */ } };
      window.addEventListener('resize', onWinResize);
      (term as any).__onResize = onWinResize;
    })();

    return () => {
      disposed = true;
      try { wsRef.current?.close(); } catch (_) { /* noop */ }
      wsRef.current = null;
      const term = termRef.current;
      if (term?.__onResize) window.removeEventListener('resize', term.__onResize);
      try { term?.dispose(); } catch (_) { /* noop */ }
    };
  }, [cwd]);

  const clear = () => { try { termRef.current?.clear(); } catch (_) { /* noop */ } };
  const proj = projectName || '작업영역';

  return (
    <div style={{ height: '100%', background: '#0A0D14', display: 'flex', flexDirection: 'column', position: 'relative', borderTop: '1px solid #1C2230' }}>
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, flexShrink: 0 }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, borderBottom: '2px solid #3B82F6', paddingBottom: 2 }}>터미널</span>
        <span style={{ color: '#475569', fontSize: 11, marginLeft: 10 }}>
          {status === 'open' ? `● ${proj}` : status === 'connecting' ? '연결 중…' : status === 'error' ? '연결 실패' : '연결 종료'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={clear} style={{ color: '#64748B', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', marginRight: 14 }}>지우기</button>
        {onClose ? (
          <button onClick={onClose} aria-label="닫기" style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}>
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="#64748B" strokeWidth={2} strokeLinecap="round" /></svg>
          </button>
        ) : null}
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '0 12px 8px' }} />
      {!ready ? <div style={{ position: 'absolute', top: 40, left: 12, color: '#475569', fontSize: 12 }}>터미널 준비 중…</div> : null}
    </div>
  );
}
