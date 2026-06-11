import { useState, useEffect, useMemo, useRef } from 'react';
import { Play, Pause } from '@phosphor-icons/react';
import { getVoices, getModels } from '../../../../../utils/ttsApi';
import { backendUrl } from '../../../../../utils/common';

const LS_VOICE = 'tts_admin_voice_id';
const LS_MODEL = 'tts_admin_model_id';
const LS_STYLE = 'tts_admin_style';

// 컨텍스트별 스타일 프리셋(자연어). 고르면 스타일 입력칸이 채워짐 — 같은 톤으로 일관 생성 + 재롤 최소화.
const STYLE_PRESETS = [
  { label: '제목/목차', value: '선생님이 학습 목차를 차분하고 또렷하게 읽어주는 느낌' },
  { label: '개념 설명', value: '친절하게 개념을 차근차근 설명하는 선생님 톤' },
  { label: '격려/응원', value: '친근하고 따뜻하게 응원하는 톤' },
  { label: '예시 안내', value: '예시를 가볍고 명확하게 안내하는 톤' },
  { label: '주의/강조', value: '중요한 부분을 또박또박 강조해서 알려주는 톤' },
];

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
const TtsGeneratePanel = ({ defaultText = '', folder = '', onCreated, onCancel, suggestedVoiceId = '' }) => {
  const [text, setText] = useState(defaultText || '');
  // 모듈 맥락이 추천한 보이스(suggestedVoiceId)를 최우선 초기값으로 — 없으면 마지막 사용값.
  const [voiceId, setVoiceId] = useState(() => suggestedVoiceId || localStorage.getItem(LS_VOICE) || '');
  const [modelId, setModelId] = useState(() => localStorage.getItem(LS_MODEL) || '');
  const [styleInstructions, setStyleInstructions] = useState(() => localStorage.getItem(LS_STYLE) || '');
  const [voices, setVoices] = useState([]);
  const [models, setModels] = useState([]);
  const [error, setError] = useState(null);

  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // { audioBase64, timestamps, duration, voiceId, modelId, text }

  const sampleRef = useRef(null);
  const [sampleId, setSampleId] = useState(null);
  const [sampleLoading, setSampleLoading] = useState(null); // 생성 중인 voiceId
  const sampleUrlCache = useRef({}); // voiceId -> url (재요청 방지)
  const mainRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const usableVoices = useMemo(() => voices, [voices]);

  useEffect(() => {
    (async () => {
      try {
        const [vm, mm] = await Promise.all([getVoices(), getModels()]);
        const vlist = vm?.data?.voices || [];
        const mlist = mm?.data?.models || [];
        setVoices(vlist); setModels(mlist);
        setVoiceId((p) => (vlist.some((x) => x.voice_id === p) ? p : (vlist[0]?.voice_id || '')));
        setModelId((p) => (mlist.some((x) => x.model_id === p) ? p : (mlist[0]?.model_id || 'gemini-3.1-flash-tts-preview')));
      } catch (e) { setError(e.message); }
    })();
  }, []);

  // 목소리 샘플 미리듣기 — 없으면 백엔드가 1회 생성+캐시 후 URL 반환(lazy)
  const playSample = async (v, e) => {
    e.stopPropagation();
    if (sampleRef.current) { sampleRef.current.pause(); sampleRef.current = null; }
    if (sampleId === v.voice_id) { setSampleId(null); return; } // 재생 중이면 정지(토글)
    setSampleLoading(v.voice_id);
    setError(null);
    try {
      let url = sampleUrlCache.current[v.voice_id];
      if (!url) {
        // 캐시 없는 보이스는 백엔드가 즉석 생성 → Gemini rate limit/지연으로 엣지가 502를
        // 떨굴 수 있음(이때 CORS 헤더 없이 실패). 백엔드는 타임아웃 뒤에도 생성을 끝내 캐시에
        // 남기므로, 1회 짧게 대기 후 재시도하면 두 번째엔 캐시 히트로 성공한다.
        const fetchSample = async () => {
          const res = await fetch(`${backendUrl}/api/tts/voices/${encodeURIComponent(v.voice_id)}/sample`, { headers: authHeaders() });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.success) throw new Error(data.message || '샘플 생성 실패');
          return data.data.url;
        };
        try {
          url = await fetchSample();
        } catch (e) {
          await new Promise((r) => setTimeout(r, 1500));
          url = await fetchSample();
        }
        sampleUrlCache.current[v.voice_id] = url;
      }
      const a = new Audio(url);
      a.onended = () => setSampleId(null);
      sampleRef.current = a;
      await a.play();
      setSampleId(v.voice_id);
    } catch (err) {
      setError(`샘플 재생 실패: ${err.message}`);
    } finally {
      setSampleLoading(null);
    }
  };

  const dataUrl = preview ? `data:audio/mpeg;base64,${preview.audioBase64}` : null;
  // 텍스트/목소리/모델/스타일 중 하나라도 바뀌면 stale → 다시 미리듣기 후 저장하도록.
  const stale = preview && (
    preview.text !== text.trim()
    || preview.voiceId !== voiceId
    || preview.modelId !== modelId
    || (preview.settings?.styleInstructions || '').trim() !== styleInstructions.trim()
  );
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
      localStorage.setItem(LS_STYLE, styleInstructions || '');
      const settings = styleInstructions.trim() ? { styleInstructions: styleInstructions.trim() } : {};
      const res = await fetch(`${backendUrl}/api/tts/assets/preview`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ text: trimmed, voiceId, modelId, settings }),
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
          text: preview.text, voiceId: preview.voiceId, modelId: preview.modelId, settings: preview.settings || null, folder,
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

      {/* 목소리 */}
      <div className="mt-3">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">목소리 (▶로 샘플 듣기 · 첫 재생 시 잠깐 생성)</span>
        <div className="max-h-40 overflow-y-auto rounded border border-slate-200 divide-y divide-slate-100">
          {usableVoices.map((v) => {
            const sel = v.voice_id === voiceId;
            return (
              <div key={v.voice_id} onClick={() => setVoiceId(v.voice_id)}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${sel ? 'bg-cyan-50' : 'hover:bg-slate-50'}`}>
                {(
                  <button type="button" onClick={(e) => playSample(v, e)} disabled={sampleLoading === v.voice_id}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-cyan-600 hover:text-white disabled:opacity-50" title="샘플 듣기">
                    {sampleLoading === v.voice_id ? <span className="text-[9px]">…</span> : (sampleId === v.voice_id ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />)}
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
        <span className="mt-1 block text-[10px] text-slate-400">Gemini TTS. 톤·감정은 아래 "스타일 지시"로 제어합니다.</span>
      </label>

      {/* 스타일 지시 (프리셋 + 자유 입력) */}
      <div className="mt-3">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">스타일 지시 (말투·감정·상황)</span>
        <select
          value=""
          onChange={(e) => { if (e.target.value) setStyleInstructions(e.target.value); }}
          className="mb-1 w-full rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-600 focus:border-cyan-500 focus:outline-none">
          <option value="">프리셋 선택…</option>
          {STYLE_PRESETS.map((p) => <option key={p.label} value={p.value}>{p.label} — {p.value}</option>)}
        </select>
        <textarea value={styleInstructions} onChange={(e) => setStyleInstructions(e.target.value)} rows={2}
          placeholder='예: 선생님이 학습 목차를 차분히 읽어주는 느낌 (비우면 기본 톤)'
          className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none" />
        <span className="mt-1 block text-[10px] text-slate-400">같은 스타일을 고정하면 원하는 결과가 한 번에 나와 재생성 비용을 줄일 수 있어요.</span>
      </div>

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
