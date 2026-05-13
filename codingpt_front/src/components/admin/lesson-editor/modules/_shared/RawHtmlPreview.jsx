import './rnHtml.css';

const TOKEN_RE = /\{\{userAnswer_(\d+)\}\}/g;

// {{userAnswer_N}} 토큰을 #N 텍스트로만 표시 (실제 토큰 텍스트는 숨김). 어드민 프리뷰 전용.
// 색상은 모듈 추가 버튼(cyan-500) 계열과 통일 — 배경 없이 텍스트 컬러로만 강조.
const tokenizeHtml = (raw) => (
  (raw || '').replace(TOKEN_RE, (_m, n) => (
    `<span style="color:#06B6D4;font-family:Menlo,Monaco,monospace;font-weight:700;">#${n}</span>`
  ))
);

const RawHtmlPreview = ({ html, className = '', tokenize = false }) => {
  if (!html) return null;
  const content = tokenize ? tokenizeHtml(html) : html;
  return (
    <div
      className={'rn-html ' + className}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
};

export default RawHtmlPreview;
