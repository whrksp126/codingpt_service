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

export const getTree = () => j('GET', '/api/admin/tree');

// Product (uses existing /api/products endpoints)
export const createProduct = (data) => j('POST', '/api/products', data);
export const updateProduct = (id, data) => j('PUT', `/api/products/${id}`, data);
export const deleteProduct = (id) => j('DELETE', `/api/products/${id}`);

// Class (uses existing /api/classes endpoints)
export const createClass = (data) => j('POST', '/api/classes', data);
export const updateClass = (id, data) => j('PUT', `/api/classes/${id}`, data);
export const deleteClass = (id) => j('DELETE', `/api/classes/${id}`);

// Section (new admin endpoints)
export const createSection = (data) => j('POST', '/api/admin/sections', data);
export const updateSection = (id, data) => j('PUT', `/api/admin/sections/${id}`, data);
export const deleteSection = (id) => j('DELETE', `/api/admin/sections/${id}`);

// Mappings
export const linkProductClass = (productId, classId) =>
  j('POST', `/api/admin/products/${productId}/classes/${classId}`);
export const unlinkProductClass = (productId, classId) =>
  j('DELETE', `/api/admin/products/${productId}/classes/${classId}`);
export const linkClassSection = (classId, sectionId) =>
  j('POST', `/api/admin/classes/${classId}/sections/${sectionId}`);
export const unlinkClassSection = (classId, sectionId) =>
  j('DELETE', `/api/admin/classes/${classId}/sections/${sectionId}`);
export const linkSectionLesson = (sectionId, lessonId) =>
  j('POST', `/api/admin/sections/${sectionId}/lessons/${lessonId}`);
export const unlinkSectionLesson = (sectionId, lessonId) =>
  j('DELETE', `/api/admin/sections/${sectionId}/lessons/${lessonId}`);

// Reorder
export const reorderClassesInProduct = (productId, orderedClassIds) =>
  j('POST', `/api/admin/products/${productId}/classes/reorder`, { orderedClassIds });
export const reorderSectionsInClass = (classId, orderedSectionIds) =>
  j('POST', `/api/admin/classes/${classId}/sections/reorder`, { orderedSectionIds });
export const reorderLessonsInSection = (sectionId, orderedLessonIds) =>
  j('POST', `/api/admin/sections/${sectionId}/lessons/reorder`, { orderedLessonIds });
