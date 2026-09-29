/**
 * json-store.js — `<stateDir>` 아래 작은 JSON/NDJSON 파일의 읽기·원자적 쓰기(자동화 번들 설계 §2.1·§2.4).
 *
 * tasks.js:213 의 저장 패턴(`.<pid>.tmp` 에 0600 으로 쓰고 chmod → rename)을 추출한 것이다. tasks.js 는
 *  무수정(기존 저장 코드 유지) — 새 모듈(automations/dispatch/power)만 이걸 쓴다.
 *
 * 규율:
 *  · 읽기 실패는 던지지 않는다 — ENOENT 는 조용히 fallback, 그 밖(깨진 JSON 등)은 onError 로 알리고 fallback.
 *    (스토어 하나가 깨졌다고 데몬 기동이 실패하면 터미널·프리뷰까지 죽는다.)
 *  · 쓰기는 rename 원자성에 기댄다 — 쓰는 도중 죽어도 원본은 온전하다. 파일은 항상 0600(사용자 전용).
 *  · NDJSON 감사 로그는 상한을 넘으면 `.1` 로 한 세대만 회전한다(무한 증가 금지).
 */
const fs = require('fs');
const path = require('path');

/**
 * readJson(file, {fallback, validate, onError}) — 파싱된 값. 파일이 없거나 깨졌거나 validate 가 거짓이면 fallback.
 *  fallback 이 함수면 매번 새로 만든다(공유 객체 변형 사고 방지).
 */
function readJson(file, { fallback = null, validate, onError } = {}) {
  const fb = () => (typeof fallback === 'function' ? fallback() : fallback);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code !== 'ENOENT' && onError) { try { onError(e); } catch (_) { /* noop */ } }
    return fb();
  }
  let v;
  try { v = JSON.parse(raw); } catch (e) {
    if (onError) { try { onError(e); } catch (_) { /* noop */ } }
    return fb();
  }
  if (typeof validate === 'function') {
    let ok = false;
    try { ok = !!validate(v); } catch (_) { ok = false; }
    if (!ok) {
      if (onError) { try { onError(new Error('검증 실패')); } catch (_) { /* noop */ } }
      return fb();
    }
  }
  return v;
}

/** writeJsonAtomic(file, obj) — 디렉토리 생성 + `.<pid>.tmp`(0600) + chmod + rename. 실패는 던진다(호출측이 로그). */
function writeJsonAtomic(file, obj, { dirMode } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, ...(dirMode ? { mode: dirMode } : {}) });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) { /* win32 등 — 무해 */ }
  fs.renameSync(tmp, file);
}

/**
 * appendNdjson(file, obj, {maxBytes}) — 한 줄 추가. 추가 전 크기가 maxBytes 이상이면 `<file>.1` 로 회전(1세대).
 *  실패는 삼키고 false(감사 로그 때문에 본 동작이 실패하면 안 된다).
 */
function appendNdjson(file, obj, { maxBytes = 2 * 1024 * 1024 } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { size = 0; }
    if (size >= maxBytes) {
      try { fs.renameSync(file, `${file}.1`); } catch (_) { /* noop */ }
    }
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
    return true;
  } catch (_) { return false; }
}

/**
 * readNdjsonTail(file, {limit, filter, includeRotated}) — 마지막 limit 줄(오래된 → 최신 순). 깨진 줄은 건너뛴다.
 *  현재 파일로 모자라면 `.1` 세대도 본다(회전 직후에도 꼬리가 비지 않게).
 */
function readNdjsonTail(file, { limit = 100, filter, includeRotated = true } = {}) {
  const parse = (f) => {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let v = null;
      try { v = JSON.parse(line); } catch (_) { continue; }
      if (filter && !filter(v)) continue;
      out.push(v);
    }
    return out;
  };
  let lines = parse(file);
  if (includeRotated && lines.length < limit) lines = [...parse(`${file}.1`), ...lines];
  return lines.slice(-Math.max(0, limit));
}

module.exports = { readJson, writeJsonAtomic, appendNdjson, readNdjsonTail };
