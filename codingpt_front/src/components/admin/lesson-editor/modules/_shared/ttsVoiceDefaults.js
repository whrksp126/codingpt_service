// 모듈 맥락별 기본 TTS 보이스 — 생성 시 매번 목소리를 바꾸지 않도록 자동 선택.
// voice_id 는 백엔드 GEMINI_VOICES(ttsService.js)에 존재하는 값.
export const CONTEXT_DEFAULT_VOICE = {
  mc: 'Alnilam',      // 진행자(MC): 슬라이드 첫 아이콘 텍스트 모듈
  teacher: 'Despina', // 캐릭터 말풍선 — 선생님
  student: 'Orus',    // 캐릭터 말풍선 — 학생
};
