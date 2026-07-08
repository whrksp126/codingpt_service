// 워크스페이스 이름 추천 — 사용자가 만들고 싶은 것을 설명하면 이름 후보를 제안.
//
// 원격 조작 서비스(BYO) 피벗으로 우리 키 LLM 호출 경로를 전부 제거했다.
// 이제 키워드 기반 휴리스틱만 사용한다(우리 ANTHROPIC_API_KEY 미사용).
// (LLM 기반 이름 추천이 다시 필요하면 러너/데몬의 사용자 CLI 로 위임해야 한다.)

// 설명에서 간단히 이름 후보 생성 — 키워드 기반
function fallback(description) {
  const desc = String(description || '').trim();
  const words = desc.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3);
  const core = words.join(' ') || '새 워크스페이스';
  const out = [core, `${core} 앱`, `my-${words[0] || 'workspace'}`.toLowerCase()];
  return [...new Set(out)].slice(0, 4);
}

/**
 * 워크스페이스 이름 후보 추천(휴리스틱).
 * @param {string} description 사용자가 만들고 싶은 것에 대한 설명
 * @returns {Promise<string[]>} 이름 후보(최대 4)
 */
async function suggestNames(description) {
  const desc = String(description || '').trim().slice(0, 2000);
  return fallback(desc);
}

module.exports = { suggestNames };
