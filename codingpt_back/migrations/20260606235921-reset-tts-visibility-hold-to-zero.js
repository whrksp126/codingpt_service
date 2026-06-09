'use strict';

// TTS 종료 기반 가시성 타이밍 모델 도입에 따른 데이터 정리.
//
// 배경:
//   기존에는 visibility.time(ms) 이 "등장 후 머무는 전체 시간"이라는 의미로 임의 설정돼 있었다.
//   새 RN 런타임에서는 TTS 가 있는(enabled) 항목의 visibility.time 을 "TTS 재생 종료 후 추가
//   유지 시간"으로 재해석한다(실제 onEnd 이벤트를 기다린 뒤 그만큼 더 보여주고 다음으로 진행).
//   따라서 기존의 임의 time(예: 5000) 이 그대로 남으면 TTS(예: 2초) 재생 후 추가로 5초를 더
//   기다리게 되어 의도보다 길어진다.
//
// 처리:
//   slide.contents 트리를 제네릭 딥워크하여, "enabled TTS 를 가진 노드"이면서
//   visibility.type==='duration' 이고 time>0 인 경우 time 을 0 으로 리셋한다.
//   (기본 유지 시간 0 = TTS 끝나면 즉시 다음. 필요한 홀드는 이후 관리자에서 다시 설정.)
//
//   - visibility.type 이 'duration' 이 아닌 경우(step/time/미설정)는 손대지 않는다
//     (런타임에서 이미 holdMs=0 으로 처리되므로 변환 불필요).
//   - TTS 가 없거나 enabled:false 인 노드는 손대지 않는다(고정 duration 의미 유지).
//
// idempotent: 두 번 실행해도 두 번째에는 time 이 이미 0 이라 no-op.
// down: 원래의 임의 time 값은 보존하지 않으므로 복구 불가 → no-op (로그만).
//
// !! 베이스라인 백업 권장 !!
//   cd codingpt_service/codingpt_back && set -a && source .env.local && set +a
//   bash scripts/db-backup.sh upload pre-tts-visibility-reset

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// 저장(dehydrate)된 형태 기준 "재생되는 TTS"인지 판정.
//   - 문자열(레거시 URL): enabled
//   - { assetId, enabled? } / { url, enabled? }: enabled !== false 이고 assetId 또는 url 존재 시 enabled
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

// contents 트리를 제네릭 딥워크하며 enabled TTS + duration(time>0) 노드의 time 을 0 으로.
// 변경된 노드 수를 반환(in-place 수정).
function resetTtsHoldToZero(contents, slideId, touchedLog) {
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
      && node.visibility.type === 'duration'
      && typeof node.visibility.time === 'number'
      && node.visibility.time > 0
    ) {
      touchedLog.push({ slideId, from: node.visibility.time });
      node.visibility.time = 0;
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

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [slides] = await queryInterface.sequelize.query(SELECT_SLIDES);

    let updatedSlides = 0;
    let touchedNodes = 0;
    const touchedLog = [];

    for (const slide of slides) {
      const before = touchedLog.length;
      const changed = resetTtsHoldToZero(slide.contents, slide.id, touchedLog);
      if (changed === 0) continue;

      await queryInterface.sequelize.query(
        'UPDATE slide SET contents = :contents, updated_at = NOW() WHERE id = :id',
        { replacements: { id: slide.id, contents: JSON.stringify(slide.contents) } },
      );
      updatedSlides++;
      touchedNodes += changed;
      const samples = touchedLog.slice(before, before + 3).map((e) => e.from).join(', ');
      console.log(`  slide=${slide.id} reset ${changed}건 (예: ${samples}ms → 0)`);
    }

    console.log(
      `[reset-tts-visibility-hold-to-zero] inspected=${slides.length} updatedSlides=${updatedSlides} touchedNodes=${touchedNodes}`,
    );
  },

  async down() {
    // 원래의 임의 time 값은 보존하지 않으므로 복구 불가 — no-op.
    console.log('[reset-tts-visibility-hold-to-zero:down] 원본 time 값 소실로 복구 불가 — no-op');
  },
};
