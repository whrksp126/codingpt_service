import { backendUrl } from './common.js';

const headers = { 'Content-Type': 'application/json' };

const handle = async (res) => {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return res.json();
};

const j = (method, path, body) => fetch(`${backendUrl}${path}`, {
  method,
  headers,
  ...(body !== undefined && { body: JSON.stringify(body) }),
}).then(handle);

// 레포 정의 CRUD (관리자)
export const listRepos = () => j('GET', '/api/admin/github-repos');
export const createRepo = (data) => j('POST', '/api/admin/github-repos', data);
export const updateRepo = (id, data) => j('PUT', `/api/admin/github-repos/${id}`, data);
export const deleteRepo = (id) => j('DELETE', `/api/admin/github-repos/${id}`);

// 직전 레슨 산출물 불러오기
export const getPreviousLessonFiles = (lessonId, repoId) =>
  j('GET', `/api/lesson/${lessonId}/github/previous-files?repoId=${repoId}`);
