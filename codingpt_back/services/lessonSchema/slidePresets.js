const SLIDE_TYPE_PRESETS = {
  intro: {
    label: '인트로',
    description: '레슨 시작 — 도입/제목/캐릭터 소개',
    background: {
      colors: ['#D7F3E0', 'rgba(215, 243, 224, 0.3)', '#FAFAFA'],
      locations: [0, 0.5, 1],
      angle: 180,
    },
    defaultModules: ['paragraph'],
  },
  goal: {
    label: '학습 목표',
    description: '이번 레슨에서 배울 내용 미션 형태로',
    background: {
      colors: ['#F2E1C0', 'rgba(242, 225, 192, 0.3)', '#FAFAFA'],
      locations: [0, 0.5, 1],
      angle: 180,
    },
    defaultModules: ['paragraph', 'missionList'],
  },
  concept: {
    label: '개념 설명',
    description: '핵심 개념 + 코드/이미지 설명',
    background: {
      colors: ['#DBEAFE', 'rgba(219, 234, 254, 0.3)', '#FAFAFA'],
      locations: [0, 0.5, 1],
      angle: 180,
    },
    defaultModules: ['paragraph', 'image'],
  },
  quiz: {
    label: '퀴즈',
    description: '학습자 인터랙션 — 객관식/빈칸/순서 등',
    background: {
      colors: ['#F7DCDE', 'rgba(247, 220, 222, 0.3)', '#FAFAFA'],
      locations: [0, 0.5, 1],
      angle: 180,
    },
    defaultModules: ['multipleChoice'],
  },
  ending: {
    label: '엔딩',
    description: '레슨 마무리 — 축하/요약',
    background: {
      colors: ['#E6DFF7', 'rgba(230, 223, 247, 0.3)', '#FAFAFA'],
      locations: [0, 0.5, 1],
      angle: 180,
    },
    defaultModules: ['lottie', 'paragraph'],
  },
  custom: {
    label: '커스텀',
    description: '사용자 정의 슬라이드 — 빈 캔버스로 시작',
    background: {
      colors: ['#FFFFFF', '#FAFAFA'],
      locations: [0, 1],
      angle: 180,
    },
    defaultModules: [],
  },
};

const SLIDE_ROLES = Object.keys(SLIDE_TYPE_PRESETS);

module.exports = { SLIDE_TYPE_PRESETS, SLIDE_ROLES };
