'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// 문서 사이드바 — 그룹/항목 순서는 샘플과 동일. 활성 링크는 현재 pathname 과 일치하는 항목.
type DocLink = { href: string; label: string };
type DocGroup = { title: string; items: DocLink[] };

const GROUPS: DocGroup[] = [
  {
    title: '시작하기',
    items: [
      { href: '/docs/install', label: '설치' },
      { href: '/docs/pairing', label: '기기 연결(페어링)' },
      { href: '/docs/first-workspace', label: '첫 워크스페이스' },
    ],
  },
  {
    title: '기본 개념',
    items: [{ href: '/docs/how-it-works', label: '작동 원리' }],
  },
  {
    title: '워크스페이스 사용',
    items: [
      { href: '/docs/terminal', label: '터미널 & 내 AI CLI' },
      { href: '/docs/byo-ai', label: 'BYO AI (claude/codex)' },
      { href: '/docs/editor', label: '코드 에디터 (IDE)' },
      { href: '/docs/preview', label: '실시간 미리보기' },
      { href: '/docs/handoff', label: '여러 PC·기기 전환' },
      { href: '/docs/notifications', label: '알림 & 단축키' },
    ],
  },
  {
    title: '보안',
    items: [{ href: '/docs/security', label: '보안 & 프라이버시' }],
  },
  {
    title: '레퍼런스',
    items: [{ href: '/docs/troubleshooting', label: '문제 해결 / FAQ' }],
  },
];

export default function DocsSidebar() {
  const pathname = usePathname();
  return (
    <aside className="dx-side">
      {GROUPS.map((grp) => (
        <div className="dx-grp" key={grp.title}>
          <div className="dx-gt">{grp.title}</div>
          {grp.items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className={pathname === it.href ? 'dx-link on' : 'dx-link'}
            >
              {it.label}
            </Link>
          ))}
        </div>
      ))}
    </aside>
  );
}
