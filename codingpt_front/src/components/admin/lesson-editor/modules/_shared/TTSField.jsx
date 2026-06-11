import { useState, useRef, useEffect, useMemo } from 'react';
import { Play, Pause, X, SpeakerHigh } from '@phosphor-icons/react';
import { ToggleField } from './SharedFields';
import { getVoices, getModels } from '../../../../../utils/ttsApi';
import ObjectStoreBrowserModal from './ObjectStoreBrowserModal/ObjectStoreBrowserModal';
import TtsGeneratePanel from './TtsGenerateDialog';

const TTS_ROOT = 'tts/static/library/';

const fmtTime = (s) => {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

// 이름 매핑 캐시 (getVoices/getModels 자체도 캐시됨)
let _voicesPromise = null;
const loadVoicesOnce = () => {
  if (!_voicesPromise) _voicesPromise = getVoices().then((r) => r?.data?.voices || []).catch(() => []);
  return _voicesPromise;
};
let _modelsPromise = null;
const loadModelsOnce = () => {
  if (!_modelsPromise) _modelsPromise = getModels().then((r) => r?.data?.models || []).catch(() => []);
  return _modelsPromise;
};

const TTSField = ({ value, onChange, label, defaultText = '', suggestedVoiceId = '' }) => {
  const [manualOpen, setManualOpen] = useState(false);
  const hasData = value !== undefined && value !== null && !(typeof value === 'string' && !value);
  const enabled = (hasData && (typeof value === 'string' || value.enabled !== false)) || manualOpen;
  const ttsObj = typeof value === 'string' ? { url: value } : (value || {});
  const url = ttsObj.url || '';
  const timestamps = ttsObj.timestamps;
  const hasRef = !!url || !!ttsObj.assetId;

  const [modalOpen, setModalOpen] = useState(false);
  const [voices, setVoices] = useState([]);
  const [models, setModels] = useState([]);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => { loadVoicesOnce().then(setVoices); loadModelsOnce().then(setModels); }, []);
  useEffect(() => { setPlaying(false); setCurrentTime(0); }, [url]);

  const voiceName = useMemo(() => {
    const vid = ttsObj.voiceId;
    if (!vid) return null;
    const f = voices.find((v) => v.voice_id === vid);
    return f ? f.name.split(' - ')[0] : vid;
  }, [ttsObj.voiceId, voices]);
  const modelName = useMemo(() => {
    const mid = ttsObj.modelId;
    if (!mid) return null;
    const f = models.find((m) => m.model_id === mid);
    return f ? f.name : mid;
  }, [ttsObj.modelId, models]);

  const handleToggle = (on) => {
    if (on) {
      setManualOpen(true);
      if (hasData) {
        if (typeof value === 'string') onChange({ url: value });
        else { const { enabled: _omit, ...rest } = value; onChange(rest); }
      }
    } else {
      setManualOpen(false);
      if (hasData) {
        if (typeof value === 'string') onChange({ url: value, enabled: false });
        else onChange({ ...value, enabled: false });
      }
    }
  };

  const togglePlay = (e) => {
    e.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onChange(undefined);
    setManualOpen(true);
  };

  // 브라우저에서 .mp3 선택 → 사이드카(.json)로 타임스탬프/목소리/모델 로드 후 모듈에 반영
  const handleSelect = async (selUrl) => {
    const clean = (selUrl || '').split('?')[0];
    let meta = {};
    try {
      const sidecar = clean.replace(/\.mp3$/i, '.json');
      const r = await fetch(sidecar);
      if (r.ok) meta = await r.json();
    } catch { /* 사이드카 없으면 url 만 */ }
    onChange({ url: clean, timestamps: meta.timestamps, voiceId: meta.voice_id, modelId: meta.model_id });
    setModalOpen(false);
  };

  return (
    <div className="mb-3">
      <ToggleField label={label || 'TTS'} value={enabled} onChange={handleToggle} />
      {enabled && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="group relative flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left transition hover:border-cyan-400 hover:bg-slate-50"
            title="클릭하여 TTS 생성 / 선택"
          >
            {hasRef ? (
              <>
                {url && (
                  <span role="button" tabIndex={0} onClick={togglePlay}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') togglePlay(e); }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-600 text-white hover:bg-cyan-700">
                    {playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-800">{defaultText || '(텍스트)'}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {voiceName && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-600">{voiceName}</span>}
                    {modelName && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-500">{modelName}</span>}
                    {url && <span className="font-mono text-slate-400">{fmtTime(currentTime)} / {fmtTime(duration)}</span>}
                    {timestamps ? <span className="text-cyan-600">타임스탬프 ✓</span> : <span className="text-amber-500">타임스탬프 없음</span>}
                  </div>
                </div>
                <span role="button" tabIndex={0} onClick={handleClear}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClear(e); }}
                  className="shrink-0 rounded-full p-1 text-slate-300 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                  title="참조 해제">
                  <X size={14} />
                </span>
              </>
            ) : (
              <div className="flex w-full items-center justify-center gap-1.5 py-2 text-slate-400">
                <SpeakerHigh size={18} />
                <span className="text-xs">클릭하여 TTS 생성 / 선택</span>
              </div>
            )}
          </button>

          {url && (
            <audio ref={audioRef} src={url} className="hidden"
              onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.target.duration)}
              onEnded={() => { setPlaying(false); setCurrentTime(0); }} />
          )}

          {modalOpen && (
            <ObjectStoreBrowserModal
              title="TTS 선택"
              subtitle="폴더 탐색 · 우클릭 메뉴 · 드래그/박스선택 · ⌘C/X/V 지원"
              accept="audio/*"
              initialPath={TTS_ROOT}
              moveRoot={TTS_ROOT}
              browseRoot={TTS_ROOT}
              currentValue={url || null}
              hiddenExt={['json']}
              siblingResolver={(key) => (key && key.toLowerCase().endsWith('.mp3') ? [key.replace(/\.mp3$/i, '.json')] : [])}
              onSelect={handleSelect}
              onClose={() => setModalOpen(false)}
              primaryAction={{
                label: 'TTS 생성',
                render: ({ currentPath, reload, close }) => {
                  const folder = (currentPath || '').replace(/^tts\/static\/library\/?/, '').replace(/\/$/, '');
                  return (
                    <TtsGeneratePanel
                      defaultText={defaultText}
                      folder={folder}
                      suggestedVoiceId={suggestedVoiceId}
                      onCancel={close}
                      onCreated={() => { reload && reload(); close && close(); }}
                    />
                  );
                },
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default TTSField;
