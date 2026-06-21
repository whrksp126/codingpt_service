import type { LegalSection } from '@/config/legal';

// 법적 문서 렌더러(SSR) — 조문 데이터 → 정적 HTML. 표준안 기반 약관/방침 공통.
export default function LegalDoc({
  title, sections, effectiveDate, hideTitle,
}: {
  title: string; sections: LegalSection[]; effectiveDate?: string; hideTitle?: boolean;
}) {
  return (
    <article style={{ maxWidth: 800, margin: hideTitle ? '0' : '0 auto', lineHeight: 1.8 }}>
      {hideTitle ? null : <h1 style={{ marginBottom: 4 }}>{title}</h1>}
      {effectiveDate ? <p className="dim" style={{ fontSize: 13, marginTop: 0 }}>시행일: {effectiveDate}</p> : null}

      {sections.map((s, i) => (
        <section key={i} style={{ marginTop: s.heading ? 26 : 12 }}>
          {s.heading ? <h3 style={{ marginBottom: 8 }}>{s.heading}</h3> : null}
          {s.paragraphs?.map((p, j) => (
            <p key={j} style={{ margin: '0 0 8px', color: 'var(--text2)', fontSize: 14.5 }}>{p}</p>
          ))}
          {s.items?.length ? (
            <ol style={{ margin: '6px 0 0', paddingLeft: 22, color: 'var(--text2)', fontSize: 14.5 }}>
              {s.items.map((it, j) => (
                <li key={j} style={{ margin: '0 0 6px', lineHeight: 1.75 }}>{it}</li>
              ))}
            </ol>
          ) : null}
        </section>
      ))}
    </article>
  );
}
