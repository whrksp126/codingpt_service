import { Field, TextField, ColorField } from './_shared/SharedFields';

const FormView = ({ value, onChange }) => {
  const items = value.items || [];
  const setItems = (next) => onChange({ ...value, items: next });
  return (
    <>
      <Field label={`항목 (${items.length})`}>
        <button
          type="button"
          onClick={() => setItems([...items, { code: '', description: '' }])}
          className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200"
        >
          + 추가
        </button>
      </Field>
      {items.map((it, i) => (
        <div key={i} className="mb-3 rounded border border-slate-200 p-2">
          <Field label="코드 칩">
            <TextField value={it.code} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, code: v } : x))} placeholder="<button>" />
          </Field>
          <Field label="배경 색">
            <ColorField value={it.codeStyle?.backgroundColor} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, codeStyle: { ...(x.codeStyle || {}), backgroundColor: v } } : x))} />
          </Field>
          <Field label="텍스트 색">
            <ColorField value={it.codeStyle?.textColor} onChange={(v) => setItems(items.map((x, idx) => idx === i ? { ...x, codeStyle: { ...(x.codeStyle || {}), textColor: v } } : x))} />
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

// RN ConceptCard.tsx 외형: 흰 카드 + 무거운 그림자, 코드 칩(#E8F0FE/#2F6FED) + 설명 텍스트, 항목 사이 1px divider.
const PreviewView = ({ module }) => {
  const items = module.items || [];
  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 16,
        padding: 20,
        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
      }}
    >
      <div className="flex flex-col" style={{ gap: 15 }}>
        {items.map((it, i) => (
          <div key={i}>
            <div className="flex flex-col" style={{ gap: 10 }}>
              {it.code && (
                <span
                  style={{
                    alignSelf: 'flex-start',
                    background: it.codeStyle?.backgroundColor || '#E8F0FE',
                    color: it.codeStyle?.textColor || '#2F6FED',
                    borderRadius: 8,
                    padding: '4px 10px',
                    fontSize: 14,
                    fontWeight: 700,
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  }}
                >
                  {it.code}
                </span>
              )}
              {it.description && (
                <div style={{ fontSize: 15, fontWeight: 400, lineHeight: '22.5px', color: '#333' }}>
                  {it.description}
                </div>
              )}
            </div>
            {i !== items.length - 1 && (
              <div style={{ height: 1, background: '#E1E6EF', marginTop: 15 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default {
  type: 'conceptCard',
  category: 'structure',
  label: '개념 카드',
  description: '코드 칩 + 설명',
  icon: '💡',
  defaultValue: () => ({ type: 'conceptCard', items: [{ code: '', description: '' }] }),
  FormView,
  PreviewView,
};
