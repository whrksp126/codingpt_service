import { useState, useMemo } from 'react';
import { ToggleField, TextField } from './SharedFields';
import MonacoField from './MonacoField';
import VoiceSelector from '../../../../tts/VoiceSelector';
import ModelSelector from '../../../../tts/ModelSelector';
import { useEditor } from '../../state/EditorContext';
import { generateTTS, saveTTS } from '../../../../../utils/ttsApi';

const LS_VOICE = 'tts_admin_voice_id';
const LS_MODEL = 'tts_admin_model_id';
const DEFAULT_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

const SubSection = ({ title, open, onToggle, children }) => (
  <div className="mt-2 rounded border border-slate-200">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between px-2 py-1.5 text-left"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</span>
      <span className="text-[11px] text-slate-400">{open ? '▼' : '▶'}</span>
    </button>
    {open && <div className="border-t border-slate-200 p-2">{children}</div>}
  </div>
);

const TTSField = ({ value, onChange, label, defaultText = '' }) => {
  const { state } = useEditor();
  const lessonId = state.lesson?.id;
  // 토글 ON/OFF 의미: 데이터 자체는 항상 보존. enabled === false 면 RN에서 비활성 표시(백엔드 runtime API가 strip).
  const hasData = value !== undefined && value !== null;
  const enabled = hasData && (typeof value === 'string' || value.enabled !== false);
  const ttsObj = typeof value === 'string' ? { url: value } : (value || {});
  const url = ttsObj.url || '';
  const timestamps = ttsObj.timestamps;
  const hasUrl = !!url;

  const [voiceId, setVoiceId] = useState(() => localStorage.getItem(LS_VOICE) || '');
  const [modelId, setModelId] = useState(() => localStorage.getItem(LS_MODEL) || '');
  const [text, setText] = useState(defaultText);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);

  const timestampsJson = useMemo(() => {
    if (!timestamps) return '';
    try {
      return JSON.stringify(timestamps, null, 2);
    } catch {
      return '';
    }
  }, [timestamps]);

  const handleToggle = (on) => {
    if (on) {
      // 켜기: 데이터가 있으면 enabled 플래그만 제거(또는 true). 없으면 빈 객체 생성.
      if (hasData) {
        if (typeof value === 'string') {
          onChange({ url: value });
        } else {
          const { enabled: _omit, ...rest } = value;
          onChange(rest);
        }
      } else {
        onChange({ url: '' });
      }
    } else {
      // 끄기: 데이터는 보존, enabled: false 만 마킹. RN runtime API가 자동으로 strip.
      if (hasData) {
        if (typeof value === 'string') {
          onChange({ url: value, enabled: false });
        } else {
          onChange({ ...value, enabled: false });
        }
      }
      // 데이터 없는 경우 토글 OFF는 no-op
    }
  };

  const handleVoiceChange = (v) => {
    setVoiceId(v);
    if (v) localStorage.setItem(LS_VOICE, v);
  };

  const handleModelChange = (v) => {
    setModelId(v);
    if (v) localStorage.setItem(LS_MODEL, v);
  };

  const handleGenerate = async () => {
    setError(null);
    const trimmed = (text || '').trim();
    if (!trimmed) {
      setError('텍스트를 입력하세요.');
      return;
    }
    if (!voiceId || !modelId) {
      setError('음성/모델을 선택하세요. (음성 설정 펼치기)');
      setVoiceOpen(true);
      return;
    }
    if (!lessonId) {
      setError('lessonId를 찾을 수 없습니다.');
      return;
    }
    const ok = window.confirm('ElevenLabs API를 호출합니다 (비용 발생). 계속할까요?');
    if (!ok) return;

    setIsGenerating(true);
    try {
      const gen = await generateTTS(voiceId, modelId, trimmed, DEFAULT_SETTINGS);
      if (!gen?.success || !gen?.data) throw new Error(gen?.message || '생성 실패');
      const { requestId, timestamps: genTs } = gen.data;
      const saved = await saveTTS(requestId, `lesson-id-${String(lessonId).padStart(8, '0')}`);
      if (!saved?.success || !saved?.data) throw new Error(saved?.message || '저장 실패');
      onChange({ url: saved.data.s3Url, timestamps: genTs });
    } catch (e) {
      console.error(e);
      setError(e.message || '생성 중 오류가 발생했습니다.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleUrlChange = (v) => {
    onChange({ ...ttsObj, url: v });
  };

  const handleTimestampsJsonChange = (v) => {
    if (!v || !v.trim()) {
      const { timestamps: _omit, ...rest } = ttsObj;
      onChange(rest);
      return;
    }
    try {
      const parsed = JSON.parse(v);
      onChange({ ...ttsObj, timestamps: parsed });
      setError(null);
    } catch {
      // 잘못된 JSON일 때는 상태를 변경하지 않고 에러만 표시
      setError('timestamps JSON 형식 오류');
    }
  };

  return (
    <div className="mb-3">
      <ToggleField label={label || 'TTS'} value={enabled} onChange={handleToggle} />
      {enabled && (
        <div className="mt-1">
          <label className="mb-2 block">
            <span className="mb-1 block text-xs font-medium text-slate-600">텍스트</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="TTS로 변환할 텍스트"
              className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-cyan-500 focus:outline-none"
            />
            {defaultText && text !== defaultText && (
              <button
                type="button"
                onClick={() => setText(defaultText)}
                className="mt-1 text-[11px] text-cyan-600 hover:underline"
              >
                모듈 텍스트로 초기화
              </button>
            )}
          </label>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isGenerating ? '생성 중...' : hasUrl ? 'TTS 재생성' : 'TTS 생성'}
            </button>
            {hasUrl && (
              <span className="text-[11px] text-slate-500">
                {timestamps ? '✓ 타임스탬프 있음' : '⚠ 타임스탬프 없음'}
              </span>
            )}
          </div>

          {error && (
            <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
              {error}
            </div>
          )}

          {hasUrl && (
            <div className="mb-2">
              <audio src={url} controls className="w-full" style={{ height: 32 }} />
            </div>
          )}

          <SubSection title="음성 설정" open={voiceOpen} onToggle={() => setVoiceOpen((v) => !v)}>
            <VoiceSelector selectedVoiceId={voiceId} onVoiceChange={handleVoiceChange} />
            <div className="mt-3">
              <ModelSelector selectedModelId={modelId} onModelChange={handleModelChange} />
            </div>
          </SubSection>

          <SubSection title="고급 (URL/타임스탬프 직접 편집)" open={advancedOpen} onToggle={() => setAdvancedOpen((v) => !v)}>
            <label className="mb-2 block">
              <span className="mb-1 block text-xs font-medium text-slate-600">오디오 URL</span>
              <TextField value={url} onChange={handleUrlChange} placeholder="https://..." />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">타임스탬프 JSON</span>
              <MonacoField
                value={timestampsJson}
                onChange={handleTimestampsJsonChange}
                language="json"
                height={200}
                disableAutoFormat
              />
            </label>
          </SubSection>
        </div>
      )}
    </div>
  );
};

export default TTSField;
