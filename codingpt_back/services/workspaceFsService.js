/**
 * 워크스페이스 파일시스템 헬퍼 (러너 코어 후보)
 *
 * 기존 agentService 에서 분리한 순수 FS 유틸리티. LLM/SDK 의존성 없음.
 * agent-worker 의 preview/sandbox 엔드포인트가 워크스페이스 경로를 확보하는 데 사용하며,
 * M5 클라우드 러너에서도 그대로 재사용한다.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * 사용자(+프로젝트)별 임시 워크스페이스 디렉토리 확보.
 * projectId 가 있으면 그 프로젝트 위에서 작업 → <root>/cpt-agent/<userId>/<projectId>/
 */
function workspaceDir(userId, projectId) {
  // 워커에서는 AGENT_WORKSPACE_ROOT=/workspace(호스트 가시 named volume) 사용.
  // 미설정 시 기존 동작(컨테이너 /tmp) — back 직접 실행 폴백과 하위호환.
  const root = process.env.AGENT_WORKSPACE_ROOT || os.tmpdir();
  const parts = [root, 'cpt-agent', String(userId == null ? 'anon' : userId)];
  if (projectId) parts.push(String(projectId).replace(/[^a-zA-Z0-9_-]/g, '')); // 경로 안전화
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 워크스페이스 기준 안전 상대경로(경로 탐색 차단) → 절대경로. 밖이면 null.
function resolveInWorkspace(base, relPath) {
  const safeRel = path.normalize(String(relPath || '')).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(base, safeRel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/**
 * 워크스페이스 내 파일 읽기.
 */
function readWorkspaceFile(userId, projectId, relPath) {
  const base = workspaceDir(userId, projectId);
  const full = resolveInWorkspace(base, relPath);
  if (!full) throw new Error('잘못된 경로입니다.');
  return fs.readFileSync(full, 'utf-8');
}

/**
 * 워크스페이스 내 파일 쓰기 (dev 서버/HMR 이 감지).
 */
function writeWorkspaceFile(userId, projectId, relPath, content) {
  const base = workspaceDir(userId, projectId);
  const full = resolveInWorkspace(base, relPath);
  if (!full) throw new Error('잘못된 경로입니다.');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content == null ? '' : String(content));
  return true;
}

/**
 * 워크스페이스 파일 트리 — 에디터/파일트리용. node_modules/.git 등 제외, 깊이/개수 캡.
 * 반환: [{ name, path(상대), type:'file'|'directory', children? }] (디렉토리 우선·이름순)
 */
const TREE_SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '.turbo']);
function listWorkspaceFiles(userId, projectId) {
  const base = workspaceDir(userId, projectId);
  let count = 0;
  const MAX = 2000;
  const walk = (dir, rel, depth) => {
    if (depth > 12 || count > MAX) return [];
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return []; }
    const dirs = [];
    const files = [];
    for (const ent of ents) {
      if (count > MAX) break;
      const name = ent.name;
      if (name.startsWith('.') && name !== '.env.example') {
        if (TREE_SKIP.has(name) || name === '.git') continue;
      }
      if (TREE_SKIP.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      count++;
      if (ent.isDirectory()) {
        dirs.push({ name, path: childRel, type: 'directory', children: walk(path.join(dir, name), childRel, depth + 1) });
      } else if (ent.isFile()) {
        files.push({ name, path: childRel, type: 'file' });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  };
  return walk(base, '', 0);
}

/**
 * 절대 file_path 를 워크스페이스 기준 상대경로로 변환 (밖이면 null).
 */
function toWorkspaceRelative(userId, projectId, absPath) {
  if (!absPath) return null;
  const base = workspaceDir(userId, projectId);
  const full = path.resolve(String(absPath));
  if (full === base) return '';
  if (full.startsWith(base + path.sep)) return full.slice(base.length + 1);
  return null;
}

/**
 * 워크스페이스 시드 — 전달된 파일들을 워크스페이스에 기록.
 */
function seedWorkspace(userId, projectId, files) {
  if (!Array.isArray(files)) return;
  const base = workspaceDir(userId, projectId);
  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    const full = resolveInWorkspace(base, f.path);
    if (!full) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (f.base64) {
      fs.writeFileSync(full, Buffer.from(String(f.content || ''), 'base64'));
    } else {
      fs.writeFileSync(full, String(f.content == null ? '' : f.content));
    }
  }
}

module.exports = {
  workspaceDir,
  resolveInWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceFiles,
  toWorkspaceRelative,
  seedWorkspace,
  TREE_SKIP,
};
