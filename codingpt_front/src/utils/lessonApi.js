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
