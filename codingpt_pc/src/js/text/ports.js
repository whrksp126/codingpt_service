// 열린 포트 목록의 화면 문구. text/index.js 의 규율을 따른다.
//  ⚠ 앱(codingpt_app/src/text/ports.ts)에 **같은 키·같은 뜻**의 사전이 있다(대조 테스트가 걸려 있다).
export const PORTS_TEXT = {
  ko: {
    title: '열린 포트',
    thisWorkspace: '이 워크스페이스',
    elsewhere: '다른 곳',
    // ★ '다른 곳'이 필요한 이유를 사용자에게도 한 줄로 알려준다 — Docker 로 띄운 dev 서버는
    //   프로세스의 작업 폴더가 워크스페이스가 아니라서 여기로 떨어진다(실측: front·back·admin 전부).
    elsewhereHint: 'Docker 처럼 다른 폴더에서 띄운 서버는 여기 있어요.',
    empty: '열려 있는 포트가 없어요',
    emptyHint: '개발 서버를 먼저 실행해 주세요.',
    blank: '빈 웹뷰',
    refresh: '새로고침',
    loading: '확인 중…',
    failed: '포트를 확인하지 못했어요',
  },
  en: {
    title: 'Open ports',
    thisWorkspace: 'This workspace',
    elsewhere: 'Elsewhere',
    elsewhereHint: 'Servers started from another folder (e.g. Docker) show up here.',
    empty: 'No open ports',
    emptyHint: 'Start your dev server first.',
    blank: 'Blank web view',
    refresh: 'Refresh',
    loading: 'Checking…',
    failed: 'Could not check ports',
  },
};
