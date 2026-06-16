'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { captureHandoff, getToken } from '@/lib/auth';
import { listWorkspaces, createWorkspace } from '@/lib/workspaces';
import type { WorkspaceMeta } from '@/lib/agentTypes';

// 바이브코딩 워크스페이스 목록 + 새로 만들기. 로그인 필요.

export default function AppHome() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [authed, setAuthed] = useState(false);

  const load = useCallback(async () => {
    try { setWorkspaces(await listWorkspaces()); }
    catch { setWorkspaces([]); }
  }, []);

  useEffect(() => {
    captureHandoff();
    if (!getToken()) { router.replace('/login?next=/workspace'); return; }
    setAuthed(true);
    load();
  }, [router, load]);

  const onCreate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const ws = await createWorkspace({ name: '새 프로젝트', kind: 'project' });
      router.push(`/workspace/${ws.id}`);
    } catch {
      setCreating(false);
    }
  };

  if (!authed) return null;
  const projects = (workspaces || []).filter((w) => w.kind !== 'chat');

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px 64px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>내 프로젝트</h1>
          <p className="muted" style={{ fontSize: 14.5, marginTop: 6 }}>AI와 대화하며 만든 프로젝트를 여기서 이어가요.</p>
        </div>
        <button onClick={onCreate} disabled={creating} style={{ padding: '11px 18px', borderRadius: 12, border: 'none', background: 'var(--cta)', color: 'var(--on-accent)', fontWeight: 700, fontSize: 14.5, cursor: 'pointer', opacity: creating ? 0.6 : 1 }}>
          {creating ? '만드는 중…' : '+ 새 프로젝트'}
        </button>
      </div>

      <div style={{ marginTop: 28 }}>
        {workspaces === null ? (
          <div className="muted" style={{ fontSize: 14, padding: '40px 0', textAlign: 'center' }}>불러오는 중…</div>
        ) : projects.length === 0 ? (
          <div style={{ border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', padding: '48px 24px', textAlign: 'center', color: 'var(--dim)' }}>
            <div style={{ fontSize: 15, color: 'var(--text2)' }}>아직 프로젝트가 없어요.</div>
            <div style={{ fontSize: 13.5, marginTop: 6 }}>‘새 프로젝트’를 눌러 첫 앱을 만들어 보세요.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
            {projects.map((w) => (
              <button
                key={w.id}
                onClick={() => router.push(`/workspace/${w.id}`)}
                style={{ textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 110 }}
              >
                <div style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--text)' }}>{w.name}</div>
                {w.description ? <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, flex: 1 }}>{w.description.slice(0, 90)}</div> : <div style={{ flex: 1 }} />}
                {w.stack?.length ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {w.stack.slice(0, 3).map((s) => (
                      <span key={s} style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--accent-tint)', borderRadius: 6, padding: '2px 7px' }}>{s}</span>
                    ))}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
