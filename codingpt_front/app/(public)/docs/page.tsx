import Link from 'next/link';

// 문서 인덱스 — 주요 문서 페이지로 가는 카드 그리드.
const CARDS: { k: string; t: string; d: string; href: string }[] = [
  { k: '시작하기', t: '설치', d: '무료 데스크톱 앱을 내 머신에 설치하기.', href: '/docs/install' },
  { k: '시작하기', t: '첫 워크스페이스', d: '내 머신의 폴더를 골라 워크스페이스로 열기.', href: '/docs/first-workspace' },
  { k: '기본 개념', t: '작동 원리', d: '왜 코드가 서버를 거치지 않는지 — 암호화 릴레이 구조.', href: '/docs/how-it-works' },
  { k: '워크스페이스', t: '터미널 & 내 AI CLI', d: '내 머신 터미널을 폰에서 그대로 이어받기.', href: '/docs/terminal' },
  { k: '워크스페이스', t: 'BYO AI (claude/codex)', d: '이미 쓰는 AI CLI를 그대로 — 키는 내 머신 밖으로 안 나가요.', href: '/docs/byo-ai' },
  { k: '워크스페이스', t: '실시간 미리보기', d: '내 머신 개발 서버를 앱 안 브라우저로.', href: '/docs/preview' },
  { k: '보안', t: '보안 & 프라이버시', d: '코드는 내 머신을 떠나지 않습니다 — 정책이 아니라 설계로.', href: '/docs/security' },
  { k: '레퍼런스', t: '문제 해결 / FAQ', d: '연결이 안 되거나 이상할 때.', href: '/docs/troubleshooting' },
];

export default function DocsIndexPage() {
  return (
    <>
      <div className="dx-crumb">
        <b>문서</b>
      </div>
      <h1>CodingPT 문서</h1>
      <p className="dx-lead">
        내 머신의 코딩 에이전트를 폰·태블릿에서 이어받는 법 — 설치부터 워크스페이스 사용, 보안까지.
      </p>

      <div className="dx-cards">
        {CARDS.map((c) => (
          <Link className="dx-card" href={c.href} key={c.href}>
            <div className="k">{c.k}</div>
            <div className="t">{c.t}</div>
            <div className="d">{c.d}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
