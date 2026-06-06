// slide.contents 안의 tts 참조(tts.assetId) 처리 유틸.
//
// 슬라이드는 tts:{ assetId, enabled? } 만 저장(source of truth = tts_asset 테이블).
// - collectAssetIds: contents 트리에서 참조된 모든 assetId 수집 (배치 조회용)
// - hydrate: tts:{assetId} 노드를 { assetId, url, timestamps, duration, enabled? } 로 채워
//   RN 앱/프론트가 기존처럼 tts.url / tts.timestamps 를 읽을 수 있게 한다.
// - dehydrate: 저장 직전 tts 에서 파생 필드(url/timestamps/duration)를 제거해
//   인라인 데이터가 되살아나지 않게 한다(assetId/enabled 만 남김).
//
// 위치(lessons/sliders/modules/speeches/result …) 무관한 제네릭 딥워크 — 스키마 변경에 강함.

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// contents 트리에서 tts.assetId 를 모두 수집 (숫자 id Set 반환)
function collectAssetIds(contents) {
  const ids = new Set();
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    const tts = node.tts;
    if (_isPlainObject(tts) && tts.assetId != null) {
      const n = Number(tts.assetId);
      if (Number.isFinite(n)) ids.add(n);
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(contents);
  return ids;
}

// tts:{assetId} → { assetId, url, timestamps, duration, enabled? }.
// assetMap: Map<number, { url, timestamps, duration }>.
// asset 이 없으면(삭제됨) tts 필드를 제거(앱이 falsy 로 안전 처리).
// 입력을 변형하지 않기 위해 깊은 복사본을 반환한다.
function hydrate(contents, assetMap) {
  if (contents == null || typeof contents !== 'object') return contents;
  const clone = JSON.parse(JSON.stringify(contents));

  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (_isPlainObject(node.tts) && node.tts.assetId != null) {
      const id = Number(node.tts.assetId);
      const enabled = node.tts.enabled;
      const asset = assetMap.get(id);
      if (asset && asset.url) {
        node.tts = {
          assetId: id,
          url: asset.url,
          timestamps: asset.timestamps != null ? asset.timestamps : undefined,
          duration: asset.duration != null ? asset.duration : undefined,
          voiceId: asset.voiceId != null ? asset.voiceId : undefined,
          modelId: asset.modelId != null ? asset.modelId : undefined,
        };
        if (enabled === false) node.tts.enabled = false;
      } else {
        // 참조하던 asset 이 사라짐 → tts 제거
        delete node.tts;
      }
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(clone);
  return clone;
}

// 저장 직전: tts 에서 파생 필드 제거(assetId/enabled 만 보존).
// 입력을 변형하지 않기 위해 깊은 복사본을 반환한다.
function dehydrate(contents) {
  if (contents == null || typeof contents !== 'object') return contents;
  const clone = JSON.parse(JSON.stringify(contents));

  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (_isPlainObject(node.tts) && node.tts.assetId != null) {
      const slim = { assetId: Number(node.tts.assetId) };
      if (node.tts.enabled === false) slim.enabled = false;
      node.tts = slim;
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(clone);
  return clone;
}

module.exports = { collectAssetIds, hydrate, dehydrate };
