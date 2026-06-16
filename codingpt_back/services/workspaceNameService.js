const Anthropic = require('@anthropic-ai/sdk');

// 워크스페이스 이름 추천 — 사용자가 만들고 싶은 것을 설명하면 이름 후보를 제안.
// 가벼운 작업이라 claude-haiku-4-5 사용. 키 미설정/실패 시 휴리스틱 폴백.

const MODEL = process.env.WORKSPACE_NAME_MODEL || 'claude-haiku-4-5';

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// 텍스트에서 JSON 배열 추출 → 문자열 이름 배열
function parseNames(text) {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch (_) {
    return [];
  }
}

// 설명에서 간단히 이름 후보 생성(폴백) — 키워드 기반
function fallback(description) {
  const desc = String(description || '').trim();
  const words = desc.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3);
  const core = words.join(' ') || '새 워크스페이스';
  const out = [core, `${core} 앱`, `my-${words[0] || 'workspace'}`.toLowerCase()];
  return [...new Set(out)].slice(0, 4);
}

/**
 * 워크스페이스 이름 후보 추천.
 * @param {string} description 사용자가 만들고 싶은 것에 대한 설명
 * @returns {Promise<string[]>} 이름 후보(최대 5)
 */
async function suggestNames(description) {
  const desc = String(description || '').trim().slice(0, 2000);
  if (!desc) return fallback(desc);

  const c = getClient();
  if (!c) return fallback(desc);

  try {
    const msg = await c.messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        '너는 개발 워크스페이스 이름을 짓는 도우미다. 사용자가 만들고 싶은 것을 설명하면, ' +
        '짧고 기억하기 좋은 워크스페이스 이름 후보 4개를 제안한다. 한국어/영문 혼용 가능, ' +
        '각 이름은 2~5단어 이내로 폴더명으로도 쓸 수 있게 간결하게. ' +
        '반드시 JSON 배열만 출력한다. 예: ["할 일 앱","todo-list","데일리 플래너","my-todo"]',
      messages: [{ role: 'user', content: desc }],
    });
    const text = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const names = parseNames(text);
    return names.length ? names : fallback(desc);
  } catch (_) {
    return fallback(desc);
  }
}

module.exports = { suggestNames };
