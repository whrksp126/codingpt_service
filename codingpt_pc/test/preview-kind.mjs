// preview-kind — "이 파일을 무엇으로 열 것인가" 판정 계약.
//  기본값이 text 라는 것과, CSV 파싱이 따옴표를 지킨다는 것이 핵심이다.
import { previewKind, extOf, needsBytes, canFallBackToText, mimeOf, parseTable } from '../src/js/preview-kind.js';

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`);

// ── 판정 ────────────────────────────────────────────────────────────────────
eq(previewKind('README.md'), 'markdown', 'md → markdown');
eq(previewKind('logo.svg'), 'svg', 'svg → svg(그림+코드)');
eq(previewKind('shot.PNG'), 'image', '대문자 확장자도 이미지');
eq(previewKind('doc.pdf'), 'pdf', 'pdf');
eq(previewKind('data.csv'), 'table', 'csv → 표');
eq(previewKind('data.tsv'), 'table', 'tsv → 표');
eq(previewKind('package.json'), 'json', 'json → 트리');
eq(previewKind('voice.mp3'), 'audio', 'mp3');
eq(previewKind('clip.mp4'), 'video', 'mp4');
eq(previewKind('bundle.zip'), 'unsupported', 'zip → 안내');
eq(previewKind('font.woff2'), 'unsupported', '폰트 → 안내');
eq(previewKind('app.aab'), 'unsupported', '설치파일 → 안내');

// ★ 기본값이 text 라는 것 — 코드 파일이 압도적으로 많다.
eq(previewKind('index.tsx'), 'text', 'tsx → 텍스트');
eq(previewKind('Cargo.toml'), 'text', 'toml → 텍스트');
eq(previewKind('weird.qqq'), 'text', '모르는 확장자 → 텍스트(오판해서 편집을 막지 않는다)');
eq(previewKind('Makefile'), 'text', '확장자 없음 → 텍스트');
eq(previewKind('.gitignore'), 'text', '점으로 시작하는 이름은 확장자가 아니다');
eq(previewKind('.env.local'), 'text', '.env.local 도 텍스트');
eq(extOf('.gitignore'), '', '점 이름의 확장자는 빈 문자열');
eq(extOf('a/b/c.TS'), 'ts', '경로에서 확장자만·소문자로');

// ── 부수 규칙 ───────────────────────────────────────────────────────────────
ok(needsBytes('image') && needsBytes('pdf') && needsBytes('audio') && needsBytes('video'), '바이트가 필요한 종류');
ok(!needsBytes('markdown') && !needsBytes('table') && !needsBytes('json') && !needsBytes('svg'),
  '텍스트로 읽는 종류(svg 는 코드로도 봐야 하니 텍스트)');
ok(canFallBackToText('markdown') && canFallBackToText('svg') && canFallBackToText('table') && canFallBackToText('json'),
  '원문 보기가 되는 종류');
ok(!canFallBackToText('image') && !canFallBackToText('pdf'), '바이너리는 원문 보기를 막는다(깨진 글자뿐)');
eq(mimeOf('a.png'), 'image/png', 'mime png');
eq(mimeOf('a.svg'), 'image/svg+xml', 'mime svg');
eq(mimeOf('a.qqq'), 'application/octet-stream', '모르는 확장자 mime');

// ── CSV 파싱 ────────────────────────────────────────────────────────────────
eq(parseTable('a,b\n1,2').rows, [['a', 'b'], ['1', '2']], '기본 csv');
eq(parseTable('a\tb\n1\t2', 'tsv').rows, [['a', 'b'], ['1', '2']], 'tsv 는 탭으로');
// ★ 값 안의 쉼표 — 이걸 놓치면 열이 어긋나서 표가 통째로 쓸모없어진다.
eq(parseTable('name,memo\n"Kim, J",hi').rows, [['name', 'memo'], ['Kim, J', 'hi']], '따옴표 안 쉼표를 지킨다');
eq(parseTable('a\n"say ""hi"""').rows, [['a'], ['say "hi"']], '이중 따옴표 = 리터럴');
eq(parseTable('a,b\r\n1,2').rows, [['a', 'b'], ['1', '2']], 'CRLF');
eq(parseTable('a,b\n1,2\n').rows, [['a', 'b'], ['1', '2']], '끝 개행이 빈 행을 만들지 않는다');
ok(parseTable('x\n'.repeat(900), 'csv', 500).truncated === true, '상한을 넘으면 잘라내고 알린다');
eq(parseTable('x\n'.repeat(900), 'csv', 500).rows.length, 500, '상한만큼만 준다');
ok(parseTable('').rows.length === 0, '빈 파일은 빈 표');

console.log(`\n${fail ? 'FAILED' : 'ALL CONFORMANT'} — pass ${pass}, fail ${fail}`);
process.exit(fail ? 1 : 0);
