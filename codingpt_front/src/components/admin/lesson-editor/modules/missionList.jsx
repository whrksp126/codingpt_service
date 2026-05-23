import { Field, TextField, ToggleField } from './_shared/SharedFields';
import VisibilityBadge from './_shared/VisibilityBadge';

const FormView = ({ value, onChange }) => {
  const items = value.items || [];
  const setItems = (next) => onChange({ ...value, items: next });
  const addItem = () => setItems([...items, { id: items.length, text: '' }]);
  const updateItem = (i, patch) => setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const removeItem = (i) => setItems(items.filter((_, idx) => idx !== i));
  return (
    <>
      <Field label="제목">
        <TextField value={value.title} onChange={(v) => onChange({ ...value, title: v })} placeholder="Mission" />
      </Field>
      <div className="mb-3">
        <ToggleField
          value={!!value.completed}
          onChange={(v) => onChange({ ...value, completed: v })}
          label="완료 표시 (체크 상태로 렌더)"
        />
      </div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">
          항목 ({items.length})
        </span>
        <button
          type="button"
          onClick={addItem}
          className="rounded bg-slate-100 px-2.5 py-1 text-[11px] hover:bg-slate-200"
        >
          + 항목 추가
        </button>
      </div>
      {items.map((it, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <span className="text-xs text-slate-400 w-5">{i + 1}.</span>
          <TextField value={it.text} onChange={(v) => updateItem(i, { text: v })} />
          <button type="button" onClick={() => removeItem(i)} className="text-red-500 text-xs">✕</button>
        </div>
      ))}
    </>
  );
};

// RN MissionList.tsx 외형: #F8F9FC bg, 16 round, 24 padding, 22/700 centered title, 24px 원형 체크 + 18/700 텍스트.
const PreviewView = ({ module, onModuleChange }) => {
  const items = module.items || [];
  const updateItemAt = (i, patch) => {
    if (!onModuleChange) return;
    const next = items.slice();
    next[i] = { ...next[i], ...patch };
    onModuleChange({ ...module, items: next });
  };

  return (
    <div className="relative">
      <div
        style={{
          background: '#F8F9FC',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 0 5px rgba(0,0,0,0.25)',
        }}
      >
        {module.title && (
          <div style={{ textAlign: 'center', marginBottom: 24, fontSize: 22, fontWeight: 700, lineHeight: '33px', letterSpacing: '-0.44px', color: '#333' }}>
            {module.title}
          </div>
        )}
        <div className="flex flex-col" style={{ gap: 16 }}>
          {items.map((it, i) => {
            const completed = !!module.completed;
            return (
              // 각 미션 항목별 가시성 뱃지를 캔버스 우측 외부로 leak: 행 wrapper 를 relative+w-full 로 잡고
              // 절대좌표 left-full ml-6 사용해 SlideCanvas 모듈 뱃지와 동일한 위치 패턴 유지.
              <div key={it.id ?? i} className="relative w-full">
                <div className="flex items-center" style={{ height: 24, gap: 12 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: '2px solid ' + (completed ? '#8B54F7' : 'rgba(51,51,51,0.5)'),
                      background: completed ? '#8B54F7' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {completed ? '✓' : ''}
                  </div>
                  <span style={{ fontSize: 18, fontWeight: 700, lineHeight: '24px', color: 'rgba(51,51,51,0.8)' }}>
                    {it.text}
                  </span>
                </div>
                <div
                  className="absolute z-20 -translate-y-1/2"
                  // 미션 카드 안쪽 padding(24px) 만큼 더 밀어서 SlideCanvas 모듈 뱃지와 같은 라인에 위치.
                  style={{ left: 'calc(100% + 48px)', top: '50%' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <VisibilityBadge
                    value={it.visibility}
                    onChange={(v) => updateItemAt(i, { visibility: v })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default {
  type: 'missionList',
  category: 'structure',
  hasItemVisibility: true,
  label: '미션 목록',
  description: '체크리스트형 항목',
  icon: '',
  defaultValue: () => ({ type: 'missionList', title: 'Mission', items: [{ id: 0, text: '' }] }),
  FormView,
  PreviewView,
};
