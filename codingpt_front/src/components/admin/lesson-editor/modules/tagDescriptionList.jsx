import { Field, TextField } from './_shared/SharedFields';

const FormView = ({ value, onChange }) => {
  const items = value.items || [];
  const setItems = (next) => onChange({ ...value, items: next });
  return (
    <>
      <Field label={`항목 (${items.length})`}>
        <button type="button" onClick={() => setItems([...items, { id: items.length, tag: '', description: '' }])} className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200">
          + 추가
        </button>
      </Field>
      {items.map((it, i) => (
        <div key={i} className="mb-2 rounded border border-slate-200 p-2">
          <Field label="태그">
            <TextField value={it.tag} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, tag: v } : x))} />
          </Field>
          <Field label="제목 (선택)">
            <TextField value={it.title} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, title: v } : x))} />
          </Field>
          <Field label="설명">
            <TextField value={it.description} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, description: v } : x))} multiline rows={2} />
          </Field>
          <button type="button" onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="text-xs text-red-500">삭제</button>
        </div>
      ))}
    </>
  );
};

// RN TagDescriptionList.tsx 외형: #F8F9FC bg, 16 round, 20 padding, 태그 칩(#F0F5FF/#2F6FED, 6 round), 항목 사이 0.75px #E1E6EF divider.
const PreviewView = ({ module }) => {
  const items = module.items || [];
  return (
    <div
      style={{
        background: '#F8F9FC',
        borderRadius: 16,
        padding: 20,
        boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 15,
      }}
    >
      {items.map((it, i) => {
        const isLast = i === items.length - 1;
        return (
          <div
            key={i}
            style={{
              borderBottom: isLast ? 'none' : '0.75px solid #E1E6EF',
              paddingBottom: isLast ? 0 : 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <span
              style={{
                alignSelf: 'flex-start',
                background: '#F0F5FF',
                color: '#2F6FED',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: '-0.28px',
              }}
            >
              {it.tag}
            </span>
            {it.title && (
              <div style={{ fontSize: 14, fontWeight: 700, color: '#333' }}>{it.title}</div>
            )}
            {it.description && (
              <div
                style={{ fontSize: 15, color: '#333', lineHeight: '22.5px' }}
                dangerouslySetInnerHTML={{ __html: it.description }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default {
  type: 'tagDescriptionList',
  category: 'structure',
  label: '태그 설명 목록',
  description: '태그/제목/설명 3단 구조',
  icon: '',
  defaultValue: () => ({ type: 'tagDescriptionList', items: [] }),
  FormView,
  PreviewView,
};
