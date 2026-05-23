'use strict';

// characterSpeechBubble 모듈의 speeches[*].content 와 speech.content 안에서
// <p>…</p> 내부에 들어있는 <br> 태그를 공백 하나로 치환한다.
// RN(react-native-render-html)은 <p> 내부 <br> 을 정상 렌더하지 못한다.
//
// p 외부에 있는 <br> 은 건드리지 않는다.
// idempotent: 이미 처리된 데이터는 p 안에 <br> 이 없으므로 no-op.

const P_RE = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
const BR_RE = /<br\s*\/?\s*>/gi;

function stripBrInsideP(html) {
  if (typeof html !== 'string') return { html, changed: false };
  let changed = false;
  const replaced = html.replace(P_RE, (match, attrs, inner) => {
    if (!BR_RE.test(inner)) return match;
    BR_RE.lastIndex = 0;
    changed = true;
    const cleanedInner = inner.replace(BR_RE, ' ');
    return `<p${attrs}>${cleanedInner}</p>`;
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
      const { html, changed } = stripBrInsideP(sp.content);
      if (!changed) return sp;
      changedAny = true;
      return { ...sp, content: html };
    });
    if (changedAny) next.speeches = newSpeeches;
  }

  if (m.speech && typeof m.speech.content === 'string') {
    const { html, changed } = stripBrInsideP(m.speech.content);
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
      `[strip-br-inside-p-character-bubbles] inspected=${slides.length} converted=${converted} skipped=${skipped}`,
    );
  },

  async down() {
    throw new Error('비가역적 마이그레이션입니다. 롤백이 필요하면 db/backups/full_*.sql 로 복원하세요.');
  },
};
