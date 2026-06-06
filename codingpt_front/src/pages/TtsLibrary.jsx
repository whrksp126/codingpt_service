import React, { useState, useEffect, useCallback } from 'react';
import VoiceSelector from '../components/tts/VoiceSelector';
import ModelSelector from '../components/tts/ModelSelector';
import {
  listAssets,
  createAsset,
  updateAsset,
  deleteAsset,
} from '../utils/ttsApi';

const LS_VOICE = 'tts_lib_voice_id';
const LS_MODEL = 'tts_lib_model_id';

const fmtDuration = (d) => (d == null ? '-' : `${Number(d).toFixed(2)}s`);

function UsageBadge({ asset }) {
  if (!asset.inUse) {
    return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500">미사용</span>;
  }
  const titles = asset.usage
    .map((u) => `${u.lessonName}${u.orderNo != null ? ` (#${u.orderNo})` : ''}`)
    .join('\n');
  return (
    <span
      className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 cursor-help"
      title={titles}
    >
      사용중 {asset.usage.length}
    </span>
  );
}

// 생성/수정 공용 폼
function AssetForm({ initial, submitLabel, onSubmit, onCancel, busy }) {
  const [text, setText] = useState(initial?.text || '');
  const [voiceId, setVoiceId] = useState(initial?.voiceId || localStorage.getItem(LS_VOICE) || '');
  const [modelId, setModelId] = useState(initial?.modelId || localStorage.getItem(LS_MODEL) || '');

  const handleSubmit = () => {
    if (!text.trim()) {
      alert('텍스트를 입력하세요.');
      return;
    }
    localStorage.setItem(LS_VOICE, voiceId);
    localStorage.setItem(LS_MODEL, modelId);
    onSubmit({ text: text.trim(), voiceId, modelId });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">텍스트</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="음성으로 만들 텍스트를 입력하세요. (감정 표현은 [점점 화나면서] 형식)"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <ModelSelector selectedModelId={modelId} onModelChange={setModelId} />
      <VoiceSelector selectedVoiceId={voiceId} onVoiceChange={setVoiceId} />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? '생성 중…' : submitLabel}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 bg-gray-100 text-gray-700 text-sm rounded-md hover:bg-gray-200 disabled:opacity-50"
          >
            취소
          </button>
        )}
      </div>
    </div>
  );
}

export default function TtsLibrary() {
  const [assets, setAssets] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const res = await listAssets({ search: q, page: 1, limit: 100 });
      setAssets(res.data || []);
      setTotal(res.pagination?.total ?? (res.data || []).length);
    } catch (e) {
      alert(`목록 조회 실패: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (payload) => {
    setCreating(true);
    try {
      await createAsset(payload);
      await load(search);
    } catch (e) {
      alert(`생성 실패: ${e.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (id, payload) => {
    setBusyId(id);
    try {
      await updateAsset(id, payload);
      setEditingId(null);
      await load(search);
    } catch (e) {
      alert(`수정 실패: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (asset) => {
    if (!window.confirm(`"${asset.name || asset.text?.slice(0, 20)}" 자산을 삭제할까요?`)) return;
    setBusyId(asset.id);
    try {
      const res = await deleteAsset(asset.id, false);
      if (res.conflict) {
        const where = res.usage.map((u) => `• ${u.lessonName}${u.orderNo != null ? ` (#${u.orderNo})` : ''}`).join('\n');
        const force = window.confirm(
          `이 자산은 ${res.usage.length}곳에서 사용 중입니다:\n${where}\n\n강제 삭제하면 해당 슬라이드의 음성이 사라집니다. 계속할까요?`,
        );
        if (force) {
          await deleteAsset(asset.id, true);
          await load(search);
        }
      } else {
        await load(search);
      }
    } catch (e) {
      alert(`삭제 실패: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">TTS 자산 라이브러리</h1>
        <span className="text-sm text-gray-500">총 {total}개</span>
      </div>

      {/* 생성 폼 */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
        <h2 className="text-base font-semibold text-gray-800 mb-3">새 음성 생성</h2>
        <AssetForm submitLabel="생성" onSubmit={handleCreate} busy={creating} />
      </div>

      {/* 검색 */}
      <div className="flex items-center gap-2 mb-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(search)}
          placeholder="텍스트 검색"
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm"
        />
        <button onClick={() => load(search)} className="px-4 py-2 bg-gray-800 text-white text-sm rounded-md hover:bg-gray-900">
          검색
        </button>
      </div>

      {/* 목록 */}
      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
        {loading && <div className="p-6 text-center text-gray-400 text-sm">불러오는 중…</div>}
        {!loading && assets.length === 0 && (
          <div className="p-6 text-center text-gray-400 text-sm">자산이 없습니다. 위에서 새 음성을 생성하세요.</div>
        )}
        {!loading && assets.map((a) => (
          <div key={a.id} className="p-4">
            {editingId === a.id ? (
              <div>
                <div className="text-xs text-gray-500 mb-2">자산 #{a.id} 수정 (재생성 시 사용 중인 모든 레슨에 반영)</div>
                <AssetForm
                  initial={a}
                  submitLabel="재생성"
                  busy={busyId === a.id}
                  onSubmit={(payload) => handleUpdate(a.id, payload)}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : (
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-gray-400">#{a.id}</span>
                    <UsageBadge asset={a} />
                    <span className="text-xs text-gray-400">{fmtDuration(a.duration)}</span>
                  </div>
                  <div className="text-sm text-gray-800 truncate" title={a.text}>{a.text}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {a.modelId} · {a.voiceId || '목소리 미지정'}
                  </div>
                  {a.url && (
                    <audio controls src={a.url} className="mt-2 h-8 w-full max-w-md" preload="none" />
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => setEditingId(a.id)}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                  >
                    수정
                  </button>
                  <button
                    onClick={() => handleDelete(a)}
                    disabled={busyId === a.id}
                    className="px-3 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 disabled:opacity-50"
                  >
                    삭제
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
