import { useEffect, useRef, useState } from 'react';
import { Field, NumberField, SelectField, TextField } from './_shared/SharedFields';
import MonacoField from './_shared/MonacoField';

const FormView = ({ value, onChange }) => {
  const tabs = value.tabs || [];
  const updateTab = (idx, patch) => {
    const next = tabs.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange({ ...value, tabs: next });
  };
  const addTab = () => {
    onChange({ ...value, tabs: [...tabs, { type: 'url', content: '' }] });
  };
  const removeTab = (idx) => {
    onChange({ ...value, tabs: tabs.filter((_, i) => i !== idx) });
  };

  return (
    <>
      <Field label="높이 (px)" hint="비워두면 내용 높이에 맞춰 자동 측정">
        <NumberField
          value={value.height}
          onChange={(v) => onChange({ ...value, height: v })}
          min={0}
          placeholder="auto"
        />
      </Field>
      <Field label={`탭 (${tabs.length})`}>
        <button
          type="button"
          onClick={addTab}
          className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
        >
          + 탭 추가
        </button>
      </Field>
      {tabs.map((tab, i) => (
        <div key={i} className="mb-3 rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">탭 #{i + 1}</span>
            <button
              type="button"
              onClick={() => removeTab(i)}
              className="text-xs text-red-500 hover:underline"
            >
              삭제
            </button>
          </div>
          <Field label="타입">
            <SelectField
              value={tab.type}
              onChange={(v) => updateTab(i, { type: v })}
              options={[
                { value: 'url', label: 'URL (외부 페이지)' },
                { value: 'html', label: 'HTML (인라인 코드)' },
              ]}
            />
          </Field>
          <Field label={tab.type === 'url' ? 'URL' : 'HTML 코드'}>
            {tab.type === 'html' ? (
              <MonacoField
                value={tab.content}
                onChange={(v) => updateTab(i, { content: v })}
                language="html"
                height={220}
                disableAutoFormat
              />
            ) : (
              <TextField
                value={tab.content}
                onChange={(v) => updateTab(i, { content: v })}
                placeholder="https://..."
              />
            )}
          </Field>
        </div>
      ))}
    </>
  );
};

const WebviewFrame = ({ tab, forcedHeight }) => {
  const ref = useRef(null);
  const [height, setHeight] = useState(forcedHeight || 320);

  const measure = () => {
    if (forcedHeight) return;
    const iframe = ref.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      const h = Math.max(
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
      );
      if (h && h > 40) setHeight(h);
    } catch {
      // cross-origin, fallback to 320
    }
  };

  useEffect(() => {
    if (forcedHeight) {
      setHeight(forcedHeight);
      return undefined;
    }
    if (tab.type !== 'html') return undefined;
    const id = setInterval(measure, 500);
    return () => clearInterval(id);
  }, [tab.type, tab.content, forcedHeight]);

  if (!tab) return null;

  const isUrl = tab.type === 'url';

  return (
    <iframe
      ref={ref}
      title="webview-preview"
      srcDoc={tab.type === 'html' ? tab.content : undefined}
      src={isUrl ? tab.content : undefined}
      sandbox="allow-scripts allow-same-origin"
      onLoad={measure}
      className="block w-full bg-white"
      style={{ height, pointerEvents: 'none', border: 0 }}
    />
  );
};

const PreviewView = ({ module }) => {
  const tabs = module.tabs || [];
  if (tabs.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-400">
        탭 없음
      </div>
    );
  }
  const tab = tabs[0];
  // 헤더 색상은 RN WebView.tsx 의 Danger/Warning/Success-Pressed-900 토큰 미러.
  return (
    <div className="overflow-hidden rounded-2xl border border-[#E5E5E5] bg-white shadow-sm">
      <div className="flex h-[30px] items-center px-4" style={{ gap: 6 }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#981B25' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#80460D' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#066042' }} />
      </div>
      <WebviewFrame tab={tab} forcedHeight={module.height} />
    </div>
  );
};

export default {
  type: 'webview',
  category: 'media',
  label: '웹뷰',
  description: 'HTML 인라인 또는 URL',
  icon: '',
  defaultValue: () => ({ type: 'webview', tabs: [{ type: 'url', content: '' }] }),
  FormView,
  PreviewView,
};
