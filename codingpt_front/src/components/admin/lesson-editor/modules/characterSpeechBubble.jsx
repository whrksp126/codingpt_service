import { useEditor } from '../state/EditorContext';
import { Field, SelectField, TextField, ToggleField, TTSField } from './_shared/SharedFields';
import RawHtmlPreview from './_shared/RawHtmlPreview';
import MonacoField from './_shared/MonacoField';
import VisibilityBadge from './_shared/VisibilityBadge';

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

  const characterImage = value.character?.image;
  const characterKey = characterImage
    ? (detectCharacterKeyFromUrl(characterImage) || 'inherit')
    : 'inherit';

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

      <Field label={`말풍선 (${speeches.length})`}>
        <button
          type="button"
          onClick={addSpeech}
          className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
        >
          + 말풍선 추가
        </button>
      </Field>
      {speeches.map((s, i) => (
        <div key={i} className="mb-3 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-500">#{i + 1}</span>
            <button type="button" onClick={() => removeSpeech(i)} className="text-xs text-red-500 hover:underline">
              삭제
            </button>
          </div>
          <Field label="내용 (HTML)">
            <MonacoField
              value={s.content}
              onChange={(v) => updateSpeech(i, { content: v })}
              language="html"
              height={140}
            />
          </Field>
          <Field label="이미지 URL (선택)">
            <TextField value={s.image} onChange={(v) => updateSpeech(i, { image: v })} />
          </Field>
          <ToggleField
            value={s.showCharacter}
            onChange={(v) => updateSpeech(i, { showCharacter: v })}
            label="캐릭터 함께 표시"
          />
          <div className="mt-2">
            <TTSField
              value={s.tts}
              onChange={(v) => updateSpeech(i, { tts: v })}
              label="말풍선 TTS"
            />
          </div>
        </div>
      ))}
      <TTSField value={value.tts} onChange={(v) => onChange({ ...value, tts: v })} label="모듈 기본 TTS (말풍선별 TTS 미설정 시 폴백)" />
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
  icon: '💬',
  defaultValue: () => ({
    type: 'characterSpeechBubble',
    position: 'right',
    speeches: [{ id: 0, content: '<p>안녕하세요!</p>' }],
  }),
  FormView,
  PreviewView,
};
