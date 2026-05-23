'use strict';

// 20260522010000 의 보강 — </p> 닫기 태그가 없는 <p ...>... <br> ... 케이스 처리.
// 다음 <p 시작 또는 문자열 끝까지를 inner 로 간주하고 그 안의 <br> 만 공백으로 치환.

const UNCLOSED_P_RE = /<p\b([^>]*)>((?:(?!<\/p>|<p\b)[\s\S])*)/gi;
const CLOSED_P_RE = /<p\b[^>]*>[\s\S]*?<\/p>/i;
const BR_RE = /<br\s*\/?\s*>/gi;

function stripBrUnclosedP(html) {
  if (typeof html !== 'string') return { html, changed: false };
  let changed = false;
  const replaced = html.replace(UNCLOSED_P_RE, (match, attrs, inner) => {
    // 이 match 가 닫기 태그를 가진 p 인 경우 — 이전 마이그레이션이 처리. 건드리지 않음.
    if (CLOSED_P_RE.test(match)) return match;
    if (!BR_RE.test(inner)) return match;
    BR_RE.lastIndex = 0;
    changed = true;
    return `<p${attrs}>${inner.replace(BR_RE, ' ')}`;
  });
  return { html: replaced, changed };
}

function processModule(m) {
  if (!m || m.type !== 'characterSpeechBubble') return { module: m, changed: false };
  let changedAny = false;
  const next = { ...m };

  if (Array.isArray(m.speeches)) {
    const newSpeeches = m.speeches.map((sp) => {
      if (!sp || typeof sp.content !== 'string') return sp;
      const { html, changed } = stripBrUnclosedP(sp.content);
      if (!changed) return sp;
      changedAny = true;
      return { ...sp, content: html };
    });
    if (changedAny) next.speeches = newSpeeches;
  }

  if (m.speech && typeof m.speech.content === 'string') {
    const { html, changed } = stripBrUnclosedP(m.speech.content);
    if (changed) {
      next.speech = { ...m.speech, content: html };
      changedAny = true;
    }
  }

  return { module: next, changed: changedAny };
}

function transformContents(contents) {
  if (!contents || !Array.isArray(contents.modules)) return { changed: false, contents };
  let changedAny = false;
  const newModules = contents.modules.map((m) => {
    const { module: next, changed } = processModule(m);
    if (changed) changedAny = true;
    return next;
  });
  if (!changedAny) return { changed: false, contents };
  return { changed: true, contents: { ...contents, modules: newModules } };
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [slides] = await queryInterface.sequelize.query(
      'SELECT id, contents FROM slide WHERE contents IS NOT NULL',
    );

    let converted = 0;
    let skipped = 0;
    for (const slide of slides) {
      const { changed, contents } = transformContents(slide.contents);
      if (!changed) {
        skipped++;
        continue;
      }
      await queryInterface.sequelize.query(
        'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
        { replacements: { id: slide.id, contents: JSON.stringify(contents) } },
      );
      converted++;
    }
    console.log(
      `[strip-br-inside-p-unclosed] inspected=${slides.length} converted=${converted} skipped=${skipped}`,
    );
  },

  async down() {
    throw new Error('비가역적 마이그레이션입니다. 롤백이 필요하면 db/backups/full_*.sql 로 복원하세요.');
  },
};
