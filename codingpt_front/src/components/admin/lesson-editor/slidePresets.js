export const SLIDE_ROLES = [
  { value: 'intro', label: '인트로', color: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-300' },
  { value: 'goal', label: '학습 목표', color: 'bg-amber-100 text-amber-700', dot: 'bg-amber-300' },
  { value: 'concept', label: '개념', color: 'bg-blue-100 text-blue-700', dot: 'bg-blue-300' },
  { value: 'quiz', label: '퀴즈', color: 'bg-rose-100 text-rose-700', dot: 'bg-rose-300' },
  { value: 'ending', label: '엔딩', color: 'bg-violet-100 text-violet-700', dot: 'bg-violet-300' },
  { value: 'custom', label: '커스텀', color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-300' },
];

export const SLIDE_ROLE_PRESETS = {
  intro: { colors: ['#D7F3E0', 'rgba(215, 243, 224, 0.3)', '#FAFAFA'], locations: [0, 0.5, 1], angle: 180 },
  goal: { colors: ['#F2E1C0', 'rgba(242, 225, 192, 0.3)', '#FAFAFA'], locations: [0, 0.5, 1], angle: 180 },
  concept: { colors: ['#DBEAFE', 'rgba(219, 234, 254, 0.3)', '#FAFAFA'], locations: [0, 0.5, 1], angle: 180 },
  quiz: { colors: ['#F7DCDE', 'rgba(247, 220, 222, 0.3)', '#FAFAFA'], locations: [0, 0.5, 1], angle: 180 },
  ending: { colors: ['#E6DFF7', 'rgba(230, 223, 247, 0.3)', '#FAFAFA'], locations: [0, 0.5, 1], angle: 180 },
  custom: { colors: ['#FFFFFF', '#FAFAFA'], locations: [0, 1], angle: 180 },
};

export const getRoleMeta = (role) =>
  SLIDE_ROLES.find((r) => r.value === role) || SLIDE_ROLES[SLIDE_ROLES.length - 1];
