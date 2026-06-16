'use client';

import { useEffect, useRef, useState } from 'react';
import { streamExec } from '@/lib/agent';
import type { ExecEvent } from '@/lib/agentTypes';

// 샌드박스 터미널 — xterm + POST /api/agent/exec(SSE). 앱 MobileIDE 터미널 프롬프트 색상과 동일.

const BACKSPACE = '\x7f';
const CTRL_C = '\x03';
// 앱과 동일 truecolor: user@CodingPT(민트) :(dim) ~/proj(블루) $(민트)
const MINT = '\x1b[38;2;52;211;153m';
const DIM = '\x1b[38;2;100;116;139m';
const BLUE = '\x1b[38;2;96;165;250m';
const RST = '\x1b[0m';

export default function Terminal({ wsId, projectName, onClose }: { wsId: string; projectName?: string; onClose?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const cmdRef = useRef('');
  const cwdRef = useRef('');
  const abortRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const [ready, setReady] = useState(false);
  const proj = projectName || '작업영역';

  useEffect(() => {
    let disposed = false;
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
      writePrompt(term);

      term.onData((d: string) => onData(d));
      const onResize = () => { try { fit.fit(); } catch (_) { /* noop */ } };
      window.addEventListener('resize', onResize);
      (term as any).__onResize = onResize;
    })();
    return () => {
      disposed = true;
      try { abortRef.current?.(); } catch (_) { /* noop */ }
      const term = termRef.current;
      if (term?.__onResize) window.removeEventListener('resize', term.__onResize);
      try { term?.dispose(); } catch (_) { /* noop */ }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cwdDisp = () => {
    const c = cwdRef.current;
    if (!c) return `~/${proj}`;
    const m = `/${wsId}`;
    const i = c.indexOf(m);
    return `~/${proj}${i >= 0 ? c.slice(i + m.length) : ''}`;
  };

  const writePrompt = (term: any) => {
    term.write(`\r\n${MINT}user@CodingPT${RST}${DIM}:${RST}${BLUE}${cwdDisp()}${RST}${MINT}$ ${RST}`);
  };

  const run = (command: string) => {
    const term = termRef.current;
    if (!term || runningRef.current) return;
    if (!command.trim()) { writePrompt(term); return; }
    runningRef.current = true;
    term.write('\r\n');
    abortRef.current = streamExec(
      { command, cwd: cwdRef.current || undefined, projectId: wsId },
      {
        onEvent: (e: ExecEvent) => {
          if (e.type === 'output') term.write(e.data.replace(/\n/g, '\r\n'));
          else if (e.type === 'cwd') cwdRef.current = e.cwd;
          else if (e.type === 'start') cwdRef.current = e.cwd || cwdRef.current;
          else if (e.type === 'error') term.write(`\r\n\x1b[31m${e.message}\x1b[0m`);
        },
        onComplete: () => { runningRef.current = false; writePrompt(term); },
        onError: (m) => { runningRef.current = false; term.write(`\r\n\x1b[31m${m}\x1b[0m`); writePrompt(term); },
      },
    );
  };

  const onData = (d: string) => {
    const term = termRef.current;
    if (!term) return;
    if (d === CTRL_C) {
      try { abortRef.current?.(); } catch (_) { /* noop */ }
      runningRef.current = false; cmdRef.current = ''; term.write('^C'); writePrompt(term); return;
    }
    if (runningRef.current) return;
    if (d === '\r') { const c = cmdRef.current; cmdRef.current = ''; run(c); return; }
    if (d === BACKSPACE || d === '\b') {
      if (cmdRef.current.length > 0) { cmdRef.current = cmdRef.current.slice(0, -1); term.write('\b \b'); }
      return;
    }
    if (d >= ' ') { cmdRef.current += d; term.write(d); }
  };

  const clear = () => { try { termRef.current?.clear(); } catch (_) { /* noop */ } };

  return (
    <div style={{ height: '100%', background: '#0A0D14', display: 'flex', flexDirection: 'column', position: 'relative', borderTop: '1px solid #1C2230' }}>
      {/* 터미널 패널 헤더 — 앱 하단 패널 탭 스타일 */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, flexShrink: 0 }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, borderBottom: '2px solid #3B82F6', paddingBottom: 2 }}>터미널</span>
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
