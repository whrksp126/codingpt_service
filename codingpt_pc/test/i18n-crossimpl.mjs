// i18n-crossimpl — 다국어 카탈로그의 **PC ↔ 앱 일치**와 자리표시자 안전을 고정한다.
//
// 이 기능이 조용히 망가지는 방식은 셋이다:
//  ① 같은 문장이 기기마다 다른 말을 한다(정본을 안 거치고 손으로 고친 경우).
//  ② 자리표시자(`{n}`)가 번역에서 사라진다 → 화면에 "파일 개" 처럼 숫자가 빠진 문장이 나온다.
//  ③ 언어별로 키 집합이 어긋난다 → 어떤 언어에서만 원문(한국어)이 튀어나온다.
// 셋 다 **한국어로 쓰는 개발자에게는 영원히 안 보인다**. 그래서 여기서 못박는다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PC = path.resolve('src/js');
const APP = path.resolve('../../codingpt_app/src');
const MASTER = path.resolve('../../codingpt_app/i18n/master.json');

let pass = 0, fail = 0;
const ok = (c, n, e) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (e ? '  ' + e : '')); } };

const LANGS = ['ko', 'en', 'ja', 'zh-CN', 'es', 'de', 'fr'];

// ── 1. 두 런타임이 같은 규칙인가 ─────────────────────────────────────────────
const pcI18n = await import(path.join(PC, 'i18n/index.js'));
const appProbe = (() => {
  const tmp = path.join(process.env.TMPDIR || '/tmp', `i18nprobe-${process.pid}.mjs`);
  fs.writeFileSync(tmp, `
    const m = await import(${JSON.stringify('file://' + path.join(APP, 'i18n/index.ts'))});
    const out = { langs: m.LANGS, labels: m.LANG_LABELS, match: {}, t: {} };
    for (const raw of ['ko-KR','ko','ja_JP','zh-Hans-CN','zh-Hant-TW','zh-TW','es-419','de','fr-CA','en-US','','xx','pt-BR'])
      out.match[raw] = m.matchDeviceLang(raw);
    m.setLangRuntime('en');
    out.t.plain = m.t('취소');
    out.t.vars = m.t('코멘트 {n}개', { n: 3 });
    out.t.missingVar = m.t('코멘트 {n}개', {});
    out.t.unknown = m.t('이 문장은 사전에 없다');
    m.setLangRuntime('없는언어');
    out.t.fallbackLang = m.t('취소');
    console.log(JSON.stringify(out));
  `);
  try {
    return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', tmp], { encoding: 'utf8' }));
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* noop */ } }
})();

ok(JSON.stringify(appProbe.langs) === JSON.stringify(pcI18n.LANGS), '지원 언어 목록이 같다', appProbe.langs.join(','));
ok(JSON.stringify(appProbe.labels) === JSON.stringify(pcI18n.LANG_LABELS), '언어 이름표가 같다');

for (const raw of Object.keys(appProbe.match)) {
  ok(appProbe.match[raw] === pcI18n.matchDeviceLang(raw),
    `기기 언어 판정이 같다: ${JSON.stringify(raw)} → ${appProbe.match[raw]}`,
    `pc=${pcI18n.matchDeviceLang(raw)}`);
}
// 번체 중국어를 간체로 떨어뜨리지 않는다(글자가 아예 다르다 — 사용자에게는 "깨진 화면"이다).
ok(appProbe.match['zh-Hant-TW'] !== 'zh-CN' && appProbe.match['zh-TW'] !== 'zh-CN',
  '★ 중국어 번체를 간체로 떨어뜨리지 않는다', appProbe.match['zh-TW']);
// 모르는 언어를 한국어로 주지 않는다(그건 우리 기본값이지 사용자를 위한 선택이 아니다).
ok(appProbe.match.xx === 'en' && appProbe.match['pt-BR'] === 'en', '모르는 언어는 영어로 떨어진다');

pcI18n.setLangRuntime('en');
ok(appProbe.t.plain === pcI18n.t('취소'), 't() 결과가 같다(단순 문장)', `${appProbe.t.plain} / ${pcI18n.t('취소')}`);
ok(appProbe.t.vars === pcI18n.t('코멘트 {n}개', { n: 3 }), 't() 결과가 같다(자리표시자)', appProbe.t.vars);
ok(/\{n\}/.test(appProbe.t.missingVar) && /\{n\}/.test(pcI18n.t('코멘트 {n}개', {})),
  '★ 값이 없는 자리표시자는 지우지 않고 그대로 둔다(문장이 망가지는 것보다 낫다)', appProbe.t.missingVar);
ok(appProbe.t.unknown === '이 문장은 사전에 없다', '★ 사전에 없으면 원문(한국어)을 돌려준다 — 빈 문자열 금지');
pcI18n.setLangRuntime('없는언어');
ok(appProbe.t.fallbackLang === '취소' && pcI18n.t('취소') === '취소', '모르는 언어를 넣으면 한국어로 떨어진다');

// ── 2. 카탈로그 — 정본 한 벌에서 나왔는가 ────────────────────────────────────
const master = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
const appCat = {};
const pcCat = {};
for (const lang of LANGS) {
  appCat[lang] = (await import('data:text/javascript,' + encodeURIComponent(
    fs.readFileSync(path.join(APP, `i18n/${lang}.ts`), 'utf8')
      .replace('const CATALOG: Record<string, string> =', 'const CATALOG =')))).default;
  pcCat[lang] = (await import(path.join(PC, `i18n/${lang}.js`))).default;
}

// 언어마다 키 집합이 같아야 한다 — 아니면 그 언어에서만 원문이 튀어나온다.
const appKeys = Object.keys(appCat.ko).sort();
const pcKeys = Object.keys(pcCat.ko).sort();
for (const lang of LANGS) {
  ok(JSON.stringify(Object.keys(appCat[lang]).sort()) === JSON.stringify(appKeys), `앱 ${lang} 키 집합이 ko 와 같다`);
  ok(JSON.stringify(Object.keys(pcCat[lang]).sort()) === JSON.stringify(pcKeys), `PC ${lang} 키 집합이 ko 와 같다`);
}
ok(appKeys.length > 700 && pcKeys.length > 500, `카탈로그가 비어 있지 않다(앱 ${appKeys.length} · PC ${pcKeys.length})`);

// ★ 겹치는 문장은 **글자까지 같아야** 한다. 같은 버튼이 기기마다 다른 말을 하면 안 된다.
const shared = appKeys.filter((k) => pcCat.ko[k] !== undefined);
ok(shared.length > 200, `앱·PC 가 공유하는 문장이 ${shared.length}개`);
for (const lang of LANGS) {
  const diff = shared.filter((k) => appCat[lang][k] !== pcCat[lang][k]);
  ok(diff.length === 0, `★ 공유 문장의 ${lang} 번역이 앱·PC 에서 같다`,
    diff.slice(0, 3).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(appCat[lang][k])} vs ${JSON.stringify(pcCat[lang][k])}`).join(' | '));
}

// 카탈로그는 정본에서 나온다 — 손으로 고친 값이 섞이면 다음 재생성 때 조용히 사라진다.
for (const lang of LANGS.filter((l) => l !== 'ko')) {
  const stray = appKeys.filter((k) => appCat[lang][k] && master[k] && master[k][lang] !== appCat[lang][k]);
  ok(stray.length === 0, `앱 ${lang} 카탈로그가 정본과 일치한다(직접 수정 금지)`, stray.slice(0, 3).join(' | '));
}

// ── 3. 자리표시자 — 번역에서 사라지면 화면이 깨진다 ──────────────────────────
const PLACEHOLDER = /\{(\w+)\}/g;
const bad = [];
for (const k of appKeys) {
  const want = [...new Set([...k.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
  if (!want.length) continue;
  for (const lang of LANGS) {
    const v = appCat[lang][k];
    if (!v) continue;
    const got = [...new Set([...v.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${lang} ${JSON.stringify(k)} → ${JSON.stringify(v)}`);
  }
}
ok(bad.length === 0, '★ 모든 번역이 원문과 같은 자리표시자를 갖는다', bad.slice(0, 4).join(' | '));

// ── 4. 사전(text/*)에 en 반쪽이 남아 있지 않다 ───────────────────────────────
// 두 메커니즘이 공존하면 "어디를 고쳐야 하는가"가 사람마다 달라진다.
const textDicts = fs.readdirSync(path.join(PC, 'text')).filter((f) => f.endsWith('.js') && f !== 'index.js');
const leftovers = [];
for (const f of textDicts) {
  const src = fs.readFileSync(path.join(PC, 'text', f), 'utf8');
  if (/^\s*en:\s*\{/m.test(src) || /^\s*"en":\s*\{/m.test(src)) leftovers.push(f);
}
ok(leftovers.length === 0, 'text/* 사전에 en 반쪽이 남아 있지 않다', leftovers.join(','));

console.log(`\n${fail === 0 ? 'ALL CONFORMANT' : 'NOT CONFORMANT'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
