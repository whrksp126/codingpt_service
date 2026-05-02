import React, { useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/themes/prism.css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-markup';

const Admin = () => {
  const [language, setLanguage] = useState('html');
  const [code, setCode] = useState('<h1>환영합니다</h1>\n<p>HTML은 구조를 만듭니다.</p>\n<img src="example.jpg" alt="예시 이미지">\n<button>클릭해보세요</button>');
  const [editMode, setEditMode] = useState(false);
  const [customHighlighted, setCustomHighlighted] = useState('');

  const languageMap = {
    html: 'markup',
    css: 'css',
    js: 'javascript',
  };
  const highlightedCode = Prism.highlight(code, Prism.languages[languageMap[language]], languageMap[language]);

  // 수정 모드 진입 시, Prism이 만든 HTML을 기본값으로 세팅
  const handleEditModeToggle = () => {
    if (!editMode) {
      setCustomHighlighted(highlightedCode);
    }
    setEditMode((prev) => !prev);
  };

  // 수정 모드에서 직접 입력한 HTML을 상태로 관리
  const handleCustomHighlightedChange = (e) => {
    setCustomHighlighted(e.target.value);
  };

  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: 24, fontFamily: 'Pretendard, sans-serif', background: '#f8fafc', borderRadius: 16, boxShadow: '0 4px 24px rgba(0,0,0,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: '#222', margin: 0 }}>Admin 코드 에디터</h1>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          style={{ marginLeft: 24, padding: '6px 14px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 16, fontWeight: 500, background: '#fff', color: '#222', cursor: 'pointer' }}
        >
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="js">JavaScript</option>
        </select>
        <button
          onClick={handleEditModeToggle}
          style={{ marginLeft: 'auto', padding: '8px 18px', borderRadius: 8, border: 'none', background: editMode ? '#f59e42' : '#0ea5e9', color: '#fff', fontWeight: 600, fontSize: 16, cursor: 'pointer', transition: 'background 0.2s' }}
        >
          {editMode ? '수정 모드 종료' : '수정 모드'}
        </button>
      </div>
      <section style={{ background: '#fff', borderRadius: 12, padding: 24, marginBottom: 32, boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
        <label style={{ fontWeight: 600, fontSize: 18, color: '#333' }}>
          코드 입력
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={4}
            cols={60}
            style={{
              display: 'block',
              marginTop: 12,
              width: '100%',
              fontSize: 16,
              fontFamily: 'Fira Mono, Menlo, monospace',
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              padding: 14,
              background: '#f1f5f9',
              color: '#222',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </label>
      </section>
      <section style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320, background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.03)', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ fontSize: 20, fontWeight: 600, color: '#16a34a', margin: 0 }}>코드 에디터용 HTML</h3>
            <button
              onClick={() => {
                // 컨트롤 + C와 같이 복사 기능을 수행합니다.
                const textarea = document.createElement('textarea');
                textarea.value = JSON.stringify(customHighlighted);
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
              }}
              style={{
                marginLeft: 'auto',
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: '#e2e8f0',
                color: '#222',
                fontWeight: 500,
                fontSize: 14,
                cursor: 'pointer',
                transition: 'background 0.2s',
                marginRight: 0,
              }}
              title="복사"
            >
              복사
            </button>
          </div>
          {editMode ? (
            <textarea
              value={customHighlighted}
              onChange={handleCustomHighlightedChange}
              rows={8}
              style={{
                width: '100%',
                fontSize: 15,
                fontFamily: 'Fira Mono, Menlo, monospace',
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                padding: 14,
                background: '#f1f5f9',
                color: '#222',
                resize: 'vertical',
                boxSizing: 'border-box',
                minHeight: 120,
              }}
            />
          ) : (
            <pre style={{ background: '#f5f5f5', color: '#222', padding: '1rem', borderRadius: '8px', overflowX: 'auto', fontSize: 15, fontFamily: 'Fira Mono, Menlo, monospace' }}>
              <code>{highlightedCode}</code>
            </pre>
          )}
        </div>
      </section>
      <section style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320, background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.03)', position: 'relative' }}>
          <h3 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16, color: '#0ea5e9' }}>Prism.js 코드 에디터 화면</h3>
          {/* 코드 에디터 화면에만 적용되는 스타일 */}
          {/* 
            <input id="option-0" type="text" class="blank"  value=""  size="1" oninput="this.size = this.value.length || 1" onclick="console.log(event)" readOnly /> 
          */}
          <style>{`
            .blank {
              width: auto;
              padding: 0 8px 0;
              color: #4B4B4B;
              background: #fff;
              border-radius: 6px;
              border: 1px solid #E5E5E5;
              outline: none;
            }
            .blank.focus {
              background: #DDF4FF;
              border: 1px solid #84D8FF;
            }
          `}</style>
          <div className="">
            <pre style={{ background: '#222', color: '#fff', padding: '1rem', borderRadius: '8px', overflowX: 'auto', fontSize: 15, fontFamily: 'Fira Mono, Menlo, monospace', margin: 0 }}>
              <code dangerouslySetInnerHTML={{ __html: editMode ? customHighlighted : highlightedCode }} />
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}

export default Admin;
