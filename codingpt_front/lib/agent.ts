'use client';

// 바이브코딩 웹 — IDE 파일/프리뷰 데이터층(M5-웹 W6). M0 제거된 /api/agent/* 대신 데몬 릴레이(lib/daemon)로 위임.
//  컴포넌트(FileTree/Editor/Preview) 시그니처는 유지하되, 내부 전송을 BYO 데몬 fs/preview 로 재배선.
//  에이전트 스트리밍(streamAgentQuery)·권한(resolveAgentPermission)·exec(streamExec) 은 W2/W3/W5 로 이관돼 제거됨.
//  경로 규약: projectId 인자 = 러너(데몬) 홈-기준 루트(핸드오프 cwd). 트리/읽기/쓰기 경로를 이 루트 기준으로 해석.

import {
  fsTree, fsRead, fsWrite, previewPorts, previewStart, buildDaemonPreviewUrl,
} from './daemon';
import { BACKEND_PUBLIC } from './api';
import type { PreviewState, FileNode } from './agentTypes';

const clean = (s: string) => (s || '').replace(/^\/+|\/+$/g, '');
// 러너 홈-기준 절대상대경로 = 루트(핸드오프 cwd) + 프로젝트-상대 경로.
function joinRoot(root: string | undefined, rel: string): string {
  const r = clean(root || '');
  const p = clean(rel);
  return r ? `${r}/${p}` : p;
}

// flat {path,text}[] (루트 기준 상대, '/' 구분) → 중첩 FileNode[]. fsTree 는 파일만 주므로 디렉토리는 경로에서 유추.
function buildTree(items: { path: string; text?: boolean }[]): FileNode[] {
  const root: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();
  for (const it of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = clean(it.path).split('/').filter(Boolean);
    let level = root;
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      prefix = prefix ? `${prefix}/${name}` : name;
      if (i === parts.length - 1) {
        level.push({ name, path: prefix, type: 'file' });
      } else {
        let dir = dirMap.get(prefix);
        if (!dir) { dir = { name, path: prefix, type: 'directory', children: [] }; dirMap.set(prefix, dir); level.push(dir); }
        level = dir.children!;
      }
    }
  }
  return root;
}

/** 워크스페이스 파일 트리(IDE 파일트리) — 러너 fs.tree 를 중첩 FileNode 로. */
export const listAgentFiles = async (projectId: string): Promise<FileNode[]> => {
  const t = await fsTree(projectId).catch(() => ({ root: '', items: [] as { path: string; text: boolean }[] }));
  return buildTree(t.items || []);
};

/** 워크스페이스 파일 읽기(에디터 동기화). */
export const getAgentFile = async (relPath: string, projectId?: string): Promise<{ path: string; content: string }> => {
  const r = await fsRead(joinRoot(projectId, relPath));
  return { path: relPath, content: r.content ?? '' };
};

/** 워크스페이스 파일 쓰기(에디터 편집 → 러너 FS → HMR). */
export const writeAgentFile = async (relPath: string, content: string, projectId?: string): Promise<{ success: boolean; path: string }> => {
  const r = await fsWrite(joinRoot(projectId, relPath), content);
  return { success: true, path: r.path };
};

/** dev 서버 기동 명령인지(미리보기로 라우팅). */
export const isDevServerCommand = (raw: string): boolean =>
  /(^|\s|&&|;)(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(raw)
  || /(^|\s|&&|;)(vite|next\s+dev|react-scripts\s+start)\b/.test(raw);

// ── 프리뷰(러너 dev 서버) ─────────────────────────────────────
// BYO 프리뷰는 러너에서 LISTEN 중인 포트를 감지해 그 포트로 프록시 토큰을 발급한다(포트 기반).
/** dev 서버 미리보기 시작 → PreviewState. 감지된 포트가 없으면 static 폴백. */
export const startPreview = async (_projectId: string): Promise<PreviewState> => {
  const ports = await previewPorts().catch(() => [] as number[]);
  if (!ports.length) return { mode: 'static' };
  const port = ports[0]; // 첫 LISTEN 포트(대개 dev 서버). 다중 포트 선택 UI 는 후속.
  try {
    const p = await previewStart(port);
    return { mode: 'dev', ready: true, token: p.token, url: p.url };
  } catch (_) {
    return { mode: 'static' };
  }
};

/** 프리뷰 토큰/경로 → 브라우저가 로드할 절대 URL. */
export const previewUrl = (relUrlOrToken: string): string => {
  if (relUrlOrToken.startsWith('http')) return relUrlOrToken;
  if (relUrlOrToken.startsWith('/')) return `${BACKEND_PUBLIC}${relUrlOrToken}`;
  return buildDaemonPreviewUrl(relUrlOrToken); // 토큰 → /api/daemon/preview/<token>/
};
