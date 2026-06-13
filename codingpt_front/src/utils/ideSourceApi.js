import { backendUrl } from './common.js';

// 모바일 IDE 프로젝트 소스 — objectstore `codingpt/execute/ide/<projectId>/` 를 다루는 헬퍼.
// 관리자 모달(MobileIdePanel)에서 사용. 모든 경로는 projectId 기준 상대경로로 주고받는다.

const getHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
};

const handle = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const error = new Error(data?.message || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
};

const baseDir = (projectId) => `ide/${projectId}`;
const fullPrefix = (projectId) => `codingpt/execute/ide/${projectId}/`;
const keyOf = (projectId, relPath) => `${baseDir(projectId)}/${String(relPath).replace(/^\/+/, '')}`;

const TEXT_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'xml', 'svg',
  'py', 'java', 'ts', 'tsx', 'jsx', 'c', 'cpp', 'h', 'hpp', 'sql', 'yml', 'yaml',
]);
export const isTextPath = (p) => TEXT_EXTS.has((String(p).split('.').pop() || '').toLowerCase());

// 프로젝트 전체 파일(상대경로) 목록 — 재귀. 디렉토리는 buildTree 가 경로에서 유도하므로 파일만 반환.
export const listProject = async (projectId) => {
  const params = new URLSearchParams({ path: baseDir(projectId), recursive: 'true' });
  const res = await fetch(`${backendUrl}/api/s3/files?${params}`, { headers: getHeaders() });
  const data = await handle(res);
  const prefix = fullPrefix(projectId);
  const files = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'directory') { walk(n.files); continue; }
      const full = n.path || '';
      const rel = full.startsWith(prefix) ? full.slice(prefix.length) : n.name;
      if (rel) files.push({ path: rel, size: n.size || 0 });
    }
  };
  walk(Array.isArray(data.files) ? data.files : []);
  return files;
};

// 텍스트 파일 내용 조회
export const getContent = async (projectId, relPath) => {
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: keyOf(projectId, relPath) }),
  });
  const data = await handle(res);
  let content = data.content || '';
  if (data.encoding === 'base64') {
    try { content = decodeURIComponent(escape(atob(content))); } catch (_) { content = atob(content); }
  }
  return content;
};

// 텍스트 파일 저장/생성
export const saveText = async (projectId, relPath, content) => {
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: keyOf(projectId, relPath), content: content ?? '' }),
  });
  return handle(res);
};

// 파일/폴더 삭제
export const deletePath = async (projectId, relPath, isDir) => {
  const rel = String(relPath).replace(/^\/+/, '');
  const filePath = isDir ? `${keyOf(projectId, rel)}/` : keyOf(projectId, rel);
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ filePath }),
  });
  return handle(res);
};

// 폴더 생성
export const createFolder = async (projectId, relPath) => {
  const res = await fetch(`${backendUrl}/api/s3/folder`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ folderPath: `${keyOf(projectId, relPath)}/` }),
  });
  return handle(res);
};

// 파일/폴더 이동 (다른 폴더로) — targetDir 은 projectId 기준 상대경로('' = 루트)
export const movePath = async (projectId, relPath, targetDir, isDir) => {
  const rel = String(relPath).replace(/^\/+/, '');
  const sourcePath = isDir ? `${keyOf(projectId, rel)}/` : keyOf(projectId, rel);
  const td = String(targetDir || '').replace(/^\/+|\/+$/g, '');
  const targetPath = td ? `${keyOf(projectId, td)}/` : `${baseDir(projectId)}/`;
  const res = await fetch(`${backendUrl}/api/s3/move`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ sourcePath, targetPath }),
  });
  return handle(res);
};

// 파일 복제 (같은 폴더에 복사본 생성)
export const copyFile = async (projectId, relPath, newRelPath) => {
  const res = await fetch(`${backendUrl}/api/s3/copy`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ sourcePath: keyOf(projectId, relPath), targetPath: keyOf(projectId, newRelPath) }),
  });
  return handle(res);
};

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};
// 이미지 등 바이너리를 data URL 로 — execute/ide 는 비공개 prefix 라 공개 URL 불가, <img src> 용
export const getBinaryDataUrl = async (projectId, relPath) => {
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: keyOf(projectId, relPath) }),
  });
  const data = await handle(res);
  const ext = (String(relPath).split('.').pop() || '').toLowerCase();
  const mime = EXT_MIME[ext] || data.contentType || 'application/octet-stream';
  const base64 = data.encoding === 'base64'
    ? data.content
    : btoa(unescape(encodeURIComponent(data.content || '')));
  return `data:${mime};base64,${base64}`;
};

// 이름 변경 (파일/폴더)
export const renamePath = async (projectId, relPath, newName, isDir) => {
  const rel = String(relPath).replace(/^\/+/, '');
  const oldPath = isDir ? `${keyOf(projectId, rel)}/` : keyOf(projectId, rel);
  const res = await fetch(`${backendUrl}/api/s3/rename`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ oldPath, newName }),
  });
  return handle(res);
};

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

// 바이너리(이미지 등) 업로드
export const uploadBinary = async (projectId, relParentPath, file, fileName) => {
  const parent = String(relParentPath || '').replace(/^\/+|\/+$/g, '');
  const name = fileName || file.name;
  const rel = parent ? `${parent}/${name}` : name;
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: keyOf(projectId, rel), content: base64, originalName: file.name }),
  });
  return handle(res);
};
