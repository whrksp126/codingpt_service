// 파일을 무엇으로 열 것인가 — 확장자 → 표시 방식(순수 판정).
//
// PC 와 앱이 **같은 표를 써야 한다**(대조 테스트가 걸려 있다). 한쪽에서만 png 를 그림으로 열면
//  같은 파일이 기기마다 다르게 보인다.
//
// 규율:
//  · 기본값은 **text** 다. 코드 파일이 압도적으로 많고, 모르는 확장자를 그림/바이너리로 오판하면
//    편집이 막힌다. 확실한 것만 표에 올린다.
//  · 'unsupported' 는 "미리보기를 지원하지 않는다"이지 "못 연다"가 아니다 — 화면은 안내와 함께
//    **텍스트로 열기** 를 항상 남긴다(사용자 확정: 깨진 글자를 쏟아붓지 않는다).
//  · svg 는 그림이면서 코드다 → 그림으로 열되 토글을 둔다(kind='svg' 가 그 신호).

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac']);
const VIDEO = new Set(['mp4', 'mov', 'webm', 'm4v']);
const TABLE = new Set(['csv', 'tsv']);
const MARKDOWN = new Set(['md', 'markdown']);
// 미리보기를 지원하지 않는다고 **분명히 말해 줄** 확장자. 여기 없는 모르는 확장자는 text 로 연다
//  (대개 코드/설정 파일이다). 아카이브·실행파일·폰트·디스크이미지처럼 텍스트로 열면 화면이
//  깨지는 것만 올린다.
const UNSUPPORTED = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'tar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'wasm', 'pyc',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'dmg', 'iso', 'img', 'apk', 'aab', 'ipa', 'pkg', 'deb', 'rpm',
  'sqlite', 'db', 'mdb', 'realm',
  'psd', 'ai', 'sketch', 'fig', 'xd', 'blend',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx',
]);

/** 파일명 → 확장자(소문자, 점 제외). 확장자가 없으면 ''. */
export function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  // 점으로 시작하는 이름(.gitignore)은 확장자가 아니라 이름이다 — 텍스트로 연다.
  if (i <= 0) return '';
  return base.slice(i + 1).toLowerCase();
}

/**
 * 표시 방식.
 *  'text' | 'markdown' | 'image' | 'svg' | 'pdf' | 'table' | 'json' | 'audio' | 'video' | 'unsupported'
 */
export function previewKind(name) {
  const e = extOf(name);
  if (!e) return 'text';
  if (MARKDOWN.has(e)) return 'markdown';
  if (e === 'svg') return 'svg';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (TABLE.has(e)) return 'table';
  if (e === 'json') return 'json';
  if (AUDIO.has(e)) return 'audio';
  if (VIDEO.has(e)) return 'video';
  if (UNSUPPORTED.has(e)) return 'unsupported';
  return 'text';
}

/** 이 방식이 **원본 바이트**(base64)를 필요로 하는가. 나머지는 텍스트로 읽는다. */
export function needsBytes(kind) {
  return kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video';
}

/** 기본이 미리보기인가(= 열자마자 미리보기). svg 는 그림으로 열되 토글이 있다. */
export function opensAsPreview(kind) {
  return kind !== 'text';
}

/** 미리보기에서 텍스트로 되돌릴 수 있는가. 바이너리는 되돌려도 깨진 글자뿐이라 막는다. */
export function canFallBackToText(kind) {
  return kind === 'markdown' || kind === 'svg' || kind === 'table' || kind === 'json';
}

/** data: URI — 이미지·PDF·미디어를 화면에 물릴 때 쓴다. */
export function dataUri(name, base64) {
  return `data:${mimeOf(name)};base64,${base64}`;
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4',
};

export function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

/**
 * CSV/TSV 파싱(따옴표 규칙 포함). 표는 **행/열이 어긋나면 쓸모가 없다** — 쉼표가 값 안에 들어간
 *  경우를 반드시 처리한다.
 *  maxRows 를 넘으면 잘라내고 truncated 로 알린다(수만 줄짜리 데이터로 화면을 죽이지 않는다).
 */
export function parseTable(text, ext = 'csv', maxRows = 500) {
  const sep = ext === 'tsv' ? '\t' : ',';
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const s = String(text || '');
  let truncated = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }  // "" = 리터럴 따옴표
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === sep) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= maxRows) { truncated = i < s.length - 1; break; }
      continue;
    }
    field += c;
  }
  if (!truncated && (field !== '' || row.length)) { row.push(field); rows.push(row); }
  return { rows, truncated };
}
