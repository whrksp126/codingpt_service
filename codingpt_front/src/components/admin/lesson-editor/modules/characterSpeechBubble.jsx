import { useMemo, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { useEditor } from '../state/EditorContext';
import { useResultParent } from '../state/ResultParentContext';
import { Field, SelectField, ToggleField, TTSField } from './_shared/SharedFields';
import { CONTEXT_DEFAULT_VOICE } from './_shared/ttsVoiceDefaults';
import AssetPickerField from './_shared/AssetPickerField';
import RawHtmlPreview from './_shared/RawHtmlPreview';
import MonacoField from './_shared/MonacoField';
import VisibilityBadge from './_shared/VisibilityBadge';
import { stripHtml } from './_shared/htmlText';

const TOKEN_RE = /\{\{userAnswer_(\d+)\}\}/g;

const CHARACTERS = [
  { value: 'inherit', label: '레슨 기본 캐릭터 사용' },
  { value: 'student_full', label: '학생 (전신)' },
  { value: 'student_profile', label: '학생 (프로필)' },
  { value: 'teacher_full', label: '선생님 (전신)' },
  { value: 'teacher_profile', label: '선생님 (프로필)' },
];

const CHARACTER_KEYS = new Set(CHARACTERS.map((c) => c.value).filter((v) => v !== 'inherit'));

const buildCharacterUrl = (key) => {
  if (!key || key === 'inherit') return null;
  return `https://objectstore.ghmate.com/codingpt/lesson-assets/images/${key}.png`;
};

// 저장된 데이터의 레거시 경로(`/lesson-assets/characters/`)를 실제 존재하는 `/lesson-assets/images/`로 교정
const normalizeCharacterUrl = (url) => {
  if (!url) return url;
  return url.replace('/lesson-assets/characters/', '/lesson-assets/images/');
};

const detectCharacterKeyFromUrl = (url) => {
  if (!url) return null;
  const m = url.match(/\/lesson-assets\/(?:characters|images)\/([^/]+)\.png/);
  if (m && CHARACTER_KEYS.has(m[1])) return m[1];
  return null;
};

const FormView = ({ value, onChange }) => {
  const speeches = value.speeches || [];
  const { state } = useEditor();
  const { parentType, parentValue } = useResultParent();
  const isFillGapChild = parentType === 'codeFillTheGapV2';
  const blanksLen = isFillGapChild ? (parentValue?.blanks?.length || 0) : 0;

  // 말풍선별 Monaco editor instance + 마지막 포커스된 말풍선 인덱스
  const editorRefs = useRef({});
  const lastFocusRef = useRef(0);

  const updateSpeech = (idx, patch) => {
    const next = speeches.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...value, speeches: next });
  };
  const addSpeech = () => {
    onChange({ ...value, speeches: [...speeches, { id: speeches.length, content: '<p></p>' }] });
  };
  const removeSpeech = (idx) => {
    onChange({ ...value, speeches: speeches.filter((_, i) => i !== idx) });
  };

  const insertToken = (n) => {
    const token = `{{userAnswer_${n}}}`;
    const targetIdx = lastFocusRef.current;
    const editor = editorRefs.current[targetIdx];
    if (!editor) {
      // 폴백: 해당 말풍선 content 끝에 append
      const cur = speeches[targetIdx]?.content || '';
      updateSpeech(targetIdx, { content: cur + token });
      return;
    }
    const selection = editor.getSelection();
    const range = selection && !selection.isEmpty()
      ? selection
      : new monaco.Range(
          selection?.startLineNumber || 1,
          selection?.startColumn || 1,
          selection?.startLineNumber || 1,
          selection?.startColumn || 1,
        );
    editor.executeEdits('insert-token', [
      { range, text: token, forceMoveMarkers: true },
    ]);
    editor.focus();
  };

  // 모든 말풍선의 토큰 사용 현황 요약
  const tokenSummary = useMemo(() => {
    const used = new Set();
    const invalid = new Set();
    const joined = (speeches || []).map((s) => s?.content || '').join('\n');
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(joined)) !== null) {
      const idx = parseInt(m[1], 10);
      used.add(idx);
      if (Number.isNaN(idx) || idx < 0 || idx >= blanksLen) invalid.add(idx);
    }
    return { used: [...used].sort((a, b) => a - b), invalid: [...invalid].sort((a, b) => a - b) };
  }, [speeches, blanksLen]);

  const characterImage = value.character?.image;
  const characterKey = characterImage
    ? (detectCharacterKeyFromUrl(characterImage) || 'inherit')
    : 'inherit';

  // 캐릭터(선생님/학생)에 따른 기본 TTS 보이스 — PreviewView 의 inferredKey 와 동일 규칙.
  // 'inherit' 이면 레슨 기본 캐릭터(default_character)로 해석.
  const resolvedCharacterKey = detectCharacterKeyFromUrl(characterImage)
    || state.lesson?.default_character || 'student_full';
  const suggestedVoiceId = resolvedCharacterKey.startsWith('teacher')
    ? CONTEXT_DEFAULT_VOICE.teacher
    : CONTEXT_DEFAULT_VOICE.student;

  return (
    <>
      <Field label="캐릭터">
        <SelectField
          value={characterKey}
          onChange={(v) => {
            if (v === 'inherit') {
              onChange({ ...value, character: undefined });
            } else {
              onChange({ ...value, character: { image: buildCharacterUrl(v) } });
            }
          }}
          options={CHARACTERS}
        />
      </Field>
      <Field label="위치">
        <SelectField
          value={value.position || 'right'}
          onChange={(v) => onChange({ ...value, position: v })}
          options={[{ value: 'left', label: '왼쪽' }, { value: 'right', label: '오른쪽' }]}
        />
      </Field>

      {isFillGapChild && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-2">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            빈칸 토큰 삽입
          </div>
          {blanksLen === 0 ? (
            <p className="text-[11px] text-slate-400">부모 빈칸 채우기에 빈칸이 없습니다.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: blanksLen }, (_, n) => {
                  const sample = parentValue?.blanks?.[n]?.correctAnswer;
                  const inUse = tokenSummary.used.includes(n);
                  return (
                    <button
                      type="button"
                      key={n}
                      onClick={() => insertToken(n)}
                      className={
                        'inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] ' +
                        (inUse
                          ? 'bg-cyan-500 text-white ring-1 ring-cyan-600'
                          : 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-300 hover:bg-cyan-100')
                      }
                      title={sample ? `정답 예: ${sample}` : ''}
                    >
                      <span className="font-bold">#{n}</span>
                      <span className="opacity-80">{`{{userAnswer_${n}}}`}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                마지막 포커스된 말풍선의 커서 위치에 삽입됩니다.
              </p>
              {tokenSummary.invalid.length > 0 && (
                <p className="mt-1 text-[11px] text-red-600">
                  ⚠ 유효하지 않은 토큰: {tokenSummary.invalid.map((i) => `#${i}`).join(', ')} — 부모 빈칸 범위(0..{blanksLen - 1}) 밖입니다.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">
          말풍선 ({speeches.length})
        </span>
        <button
          type="button"
          onClick={addSpeech}
          className="rounded bg-slate-100 px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-200"
        >
          + 말풍선 추가
        </button>
      </div>
      {speeches.map((s, i) => (
        <div key={i} className="mb-3 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-500">#{i + 1}</span>
            <button type="button" onClick={() => removeSpeech(i)} className="text-xs text-red-500 hover:underline">
              삭제
            </button>
          </div>
          <Field label="내용 (HTML)">
            <div
              onFocusCapture={() => { lastFocusRef.current = i; }}
              onMouseDown={() => { lastFocusRef.current = i; }}
            >
              <MonacoField
                value={s.content}
                onChange={(v) => updateSpeech(i, { content: v })}
                language="html"
                height={140}
                onReady={(ed) => { editorRefs.current[i] = ed; }}
              />
            </div>
          </Field>
          <div className="mb-2">
            <ToggleField
              value={s.image !== undefined}
              onChange={(on) => updateSpeech(i, { image: on ? (s.image ?? '') : undefined })}
              label="이미지"
            />
            {s.image !== undefined && (
              <AssetPickerField
                label=""
                value={s.image}
                onChange={(v) => updateSpeech(i, { image: v })}
                accept="image/*"
              />
            )}
          </div>
          <TTSField
            value={s.tts}
            onChange={(v) => updateSpeech(i, { tts: v })}
            defaultText={stripHtml(s.content)}
            suggestedVoiceId={suggestedVoiceId}
          />
        </div>
      ))}
    </>
  );
};

// 말풍선 외형은 RN CharacterSpeechBubble.tsx 의 #F8F9FC 배경 + 15 round + 12/18 padding + drop shadow 와 매칭.
const bubbleStyle = {
  background: '#F8F9FC',
  borderRadius: 15,
  padding: '12px 18px',
  boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
  display: 'inline-block',
  maxWidth: '100%',
};

// 각 말풍선의 가시성 뱃지를 캔버스 밖(우측)에 띄우기 위한 행 래퍼.
// SlideCanvas 모듈 뱃지와 동일한 left-full ml-6 패턴을 사용해 캔버스 frame 우측으로 leak 시킨다.
// 모듈 레벨 뱃지(top-1)와 겹치지 않도록 행 중앙(top-1/2)에 정렬.
const SpeechRow = ({ speech, onSpeechChange, children }) => (
  <div className="relative w-full">
    {children}
    <div
      className="absolute left-full top-1/2 z-20 ml-6 -translate-y-1/2"
      onClick={(e) => e.stopPropagation()}
    >
      <VisibilityBadge
        value={speech.visibility}
        onChange={(v) => onSpeechChange({ visibility: v })}
      />
    </div>
  </div>
);

const PreviewView = ({ module, onModuleChange }) => {
  const { state } = useEditor();
  const lessonDefault = state.lesson?.default_character;
  const rawUrl = module.character?.image || (lessonDefault ? buildCharacterUrl(lessonDefault) : null);
  const characterUrl = normalizeCharacterUrl(rawUrl);
  // RN CharacterSpeechBubble 와 동일하게 기본값 'right'.
  const position = module.position || 'right';
  const isLeft = position === 'left';
  // 캐릭터 이미지 URL의 _profile/_full suffix로 자동 추론 (모듈에 별도 displayType 필드는 더 이상 두지 않음)
  const inferredKey = detectCharacterKeyFromUrl(rawUrl) || state.lesson?.default_character || 'student_full';
  const isProfile = inferredKey.endsWith('_profile');
  const speeches = module.speeches || [];

  const updateSpeechAt = (i, patch) => {
    if (!onModuleChange) return;
    const next = speeches.slice();
    next[i] = { ...next[i], ...patch };
    onModuleChange({ ...module, speeches: next });
  };

  // RN: profile 또는 left → 75x75 원형 캐릭터를 첫 말풍선 옆에 배치
  if (isProfile || isLeft) {
    return (
      <div className="flex flex-col gap-3">
        {speeches.map((s, i) => (
          <SpeechRow key={s.id ?? i} speech={s} onSpeechChange={(p) => updateSpeechAt(i, p)}>
            <div
              className={'flex items-center gap-[18px] ' + (isLeft ? 'flex-row' : 'flex-row-reverse')}
            >
              <div
                style={{
                  width: 75,
                  height: 75,
                  borderRadius: '50%',
                  overflow: 'hidden',
                  background: i === 0 ? (characterUrl ? '#B5A495' : '#E5E7EB') : 'transparent',
                  flexShrink: 0,
                }}
              >
                {i === 0 && characterUrl && (
                  <img
                    src={characterUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                )}
              </div>
              <div style={bubbleStyle}>
                <RawHtmlPreview html={s.content} />
                {s.image && <img src={s.image} alt="" className="mt-2 max-h-20 rounded" />}
              </div>
            </div>
          </SpeechRow>
        ))}
      </div>
    );
  }

  // RN: full + right → 80x80 전신 캐릭터를 우측 절반에 absolute 배치(첫 말풍선 기준 세로 중앙)
  // 각 말풍선마다 행 wrapper 를 만들고, 첫 말풍선 wrapper 안에서 캐릭터를 absolute 배치 → RN 과 정확히 일치.
  return (
    <div className="flex flex-col gap-3" style={{ paddingTop: 20 }}>
      {speeches.map((s, i) => (
        <SpeechRow key={s.id ?? i} speech={s} onSpeechChange={(p) => updateSpeechAt(i, p)}>
          <div className="relative w-full" style={{ paddingRight: 100 }}>
            <div className="flex justify-end">
              <div style={bubbleStyle}>
                <RawHtmlPreview html={s.content} />
                {s.image && <img src={s.image} alt="" className="mt-2 max-h-20 rounded" />}
              </div>
            </div>
            {i === 0 && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  width: 80,
                  height: 80,
                }}
              >
                {characterUrl && (
                  <img
                    src={characterUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  />
                )}
              </div>
            )}
          </div>
        </SpeechRow>
      ))}
    </div>
  );
};

export default {
  type: 'characterSpeechBubble',
  category: 'character',
  hasItemVisibility: true,
  label: '캐릭터 말풍선',
  description: '캐릭터 + 여러 말풍선',
  icon: '',
  defaultValue: () => ({
    type: 'characterSpeechBubble',
    position: 'right',
    speeches: [{ id: 0, content: '<p>안녕하세요!</p>' }],
  }),
  FormView,
  PreviewView,
};
