import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-python';

export const PRISM_LANG_MAP = {
  html: 'markup',
  markup: 'markup',
  css: 'css',
  javascript: 'javascript',
  js: 'javascript',
  java: 'java',
  python: 'python',
};

export const SUPPORTED_LANGUAGES = [
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
];

// DB 기존 데이터와 정확히 동일한 input 마커 형식.
export const blankInputTemplate = (n) =>
  `<input id="blank-${n}" type="text" class="blank focus" value="" size="1" oninput="this.size = this.value.length || 1" onclick="console.log(event)" readOnly />`;

const escapeHtml = (str) =>
  String(str || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const safeHighlight = (code, language) => {
  const lang = PRISM_LANG_MAP[language] || 'markup';
  const grammar = Prism.languages[lang] || Prism.languages.markup;
  try {
    return Prism.highlight(code || '', grammar, lang);
  } catch {
    return escapeHtml(code);
  }
};

// blanks 배열을 plainCode 좌→우 순서로 정렬하고 id를 0..N-1로 재부여한다.
// answers/options 배열이 함께 전달되면 blanks 순서에 맞춰 같이 재정렬해서 반환.
export const reorderBlanks = (blanks, answers) => {
  const indexed = blanks.map((b, i) => ({ blank: b, originalIndex: i }));
  indexed.sort((a, b) => a.blank.start - b.blank.start);
  const nextBlanks = indexed.map(({ blank }, i) => ({
    ...blank,
    id: `blank-${i}`,
  }));
  const nextAnswers = answers
    ? indexed.map(({ originalIndex }) =>
      answers[originalIndex] || { userAnswer: null, correctAnswer: '', isCorrect: null })
    : null;
  return { blanks: nextBlanks, answers: nextAnswers };
};

// plainCode + blanks 정보를 토대로 DB content (Prism 토큰 HTML + input 마커)를 합성한다.
// blanks는 reorderBlanks로 미리 정리된 상태(좌→우 순서, id=0..N-1)라고 가정.
//
// 전략: plainCode에 blank 위치마다 sentinel 문자열을 끼운 뒤 Prism.highlight 후
// sentinel을 input 마커로 정규식 치환. sentinel은 알파벳 식별자 형태로
// 어떤 언어 tokenizer에서도 단일 토큰으로 처리되도록 설계.
export const composeContent = (plainCode, language, blanks) => {
  if (!plainCode) return '';
  const safeBlanks = Array.isArray(blanks) ? blanks : [];

  // 위치가 큰 것부터 sentinel 삽입 (앞쪽 offset 보존)
  const descending = safeBlanks
    .map((b, i) => ({ blank: b, idx: i }))
    .sort((a, b) => b.blank.start - a.blank.start);

  let modified = plainCode;
  for (const { blank, idx } of descending) {
    const sentinel = `ZZBLANKMARKER${idx}MARKERZZ`;
    modified = modified.slice(0, blank.start) + sentinel + modified.slice(blank.end);
  }

  let highlighted = safeHighlight(modified, language);

  for (let i = 0; i < safeBlanks.length; i++) {
    // span으로 감싸진 경우와 그냥 텍스트인 경우 모두 매칭
    const sentinelRe = new RegExp(`(<span[^>]*>)?ZZBLANKMARKER${i}MARKERZZ(<\\/span>)?`, 'g');
    highlighted = highlighted.replace(sentinelRe, blankInputTemplate(i));
  }

  return highlighted;
};

// DB content (token HTML + input 마커)에서 plainCode + blanks를 역추출.
// answers 배열을 같이 받아서 input 마커 위치에 정답 텍스트를 다시 채워 plainCode 복원.
export const decomposeContent = (content, answers = []) => {
  if (!content) return { plainCode: '', blanks: [] };
  const div = document.createElement('div');
  div.innerHTML = content;

  let plainCode = '';
  const blanks = [];

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      plainCode += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const isBlankInput =
      node.tagName === 'INPUT' &&
      (node.classList?.contains('blank') || /^blank-\d+$/.test(node.id || ''));

    if (isBlankInput) {
      const idMatch = (node.id || '').match(/^blank-(\d+)$/);
      const blankIndex = idMatch ? parseInt(idMatch[1], 10) : blanks.length;
      const correctAnswer = answers[blankIndex]?.correctAnswer || '';
      const start = plainCode.length;
      plainCode += correctAnswer;
      blanks.push({
        id: `blank-${blanks.length}`,
        start,
        end: plainCode.length,
        correctAnswer,
      });
      return;
    }

    for (const child of node.childNodes) walk(child);
  };

  for (const child of div.childNodes) walk(child);

  // 좌→우 정렬 + id 재부여 (이미 좌→우지만 명시적으로)
  const reordered = reorderBlanks(blanks, null);
  return { plainCode, blanks: reordered.blanks };
};

// 캔버스/Inspector 미리보기용 다크 테마 HTML — 모바일 assembleCodeHtml 과 같은 톤.
// 어드민 프리뷰 전용으로 input 마커에 #N 인덱스 배지를 주입한다 (DB content 자체는 변경하지 않음).
//
// iframe sandbox 가 allow-scripts 없이 돌아가므로 input 의 inline event handler(oninput=/onclick=) 는
// 차단되며 콘솔 경고를 띄움. 미리보기에서는 어차피 readOnly + pointer-events:none 이라 핸들러 불필요 →
// 합성 후 on* 속성 모두 제거.
export const previewHtml = (plainCode, language, blanks) => {
  const composed = composeContent(plainCode, language, blanks);
  const withWrap = composed.replace(
    /<input id="blank-(\d+)"([^>]*?)\s*\/?>/g,
    (_match, n, rest) => `<span class="blank-wrap"><span class="blank-index">#${n}</span><input id="blank-${n}"${rest} /></span>`,
  );
  const body = withWrap.replace(/\s+on\w+="[^"]*"/g, '');
  return `<!DOCTYPE html><html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://cdn.jsdelivr.net/npm/prismjs/themes/prism-okaidia.css" rel="stylesheet" />
  <style>
    body { font-family: 'Menlo','Monaco','Courier New',monospace; font-size:14px; font-weight:bold; line-height:1.6; margin:0; padding:10px; background:#0A0D14; }
    pre { margin:0; white-space:pre-wrap; word-break:break-all; color:#fff; overflow-x:auto; }
    input.blank { display:inline-block; min-width:60px; height:24px; padding:0; margin:2px; border-radius:4px; border:1.5px dashed #E1E6EF; background:#fff; color:#06B6D4; font-weight:700; text-align:center; vertical-align:middle; outline:none; pointer-events:none; }
    input.blank.focus { background:#fff; border:1.5px dashed #84D8FF; }
    .blank-wrap { position:relative; display:inline-block; vertical-align:middle; }
    .blank-index { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#06B6D4; font-family:'Menlo','Monaco',monospace; font-size:12px; font-weight:700; letter-spacing:0.2px; pointer-events:none; user-select:none; z-index:2; }
  </style></head><body><pre><code>${body || '// 코드를 입력하고 텍스트를 드래그해 빈칸을 만드세요'}</code></pre></body></html>`;
};

// plainCode가 변경됐을 때 기존 blanks의 [start, end] 범위가 여전히 correctAnswer 와 일치하는지 검증.
// 깨진 blank는 invalid: true 로 마킹.
export const validateBlanks = (plainCode, blanks) => blanks.map((b) => {
  const slice = (plainCode || '').slice(b.start, b.end);
  return slice === b.correctAnswer ? { ...b, invalid: false } : { ...b, invalid: true };
});
