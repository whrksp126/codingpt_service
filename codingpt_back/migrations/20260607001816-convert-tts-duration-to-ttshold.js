'use strict';

// 새 visibility 타입 'ttsHold'(TTS 재생 종료 후 유지) 도입에 따른 데이터 변환.
//
// 배경:
//   가시성 타이밍을 두 타입으로 명확히 분리한다.
//     - duration : 등장 후 고정 time(ms) 뒤 다음 (TTS 와 무관, 길면 잘림 — 작가의 명시적 선택)
//     - ttsHold  : TTS 재생 종료(onEnd) 를 기다린 뒤 time(ms) 만큼 더 유지하고 다음 (잘리지 않음)
//
//   기존 데이터에서 "enabled TTS 를 가진 duration 항목"은 사실상 'TTS 가 끝나면 넘어가길' 의도한
//   것이므로 ttsHold 로 전환한다. time 은 기본 유지값 0 으로 설정한다(필요한 홀드는 관리자에서 재설정).
//
// 변환 대상/제외:
//   - 대상: node.tts(enabled) && node.visibility.type === 'duration'  → { type:'ttsHold', time:0 }
//   - 제외: visibility.type === 'step'(단계 게이트/퀴즈 결과 모듈) 및 그 외 타입/미설정은 손대지 않음.
//           (step 을 ttsHold 로 바꾸면 단계 기반 등장이 깨진다.)
//
// idempotent: 두 번 실행해도 두 번째에는 이미 ttsHold 라 no-op.
// down: duration 으로 되돌리되 원래 time 값은 소실됐으므로 0 으로 복원(완전 복구 아님).
//
// !! 베이스라인 백업 권장 !!
//   cd codingpt_service/codingpt_back && set -a && source .env.local && set +a
//   bash scripts/db-backup.sh upload pre-ttshold-type

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function _hasEnabledTts(tts) {
  if (tts == null) return false;
  if (typeof tts === 'string') return tts.trim() !== '';
  if (_isPlainObject(tts)) {
    if (tts.enabled === false) return false;
    if (tts.assetId != null) return true;
    if (typeof tts.url === 'string' && tts.url.trim() !== '') return true;
  }
  return false;
}

// enabled TTS + visibility.type===fromType 노드의 visibility 를 { type:toType, time:0 } 으로.
// 변경된 노드 수 반환(in-place).
function convertVisibilityType(contents, fromType, toType) {
  if (contents == null || typeof contents !== 'object') return 0;
  let changed = 0;
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (
      _hasEnabledTts(node.tts)
      && _isPlainObject(node.visibility)
      && node.visibility.type === fromType
    ) {
      node.visibility = { type: toType, time: 0 };
      changed++;
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(contents);
  return changed;
}

const SELECT_SLIDES = `
  SELECT s.id, s.contents
  FROM slide s
  WHERE s.contents IS NOT NULL
`;

async function applyConversion(queryInterface, fromType, toType, tag) {
  const [slides] = await queryInterface.sequelize.query(SELECT_SLIDES);
  let updatedSlides = 0;
  let touchedNodes = 0;
  for (const slide of slides) {
    const changed = convertVisibilityType(slide.contents, fromType, toType);
    if (changed === 0) continue;
    await queryInterface.sequelize.query(
      'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
      { replacements: { id: slide.id, contents: JSON.stringify(slide.contents) } },
    );
    updatedSlides++;
    touchedNodes += changed;
  }
  console.log(`[${tag}] inspected=${slides.length} updatedSlides=${updatedSlides} touchedNodes=${touchedNodes}`);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await applyConversion(queryInterface, 'duration', 'ttsHold', 'convert-tts-duration-to-ttshold');
  },

  async down(queryInterface) {
    await applyConversion(queryInterface, 'ttsHold', 'duration', 'convert-tts-duration-to-ttshold:down');
  },
};
