import * as PhosphorIcons from '@phosphor-icons/react';
import { Field, TextField, ToggleField } from './_shared/SharedFields';

const FormView = ({ value, onChange }) => {
  const missions = value.missions || value.items || [];
  const setMissions = (next) => onChange({ ...value, missions: next, items: undefined });
  return (
    <>
      <Field label="제목">
        <TextField value={value.title} onChange={(v) => onChange({ ...value, title: v })} placeholder="Mission" />
      </Field>
      <Field label="우측 텍스트">
        <TextField value={value.rightText} onChange={(v) => onChange({ ...value, rightText: v })} placeholder="6 단계" />
      </Field>
      <Field label={`미션 (${missions.length})`}>
        <button
          type="button"
          onClick={() => setMissions([...missions, { id: `m-${missions.length}`, icon: 'MissionCheck', text: '', completed: false }])}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 추가
        </button>
      </Field>
      {missions.map((m, i) => (
        <div key={i} className="mb-2 rounded border border-slate-200 p-2">
          <TextField value={m.text} onChange={(v) => setMissions(missions.map((x, idx) => idx === i ? { ...x, text: v } : x))} placeholder="미션 텍스트" />
          <div className="mt-1 flex items-center gap-2">
            <ToggleField value={m.completed} onChange={(v) => setMissions(missions.map((x, idx) => idx === i ? { ...x, completed: v } : x))} label="완료" />
            <button type="button" onClick={() => setMissions(missions.filter((_, idx) => idx !== i))} className="ml-auto text-xs text-red-500">삭제</button>
          </div>
        </div>
      ))}
      <ToggleField value={value.sparkle} onChange={(v) => onChange({ ...value, sparkle: v })} label="완료 시 반짝임" />
    </>
  );
};

// RN MissionCard.tsx 외형: 흰 카드 + 그림자, 22/700 centered title, 미션마다 24 아이콘 + 18/700 텍스트 + 16/700 우측 배지.
const PreviewView = ({ module }) => {
  const missions = module.missions || module.items || [];
  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 16,
        padding: 24,
        boxShadow: '0 4px 8px rgba(0,0,0,0.1)',
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 24, fontSize: 22, fontWeight: 700, color: '#333' }}>
        {module.title || 'Mission'}
      </div>
      <div className="flex flex-col" style={{ gap: 16 }}>
        {missions.map((m, i) => {
          const Icon = m.icon ? PhosphorIcons[m.icon] : null;
          const iconColor = m.completed ? m.iconColor || '#08875D' : '#333333';
          return (
            <div key={i} className="flex items-center justify-between">
              <div className="flex items-center" style={{ gap: 12, flex: 1 }}>
                <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {Icon ? (
                    <Icon size={24} weight="fill" color={iconColor} />
                  ) : (
                    <span style={{ color: iconColor, fontSize: 18 }}>✓</span>
                  )}
                </div>
                <span style={{ fontSize: 18, fontWeight: 700, color: 'rgba(51,51,51,0.8)' }}>
                  {m.text}
                </span>
              </div>
              {m.badge && (
                <span
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: m.completed ? m.badgeColor || '#08875D' : '#333',
                  }}
                >
                  {m.badge}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default {
  type: 'missionCard',
  category: 'structure',
  label: '미션 카드',
  description: '체크리스트 카드',
  icon: '✅',
  defaultValue: () => ({ type: 'missionCard', title: 'Mission', missions: [] }),
  FormView,
  PreviewView,
};
