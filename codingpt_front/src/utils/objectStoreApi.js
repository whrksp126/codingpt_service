import { backendUrl } from './common.js';

export const OBJECTSTORE_BASE_URL = 'https://objectstore.ghmate.com/codingpt';
export const LESSON_ASSETS_ROOT = 'lesson-assets/';

const getHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
};

const handle = async (response) => {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    const error = new Error(data?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
};

export const keyToUrl = (displayKey) => {
  if (!displayKey) return '';
  return `${OBJECTSTORE_BASE_URL}/${displayKey}`;
};

export const urlToDisplayKey = (url) => {
  if (!url) return '';
  const prefix = `${OBJECTSTORE_BASE_URL}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : '';
};

const ACCEPT_EXT_MAP = {
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico'],
  'video/*': ['mp4', 'webm', 'mov', 'avi', 'mkv'],
  'audio/*': ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
};

export const isAcceptedFile = (filename, accept) => {
  if (!accept || accept === '*/*' || accept === '*') return true;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const parts = accept.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.some((part) => {
    if (part.startsWith('.')) return part.slice(1).toLowerCase() === ext;
    if (ACCEPT_EXT_MAP[part]) return ACCEPT_EXT_MAP[part].includes(ext);
    return false;
  });
};

export const safeName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, '_');
export const uniquify = (filename) => `${Date.now()}-${safeName(filename)}`;

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const normalizeFolderPath = (path) => {
  if (!path) return LESSON_ASSETS_ROOT;
  let p = path.replace(/^\/+/, '');
  if (!p.endsWith('/')) p += '/';
  return p;
};

export const listFolder = async (path) => {
  const folderPath = normalizeFolderPath(path);
  const params = new URLSearchParams({ path: folderPath, recursive: 'false' });
  const res = await fetch(`${backendUrl}/api/s3/files?${params}`, { headers: getHeaders() });
  const data = await handle(res);
  const tree = Array.isArray(data.files) ? data.files : [];
  return tree
    .map((node) => ({
      displayKey: (node.path || '').replace(/\/+$/, node.type === 'directory' ? '/' : ''),
      name: node.name,
      isDirectory: node.type === 'directory',
      size: node.size || 0,
      lastModified: node.lastModified || null,
    }))
    .filter((item) => item.name && item.name !== '');
};

export const uploadFile = async (file, parentPath) => {
  const parent = normalizeFolderPath(parentPath);
  const key = `${parent}${uniquify(file.name)}`;
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: key, content: base64 }),
  });
  const data = await handle(res);
  const displayKey = data.filePath || key;
  return { url: keyToUrl(displayKey), displayKey };
};

export const createFolder = async (parentPath, folderName) => {
  const parent = normalizeFolderPath(parentPath);
  const cleanName = folderName.replace(/[\/\\]/g, '').trim();
  if (!cleanName) throw new Error('폴더 이름이 비어 있습니다.');
  const folderPath = `${parent}${cleanName}/`;
  const res = await fetch(`${backendUrl}/api/s3/folder`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ folderPath }),
  });
  return handle(res);
};

export const deleteItem = async (displayKey, isDirectory) => {
  const path = isDirectory && !displayKey.endsWith('/') ? `${displayKey}/` : displayKey;
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ filePath: path }),
  });
  return handle(res);
};

export const renameItem = async (displayKey, newName, isDirectory) => {
  const cleanName = newName.replace(/[\/\\]/g, '').trim();
  if (!cleanName) throw new Error('새 이름이 비어 있습니다.');
  const oldPath = isDirectory && !displayKey.endsWith('/') ? `${displayKey}/` : displayKey;
  const res = await fetch(`${backendUrl}/api/s3/rename`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ oldPath, newName: cleanName }),
  });
  return handle(res);
};

export const listAssetUsage = async () => {
  const res = await fetch(`${backendUrl}/api/lesson/assets/usage`, { headers: getHeaders() });
  const data = await handle(res);
  return data.usages || {};
};

export const copyItem = async (sourceDisplayKey, targetParentPath, isDirectory) => {
  const sourcePath = isDirectory && !sourceDisplayKey.endsWith('/')
    ? `${sourceDisplayKey}/`
    : sourceDisplayKey;
  const baseName = isDirectory
    ? sourceDisplayKey.replace(/\/+$/, '').split('/').pop()
    : sourceDisplayKey.split('/').pop();
  const targetParent = normalizeFolderPath(targetParentPath);
  const targetPath = isDirectory ? `${targetParent}${baseName}/` : `${targetParent}${baseName}`;
  const res = await fetch(`${backendUrl}/api/s3/copy`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ sourcePath, targetPath }),
  });
  return handle(res);
};

export const updateAssetUrls = async (replacements) => {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return { updatedSlides: 0, updatedReferences: 0 };
  }
  const res = await fetch(`${backendUrl}/api/lesson/assets/update-urls`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ replacements }),
  });
  return handle(res);
};

export const moveItem = async (sourceDisplayKey, targetParentPath, isDirectory) => {
  const sourcePath = isDirectory && !sourceDisplayKey.endsWith('/')
    ? `${sourceDisplayKey}/`
    : sourceDisplayKey;
  const baseName = isDirectory
    ? sourceDisplayKey.replace(/\/+$/, '').split('/').pop()
    : sourceDisplayKey.split('/').pop();
  const targetParent = normalizeFolderPath(targetParentPath);
  const targetPath = isDirectory ? `${targetParent}${baseName}/` : `${targetParent}${baseName}`;
  const res = await fetch(`${backendUrl}/api/s3/move`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ sourcePath, targetPath }),
  });
  return handle(res);
};
