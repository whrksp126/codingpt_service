'use client';

import { useEffect, useRef, useState } from 'react';
import { streamExec } from '@/lib/agent';
import type { ExecEvent } from '@/lib/agentTypes';

// 샌드박스 터미널 — xterm + POST /api/agent/exec(SSE). 명령 입력→출력 스트리밍.

const BACKSPACE = '\x7f';
const CTRL_C = '\x03';

export default function Terminal({ wsId }: { wsId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const cmdRef = useRef('');
  const cwdRef = useRef('');
  const abortRef = useRef<(() => void) | null>(null);
  const runningRef = useRef(false);
  const [ready, setReady] = useState(false);

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
        theme: { background: '#0A0D14', foreground: '#E5E9F0', cursor: '#34D399' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try { fit.fit(); } catch (_) { /* noop */ }
      termRef.current = term;
      setReady(true);
      term.writeln('\x1b[2m샌드박스 터미널 — 명령을 입력하고 Enter. (예: ls, npm run dev)\x1b[0m');
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

  const writePrompt = (term: any) => {
    const c = cwdRef.current ? cwdRef.current.split('/').pop() : '~';
    term.write(`\r\n\x1b[32m${c}\x1b[0m $ `);
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

  return (
    <div style={{ height: '100%', background: '#0A0D14', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text2)', flexShrink: 0 }}>터미널</div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: 8 }} />
      {!ready ? <div style={{ position: 'absolute', top: 36, left: 12, color: 'var(--dim)', fontSize: 12 }}>터미널 준비 중…</div> : null}
    </div>
  );
}
