import { useState, useEffect, useMemo, useRef } from 'react';
import { Play, Pause } from '@phosphor-icons/react';
import { getVoices, getModels } from '../../../../../utils/ttsApi';
import { backendUrl } from '../../../../../utils/common';

const LS_VOICE = 'tts_admin_voice_id';
const LS_MODEL = 'tts_admin_model_id';

const fmtTime = (s) => {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const buildSegments = (text, words, currentTime) => {
  if (!text || !Array.isArray(words) || words.length === 0) return null;
  const segs = [];
  let idx = 0;
  for (const w of words) {
    if (!w?.word) continue;
    const pos = text.indexOf(w.word, idx);
    if (pos === -1) continue;
    if (pos > idx) segs.push({ text: text.slice(idx, pos), hl: false });
    const active = currentTime >= (w.start ?? 0) - 0.01 && currentTime <= (w.end ?? 0) + 0.01;
    const past = currentTime > (w.end ?? 0);
    segs.push({ text: text.slice(pos, pos + w.word.length), hl: true, active, past });
    idx = pos + w.word.length;
  }
  if (idx < text.length) segs.push({ text: text.slice(idx), hl: false });
  return segs;
};

const authHeaders = () => {
  const t = localStorage.getItem('auth_token') || '';
  return { 'Content-Type': 'application/json', ...(t && { Authorization: `Bearer ${t}` }) };
};

// 미리듣기 → 확인 → 저장 루프. 저장 전엔 파일로 안 남기고, 미리듣기 음성을 재사용해 저장(추가 호출 X).
const TtsGeneratePanel = ({ defaultText = '', folder = '', onCreated, onCancel }) => {
  const [text, setText] = useState(defaultText || '');
  const [voiceId, setVoiceId] = useState(() => localStorage.getItem(LS_VOICE) || '');
  const [modelId, setModelId] = useState(() => localStorage.getItem(LS_MODEL) || '');
  const [voices, setVoices] = useState([]);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);

  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // { audioBase64, timestamps, duration, voiceId, modelId, text }

  const sampleRef = useRef(null);
  const [sampleId, setSampleId] = useState(null);
  const mainRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const usableVoices = useMemo(() => voices.filter((v) => v.category === 'premade'), [voices]);

  useEffect(() => {
    (async () => {
      try {
        const [vm, mm] = await Promise.all([getVoices(), getModels()]);
        const vlist = vm?.data?.voices || [];
        const mlist = mm?.data?.models || [];
        setVoices(vlist); setModels(mlist);
        const premade = vlist.filter((x) => x.category === 'premade');
        setVoiceId((p) => (premade.some((x) => x.voice_id === p) ? p : (premade[0]?.voice_id || '')));
        setModelId((p) => (mlist.some((x) => x.model_id === p) ? p : (mlist[0]?.model_id || 'eleven_v3')));
      } catch (e) { setError(e.message); }
    })();
  }, []);

  // 목소리 샘플(영어, 무료) 미리듣기
  const playSample = (v, e) => {
    e.stopPropagation();
    if (sampleRef.current) sampleRef.current.pause();
    if (sampleId === v.voice_id) { setSampleId(null); return; }
    if (!v.preview_url) return;
    const a = new Audio(v.preview_url);
    a.onended = () => setSampleId(null);
    sampleRef.current = a; a.play(); setSampleId(v.voice_id);
  };

  const dataUrl = preview ? `data:audio/mpeg;base64,${preview.audioBase64}` : null;
  const stale = preview && preview.text !== text.trim();
  const words = preview?.timestamps?.alignment?.words;
  const segs = useMemo(() => (preview ? buildSegments(preview.text, words, currentTime) : null), [preview, words, currentTime]);

  const handlePreview = async () => {
    setError(null);
    const trimmed = (text || '').trim();
    if (!trimmed) { setError('텍스트를 입력하세요.'); return; }
    if (!voiceId) { setError('목소리를 선택하세요.'); return; }
    setPreviewing(true);
    try {
      localStorage.setItem(LS_VOICE, voiceId);
      localStorage.setItem(LS_MODEL, modelId);
      const res = await fetch(`${backendUrl}/api/tts/assets/preview`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ text: trimmed, voiceId, modelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || '미리듣기 실패');
      setPreview(data.data);
      setCurrentTime(0); setPlaying(false);
    } catch (e) { setError(e.message); } finally { setPreviewing(false); }
  };

  const toggleMain = () => {
    const a = mainRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };

  const handleSave = async () => {
    if (!preview || stale) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${backendUrl}/api/tts/assets/save-preview`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          audioBase64: preview.audioBase64, timestamps: preview.timestamps, duration: preview.duration,
          text: preview.text, voiceId: preview.voiceId, modelId: preview.modelId, folder,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.message || '저장 실패');
      onCreated(data.data);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  return (
    <div className="p-4">
      <p className="mb-2 text-[11px] text-slate-400">저장 위치: tts/static/library/{folder || '(루트)'} · 미리듣기로 확인 후 저장됩니다</p>

      <span className="mb-1 block text-[11px] font-medium text-slate-500">텍스트</span>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
        placeholder="TTS로 변환할 텍스트"
        className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none" />

      {/* 목소리 (샘플 ▶) */}
      <div className="mt-3">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">목소리 (▶로 샘플 듣기 · 무료)</span>
        <div className="max-h-40 overflow-y-auto rounded border border-slate-200 divide-y divide-slate-100">
          {usableVoices.map((v) => {
            const sel = v.voice_id === voiceId;
            return (
              <div key={v.voice_id} onClick={() => setVoiceId(v.voice_id)}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${sel ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}>
                {v.preview_url && (
                  <button type="button" onClick={(e) => playSample(v, e)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-cyan-600 hover:text-white" title="샘플 듣기">
                    {sampleId === v.voice_id ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
                  </button>
                )}
                <span className={`flex-1 truncate ${sel ? 'font-semibold text-cyan-700' : 'text-slate-700'}`}>{v.name}</span>
                {sel && <span className="text-[11px] text-cyan-600">선택됨</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 모델 */}
      <label className="mt-3 block">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">모델</span>
        <select value={modelId} onChange={(e) => setModelId(e.target.value)}
          className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none">
          {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.name}</option>)}
        </select>
        <span className="mt-1 block text-[10px] text-slate-400">한국어는 Multilingual v2가 비교적 자연스럽습니다. 억양은 목소리 영향이 큽니다.</span>
      </label>

      {/* 미리듣기 생성 */}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={handlePreview} disabled={previewing}
          className="rounded bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300">
          {previewing ? '생성 중…' : (preview ? '다시 미리듣기' : '미리듣기 생성')}
        </button>
        <span className="text-[10px] text-slate-400">미리듣기 1회 = 크레딧 소모 / 저장은 추가 비용 없음</span>
      </div>

      {/* 미리듣기 결과 재생 + 하이라이트 */}
      {preview && (
        <div className={`mt-2 rounded-lg border p-2 ${stale ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
          <div className="flex items-center gap-2">
            <button type="button" onClick={toggleMain}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-600 text-white hover:bg-cyan-700">
              {playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            </button>
            <span className="font-mono text-xs text-slate-500">{fmtTime(currentTime)} / {fmtTime(preview.duration)}</span>
            {preview.timestamps ? <span className="text-[11px] text-cyan-600">타임스탬프 ✓</span> : <span className="text-[11px] text-amber-500">타임스탬프 없음</span>}
            <audio ref={mainRef} src={dataUrl} className="hidden"
              onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
              onEnded={() => { setPlaying(false); setCurrentTime(0); }} />
          </div>
          {segs && (
            <div className="mt-2 rounded border border-slate-200 bg-white px-2 py-1 text-sm leading-relaxed">
              {segs.map((s, i) => (
                <span key={i} className={s.hl ? (s.active ? 'rounded bg-cyan-400 text-white' : s.past ? 'text-slate-400' : 'text-slate-700') : 'text-slate-700'}>{s.text}</span>
              ))}
            </div>
          )}
          {stale && <div className="mt-1 text-[11px] text-amber-600">텍스트가 변경되었습니다. "다시 미리듣기"로 갱신 후 저장하세요.</div>}
        </div>
      )}

      {error && <div className="mt-2 text-[11px] text-red-600">{error}</div>}

      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onCancel} disabled={saving || previewing}
          className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">취소</button>
        <button onClick={handleSave} disabled={!preview || stale || saving}
          className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:bg-slate-300"
          title={!preview ? '먼저 미리듣기를 생성하세요' : (stale ? '텍스트가 변경됨 — 다시 미리듣기' : '')}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
};

export default TtsGeneratePanel;
