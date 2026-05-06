import { useState } from 'react';
import { backendUrl } from '../../../../../utils/common';
import { Field, TextField } from './SharedFields';

const getHeaders = () => {
  const token = localStorage.getItem('auth_token') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const uploadAsset = async (file) => {
  const arrayBuf = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(arrayBuf).reduce((acc, b) => acc + String.fromCharCode(b), ''),
  );
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `lesson-assets/lessons/upload-${Date.now()}-${safeName}`;
  const res = await fetch(`${backendUrl}/api/s3/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders() },
    body: JSON.stringify({ filePath: key, content: base64 }),
  });
  if (!res.ok) throw new Error('업로드 실패');
  const data = await res.json();
  const base = 'https://objectstore.ghmate.com/codingpt';
  return { url: `${base}/${data.filePath || key}`, key: data.filePath || key };
};

const AssetPickerField = ({ label, value, onChange, accept = 'image/*', hint }) => {
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState(value && value.startsWith('http') ? 'url' : 'url');
  const [error, setError] = useState(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const { url } = await uploadAsset(file);
      onChange(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setMode('url')}
          className={'rounded px-2 py-0.5 text-xs ' + (mode === 'url' ? 'bg-cyan-500 text-white' : 'bg-slate-100 text-slate-600')}
        >
          URL
        </button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={'rounded px-2 py-0.5 text-xs ' + (mode === 'upload' ? 'bg-cyan-500 text-white' : 'bg-slate-100 text-slate-600')}
        >
          업로드
        </button>
      </div>
      {mode === 'url' ? (
        <div className="mt-1">
          <TextField value={value} onChange={onChange} placeholder="https://..." />
        </div>
      ) : (
        <div className="mt-1">
          <input
            type="file"
            accept={accept}
            onChange={handleFile}
            disabled={uploading}
            className="block w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-cyan-50 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-cyan-700 hover:file:bg-cyan-100"
          />
          {uploading && <span className="ml-2 text-xs text-slate-500">업로드 중…</span>}
          {error && <span className="ml-2 text-xs text-red-500">{error}</span>}
        </div>
      )}
      {value && (
        <div className="mt-1 truncate text-[11px] text-slate-400">{value}</div>
      )}
    </Field>
  );
};

export default AssetPickerField;
