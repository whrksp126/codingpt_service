import * as i18n from "../i18n/index.js";
// 저장한 명령(Quick Commands)의 화면 문구. text/index.js 의 규율을 따른다.
//  ⚠ 앱(codingpt_app/src/text/quickCommands.ts)에 **같은 키·같은 뜻**의 사전이 있다. 한쪽만
//   고치면 PC 와 폰의 표현이 갈린다 — 문구를 바꿀 땐 두 파일을 함께 본다.
export const QC_TEXT = {
  ko: {
    title: '저장한 명령',
    empty: '저장한 명령이 없어요',
    emptyHint: '자주 치는 명령을 저장해 두면 한 번에 실행할 수 있어요.',
    manage: '명령 관리',
    add: '명령 추가',
    edit: '명령 수정',
    remove: '삭제',
    save: '저장',
    cancel: '취소',
    labelField: '이름',
    labelPlaceholder: '비워두면 명령 첫 줄을 씁니다',
    kindShell: '터미널 명령',
    kindAgent: 'AI 에게 보내기',
    shellField: '명령',
    shellPlaceholder: 'npm run dev',
    agentField: '프롬프트',
    agentPlaceholder: '배포 전에 점검해줘',
    agentPick: '에이전트',
    targetField: '실행 위치',
    targetNew: '새 터미널',
    targetCurrent: '지금 터미널',
    targetNewHint: '새 터미널을 열어 거기서 실행해요. 계속 떠 있어야 하는 개발 서버에 맞아요.',
    targetCurrentHint: '지금 보고 있는 터미널에 넣어요. 결과를 바로 보고 싶을 때 맞아요.',
    scopeField: '보이는 곳',
    scopeGlobal: '모든 워크스페이스',
    scopeWs: '이 워크스페이스만',
    running: '실행 중…',
    // 실행 결과 — "안 기다리고 보냈다"를 감추지 않는다(사용자가 화면을 보고 판단할 수 있게).
    notReady: '터미널이 아직 준비되지 않아 그대로 보냈어요. 화면을 확인해 주세요.',
    busy: '그 터미널에서 다른 게 돌고 있어 실행하지 않았어요.',
    needTerminal: '보낼 터미널이 없어요. 터미널을 먼저 열어 주세요.',
    failed: '실행하지 못했어요',
    limitReached: (n) => i18n.t('저장한 명령은 최대 {n}개까지예요', { n }),
    removeConfirm: (label) => i18n.t('‘{label}’ 을 삭제할까요?', { label }),
  },

};
