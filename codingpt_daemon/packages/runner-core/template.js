/**
 * template.js — 자동화 액션 템플릿 `{a.b}` 치환(자동화 번들 설계 §5.4).
 *
 * **정확 치환만**: 표현식·필터·함수·조건 없음. `{` 식별자(`.` 경로) `}` 만 변수로 보고 나머지 중괄호는 그대로 둔다
 *  (프롬프트 안의 JSON·코드 블록이 깨지지 않게). 코드 실행 경로가 없으므로 템플릿이 사용자/이슈 본문을
 *  섞어도 데몬에서 아무것도 실행되지 않는다(§12-6).
 *
 * 미정의 변수 → 빈 문자열 + missing 목록(호출측이 감사 로그에 warn). 렌더 결과가 30000B 를 넘으면 자르고
 *  `… (잘림)` — 원본 템플릿이 20000B 를 넘으면 검증 단계에서 AUTO_TEMPLATE_TOO_LARGE.
 */
const RENDER_MAX_BYTES = 30000;
const TEMPLATE_MAX_BYTES = 20000;
const TRUNC_MARK = '… (잘림)';

// 설계 §5.4 표 — 검증 시 "모르는 변수" 경고의 기준. 렌더는 이 표와 무관하게 vars 객체 경로를 따른다.
const KNOWN_VARS = [
  'now', 'repo.name', 'repo.path', 'branch',
  'issue.number', 'issue.title', 'issue.body', 'issue.url', 'issue.labels', 'issue.author',
  'commits.count', 'commits.range', 'commits.subjects', 'commits.authors',
  'pr.number', 'pr.url', 'ci.failedChecks', 'ci.failedLogs', 'review.comments',
  'task.id', 'task.title', 'run.id', 'run.branch', 'run.agent',
  'prev.taskId', 'prev.runId',
  'auto.name',
];

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g;

function codedError(code, message) { const e = new Error(message); e.code = code; return e; }

/** UTF-8 바이트 기준으로 자른다(멀티바이트 경계 잔재 제거) + 표식. 이미 짧으면 그대로. */
function truncBytes(str, max, mark = TRUNC_MARK) {
  const s = String(str == null ? '' : str);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return { text: s, truncated: false };
  const room = Math.max(0, max - Buffer.byteLength(mark, 'utf8'));
  return { text: buf.subarray(0, room).toString('utf8').replace(/�+$/, '') + mark, truncated: true };
}

function lookup(vars, key) {
  let cur = vars;
  for (const k of key.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function stringify(v) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join(', ');
  if (typeof v === 'object') return undefined; // 객체 통째 치환은 하지 않는다(모양이 불투명) — 미정의로 취급
  return String(v);
}

/** render(str, vars, {maxBytes}) → {text, missing:string[], truncated}. */
function render(str, vars, { maxBytes = RENDER_MAX_BYTES } = {}) {
  const missing = [];
  const out = String(str == null ? '' : str).replace(VAR_RE, (_m, key) => {
    const v = stringify(lookup(vars || {}, key));
    if (v === undefined) { if (!missing.includes(key)) missing.push(key); return ''; }
    return v;
  });
  const t = truncBytes(out, maxBytes);
  return { text: t.text, missing, truncated: t.truncated };
}

/** 템플릿이 쓰는 변수 이름들(등장 순서, 중복 제거). */
function varsOf(str) {
  const set = new Set();
  for (const m of String(str == null ? '' : str).matchAll(VAR_RE)) set.add(m[1]);
  return [...set];
}

/** check(str, {field}) — 원본이 20000B 초과면 AUTO_TEMPLATE_TOO_LARGE. 반환 = 모르는 변수 목록(경고용). */
function check(str, { field = 'template' } = {}) {
  if (Buffer.byteLength(String(str == null ? '' : str), 'utf8') > TEMPLATE_MAX_BYTES) {
    throw codedError('AUTO_TEMPLATE_TOO_LARGE', `${field} 템플릿이 너무 깁니다(${TEMPLATE_MAX_BYTES} 바이트까지)`);
  }
  return varsOf(str).filter((k) => !KNOWN_VARS.includes(k));
}

module.exports = { render, check, varsOf, truncBytes, KNOWN_VARS, RENDER_MAX_BYTES, TEMPLATE_MAX_BYTES, TRUNC_MARK };
