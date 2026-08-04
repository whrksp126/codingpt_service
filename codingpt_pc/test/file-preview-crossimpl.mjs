// file-preview-crossimpl.mjs — 파일 미리보기의 **3플랫폼 일치**.
//
// 핵심 위험: 판정표(어떤 확장자를 무엇으로 열까)가 갈리는 것. 한쪽에서만 png 를 그림으로 열면
//  같은 파일이 기기마다 다르게 보인다. 그래서 **두 구현을 실제로 실행해 전 확장자를 대조**한다.
import fs from 'node:fs';
import path from 'node:path';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. 판정표를 양쪽 다 실행해 대조 ──────────────────────────────────────────
// 앱은 TS 라 **Node 의 타입 스트리핑으로 원본 그대로 실행**한다(정규식으로 타입을 벗기면
//  파일이 조금만 바뀌어도 깨져서 거짓 통과/실패를 낸다 — 집 규율).
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const SAMPLES = [
  'README.md', 'notes.markdown', 'logo.svg', 'a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp',
  'a.ico', 'a.avif', 'a.heic', 'spec.pdf', 'data.csv', 'data.tsv', 'package.json',
  'v.mp3', 'v.wav', 'v.m4a', 'v.aac', 'v.ogg', 'v.flac', 'c.mp4', 'c.mov', 'c.webm', 'c.m4v',
  'b.zip', 'b.tar', 'b.7z', 'x.exe', 'x.dylib', 'x.wasm', 'f.ttf', 'f.woff2', 'i.dmg', 'p.apk',
  'd.sqlite', 'd.psd', 'd.docx', 'd.xlsx', 'd.hwp',
  'index.tsx', 'main.rs', 'Cargo.toml', 'Makefile', '.gitignore', '.env.local', 'weird.qqq', 'no-ext',
];
const KINDS = ['text', 'markdown', 'image', 'svg', 'pdf', 'table', 'json', 'audio', 'video', 'unsupported'];
const CSV = 'name,memo\n"Kim, J","say ""hi"""\nb,c\n';

/** 한 구현을 실행해 판정 결과를 전부 뽑는다. modPath 는 .js 또는 .ts. */
function probe(modPath) {
  const script = `
    const m = await import(${JSON.stringify('file://' + modPath)});
    const out = {
      kinds: ${JSON.stringify(SAMPLES)}.map((f) => m.previewKind(f)),
      rules: ${JSON.stringify(KINDS)}.map((k) => [m.needsBytes(k), m.canFallBackToText(k), m.opensAsPreview(k)]),
      mime: ['a.png', 'a.pdf', 'a.svg', 'a.qqq'].map((f) => m.mimeOf(f)),
      table: m.parseTable(${JSON.stringify(CSV)}).rows,
    };
    console.log(JSON.stringify(out));
  `;
  const tmp = path.join(os.tmpdir(), 'pvprobe-' + Math.abs(modPath.length * 7919) + '.mjs');
  fs.writeFileSync(tmp, script);
  try {
    return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', tmp], { encoding: 'utf8' }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
}

const pcOut = probe(path.join(PC, 'preview-kind.js'));
const appOut = probe(path.join(APP, 'workspace/ide/previewKind.ts'));

const kindDiff = SAMPLES.map((f, i) => [f, appOut.kinds[i], pcOut.kinds[i]]).filter(([, a, p]) => a !== p);
ok(kindDiff.length === 0, `확장자 ${SAMPLES.length}종 판정 일치`,
  kindDiff.map(([f, a, p]) => `${f}: app=${a} pc=${p}`).join(' | '));
ok(JSON.stringify(appOut.rules) === JSON.stringify(pcOut.rules), `부수 규칙 ${KINDS.length}종 일치`);
ok(JSON.stringify(appOut.mime) === JSON.stringify(pcOut.mime), 'mime 일치');
// ★ CSV 파싱 — 값 안의 쉼표를 한쪽만 놓치면 표가 어긋난다.
ok(JSON.stringify(appOut.table) === JSON.stringify(pcOut.table),
  'CSV 파싱 결과 일치(따옴표 안 쉼표 포함)', JSON.stringify(appOut.table));
// 실제로 그 까다로운 값이 한 칸으로 들어갔는지도 본다(양쪽이 똑같이 틀렸을 수 있다).
ok(pcOut.table[1] && pcOut.table[1][0] === 'Kim, J' && pcOut.table[1][1] === 'say "hi"',
  '따옴표 규칙이 실제로 맞다', JSON.stringify(pcOut.table));

// ── 2. 문구 사전 대조 ───────────────────────────────────────────────────────
const pcText = await import(path.join(PC, 'text/file-preview.js'));
const appSrc = read(path.join(APP, 'text/filePreview.ts'));
const appDict = (await import('data:text/javascript,' + encodeURIComponent(
  appSrc.slice(appSrc.indexOf('export const FILE_PREVIEW_TEXT'))
    .replace('export const FILE_PREVIEW_TEXT: Dict<FilePreviewText> =', 'export const FILE_PREVIEW_TEXT =')))).FILE_PREVIEW_TEXT;
for (const lang of ['ko', 'en']) {
  const a = appDict[lang], p = pcText.FILE_PREVIEW_TEXT[lang];
  const aK = Object.keys(a).sort(), pK = Object.keys(p).sort();
  ok(JSON.stringify(aK) === JSON.stringify(pK), `문구 키 일치(${lang}) — ${aK.length}개`);
  const d = pK.filter((k) => a[k] !== p[k]);
  ok(d.length === 0, `문구 값 일치(${lang})`, d.join(', '));
}

// ── 3. 화면 규율 ────────────────────────────────────────────────────────────
const pcIde = strip(read(path.join(PC, 'ide.js')));
ok(/previewHost/.test(pcIde), 'PC 는 에디터를 없애지 않고 형제로 둔다');
ok(/PV\.canFallBackToText\(K\.kind\)/.test(pcIde), 'PC: 원문 보기는 되돌릴 수 있는 종류에만');
const appPv = strip(read(path.join(APP, 'workspace/ide/FilePreview.tsx')));
ok(/PV\.canFallBackToText\(data\.kind\)/.test(appPv), '앱: 원문 보기는 되돌릴 수 있는 종류에만');
ok(/Platform\.OS !== 'ios'[\s\S]{0,80}notOnThisDevice/.test(appPv),
  '앱: 안드로이드 PDF 는 빈 화면 대신 사실을 말한다');
const appIde = strip(read(path.join(APP, 'workspace/IdeBody.tsx')));
ok(/PV\.needsBytes\(kind\)/.test(appIde), '앱: 바이트가 필요한 종류만 base64 로 읽는다');
ok(/\.\.\.\(c\[rel\] \|\| \{\}\)/.test(appIde), '앱: 편집해도 미리보기 상태를 잃지 않는다');

console.log(`\n${fail ? 'FAILED' : 'ALL CONFORMANT'} — pass ${pass}, fail ${fail}`);
process.exit(fail ? 1 : 0);
