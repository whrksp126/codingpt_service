import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';

const MonacoField = ({ value, onChange, language = 'html', height = 160, readOnly = false, onReady, disableAutoFormat = false }) => {
  const containerRef = useRef(null);
  const editorRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  onChangeRef.current = onChange;
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!containerRef.current) return undefined;
    editorRef.current = monaco.editor.create(containerRef.current, {
      value: value || '',
      language,
      theme: 'vs',
      readOnly,
      automaticLayout: true,
      fontSize: 12,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      lineNumbersMinChars: 2,
      glyphMargin: false,
      folding: false,
      wordWrap: 'on',
      renderLineHighlight: 'none',
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });
    const sub = editorRef.current.onDidChangeModelContent(() => {
      onChangeRef.current(editorRef.current.getValue());
    });
    let blurSub = null;
    let initTimer = null;
    if (!disableAutoFormat) {
      blurSub = editorRef.current.onDidBlurEditorText(() => {
        editorRef.current?.getAction('editor.action.formatDocument')?.run().catch(() => {});
      });
      // 초기 포맷팅 — Monaco의 HTML formatter 워커가 준비되는 데 시간이 걸려 약간 딜레이
      initTimer = setTimeout(() => {
        editorRef.current?.getAction('editor.action.formatDocument')?.run().catch(() => {});
      }, 300);
    }
    if (typeof onReadyRef.current === 'function') {
      onReadyRef.current(editorRef.current);
    }
    return () => {
      if (initTimer) clearTimeout(initTimer);
      sub.dispose();
      if (blurSub) blurSub.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editorRef.current) return;
    if (editorRef.current.getValue() !== (value || '')) {
      editorRef.current.setValue(value || '');
    }
  }, [value]);

  useEffect(() => {
    if (!editorRef.current) return;
    monaco.editor.setModelLanguage(editorRef.current.getModel(), language);
  }, [language]);

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded border border-slate-200"
      style={{ height }}
    />
  );
};

export default MonacoField;
