import { backendUrl } from './common.js';

const getHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
};

const handle = async (response) => {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return response.json();
};

export const listLessons = async ({ search, page = 1, limit = 20 } = {}) => {
  const params = new URLSearchParams({ page, limit });
  if (search) params.set('search', search);
  const res = await fetch(`${backendUrl}/api/lesson?${params}`, { headers: getHeaders() });
  return handle(res);
};

export const createLesson = async ({ name, type, description } = {}) => {
  const res = await fetch(`${backendUrl}/api/lesson`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ name, type, description }),
  });
  return handle(res);
};

export const getLesson = async (id) => {
  const res = await fetch(`${backendUrl}/api/lesson/${id}`, { headers: getHeaders() });
  return handle(res);
};

export const updateLessonMeta = async (id, patch) => {
  const res = await fetch(`${backendUrl}/api/lesson/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(patch),
  });
  return handle(res);
};

export const deleteLesson = async (id) => {
  const res = await fetch(`${backendUrl}/api/lesson/${id}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  return handle(res);
};

export const addSlide = async (lessonId, { role = 'custom', insertAfter } = {}) => {
  const res = await fetch(`${backendUrl}/api/lesson/${lessonId}/slides`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ role, insertAfter }),
  });
  return handle(res);
};

export const updateSlideContents = async (lessonId, slideId, contents) => {
  const res = await fetch(`${backendUrl}/api/lesson/${lessonId}/slides/${slideId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ contents }),
  });
  return handle(res);
};

export const deleteSlide = async (lessonId, slideId) => {
  const res = await fetch(`${backendUrl}/api/lesson/${lessonId}/slides/${slideId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  return handle(res);
};

export const reorderSlides = async (lessonId, orderedSlideIds) => {
  const res = await fetch(`${backendUrl}/api/lesson/${lessonId}/slides/reorder`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ orderedSlideIds }),
  });
  return handle(res);
};

export const listCharacters = async () => {
  const res = await fetch(`${backendUrl}/api/lesson/characters`, { headers: getHeaders() });
  return handle(res);
};

export const publishLesson = async (id, published) => {
  return updateLessonMeta(id, { published_at: published ? new Date().toISOString() : null });
};

export const fetchCodeFillContent = async (slideId) => {
  const res = await fetch(`${backendUrl}/api/lesson/code-fill-gaps/${slideId}`, { headers: getHeaders() });
  return handle(res);
};

export const upsertCodeFillContent = async (slideId, content) => {
  const res = await fetch(`${backendUrl}/api/lesson/code-fill-gaps/${slideId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ content }),
  });
  return handle(res);
};

// === 코드 실행 결과 사전 캐싱 ===

// code/terminal/codeRunResult 모듈 1개 캐싱.
// 응답: { contents: <slide.contents>, module: <patched module> }
export const precomputeModuleResult = async (lessonId, slideId, moduleId, { tabIndex } = {}) => {
  const res = await fetch(
    `${backendUrl}/api/lesson/${lessonId}/slides/${slideId}/modules/${encodeURIComponent(moduleId)}/precompute`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ tabIndex }),
    },
  );
  return handle(res);
};

// codeFillTheGapV2 옵션 순열 SSE 실행. onEvent 로 진행률/완료 이벤트 수신.
// 이벤트 타입: { type:'start', total, mode }, { type:'progress', done, total },
//             { type:'done', cachedCount, contents, module }, { type:'error', message }
// resolve 값: 마지막 'done' 이벤트 payload (또는 'error' 시 reject).
export const precomputeModulePermutations = async (lessonId, slideId, moduleId, onEvent) => {
  const res = await fetch(
    `${backendUrl}/api/lesson/${lessonId}/slides/${slideId}/modules/${encodeURIComponent(moduleId)}/precompute-permutations`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({}),
    },
  );
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastDone = null;

  const processChunk = (chunk) => {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const evt = JSON.parse(json);
        if (typeof onEvent === 'function') onEvent(evt);
        if (evt.type === 'done') lastDone = evt;
        if (evt.type === 'error') throw new Error(evt.message || 'precompute error');
      } catch (e) {
        if (e instanceof Error && e.message !== 'precompute error') {
          // JSON parse 실패는 무시 (부분 청크일 수 있음)
        } else {
          throw e;
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // 마지막 청크가 \n\n 없이 끝나는 경우 (proxy/압축 등) 남은 buffer 도 단일 이벤트로 처리.
      buffer += decoder.decode();
      if (buffer.trim()) processChunk(buffer);
      buffer = '';
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processChunk(chunk);
    }
  }
  if (!lastDone) throw new Error('precompute 완료 응답을 받지 못했습니다.');
  return lastDone;
};
