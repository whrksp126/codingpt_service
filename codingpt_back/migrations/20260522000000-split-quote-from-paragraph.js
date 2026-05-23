'use strict';

// 모든 slide.contents.modules 중 type='paragraph' 이고 content 가 정확히 한 번의
// <div class="callout-box">…</div> 로 감싸진 모듈을 새 type='quote' 모듈로 변환한다.
//
// 변환 후 paragraph 전용 필드(icon, iconHidden, tts)는 제거.
// 매칭되지 않지만 content 에 callout-box 가 존재하는 케이스는 변환하지 않고 로그로 출력.
//
// idempotent: 두 번 실행해도 두 번째에서는 type='paragraph' 의 callout-box 가 없으므로 no-op.
//
// !! 베이스라인 백업 권장 !!
//   docker exec codingpt_postgres_local pg_dump -U codingpt -d codingpt_db \
//     --no-owner --no-privileges > codingpt_service/db/backups/full_$(date +%Y%m%d).sql

// class 안에 callout-box 와 (선택적으로) 다른 클래스가 함께 들어있는 패턴까지 허용.
const CALLOUT_RE = /^\s*<div\s+class\s*=\s*(?:"|')([^"']*\bcallout-box\b[^"']*)(?:"|')\s*>([\s\S]*?)<\/div>\s*$/i;
const HAS_CALLOUT_RE = /<div\s+class\s*=\s*(?:"|')[^"']*\bcallout-box\b/i;

function transformParagraphToQuote(contents, slideId, unconvertedLog) {
  if (!contents || !Array.isArray(contents.modules)) return { changed: false, contents };

  let changedAny = false;
  const newModules = contents.modules.map((m) => {
    if (!m || m.type !== 'paragraph' || typeof m.content !== 'string') return m;

    const match = CALLOUT_RE.exec(m.content);
    if (!match) {
      if (HAS_CALLOUT_RE.test(m.content)) {
        unconvertedLog.push({ slideId, moduleId: m.id, reason: 'callout-box 존재하나 단일 래핑 아님' });
      }
      return m;
    }

    const classAttr = match[1];
    const inner = match[2];
    if (HAS_CALLOUT_RE.test(inner)) {
      unconvertedLog.push({ slideId, moduleId: m.id, reason: 'callout-box 중첩' });
      return m;
    }

    // class에 callout-box 외 다른 클래스가 있으면 inner를 그 클래스들로 다시 감싸 시각 유지.
    const extraClasses = classAttr
      .split(/\s+/)
      .filter((c) => c && c !== 'callout-box')
      .join(' ');
    const newContent = extraClasses
      ? `<div class="${extraClasses}">${inner.trim()}</div>`
      : inner.trim();

    changedAny = true;
    const next = { ...m, type: 'quote', content: newContent };
    delete next.icon;
    delete next.iconHidden;
    delete next.tts;
    return next;
  });

  if (!changedAny) return { changed: false, contents };
  return { changed: true, contents: { ...contents, modules: newModules } };
}

function revertQuoteToParagraph(contents) {
  if (!contents || !Array.isArray(contents.modules)) return { changed: false, contents };

  let changedAny = false;
  const newModules = contents.modules.map((m) => {
    if (!m || m.type !== 'quote') return m;
    changedAny = true;
    return {
      ...m,
      type: 'paragraph',
      iconHidden: true,
      content: `<div class="callout-box">${m.content ?? ''}</div>`,
    };
  });

  if (!changedAny) return { changed: false, contents };
  return { changed: true, contents: { ...contents, modules: newModules } };
}

const SELECT_SLIDES = `
  SELECT s.id, s.contents
  FROM slide s
  WHERE s.contents IS NOT NULL
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [slides] = await queryInterface.sequelize.query(SELECT_SLIDES);

    let converted = 0;
    let skipped = 0;
    const unconvertedLog = [];

    for (const slide of slides) {
      const { changed, contents } = transformParagraphToQuote(slide.contents, slide.id, unconvertedLog);
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
      `[split-quote-from-paragraph] inspected=${slides.length} converted=${converted} skipped=${skipped}`,
    );
    if (unconvertedLog.length > 0) {
      console.log(
        `[split-quote-from-paragraph] 변환되지 않은 callout-box paragraph ${unconvertedLog.length}건 — 수동 정리 필요:`,
      );
      for (const entry of unconvertedLog) {
        console.log(`  slide=${entry.slideId} module=${entry.moduleId} reason=${entry.reason}`);
      }
    }
  },

  async down(queryInterface) {
    const [slides] = await queryInterface.sequelize.query(SELECT_SLIDES);

    let reverted = 0;
    let skipped = 0;

    for (const slide of slides) {
      const { changed, contents } = revertQuoteToParagraph(slide.contents);
      if (!changed) {
        skipped++;
        continue;
      }
      await queryInterface.sequelize.query(
        'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
        { replacements: { id: slide.id, contents: JSON.stringify(contents) } },
      );
      reverted++;
    }

    console.log(
      `[split-quote-from-paragraph:down] inspected=${slides.length} reverted=${reverted} skipped=${skipped}`,
    );
  },
};
