/**
 * cron.js — 자동화 `schedule` 트리거의 5필드 cron + 시간대(자동화 번들 설계 §5.1·§5.2).
 *
 * 의존성 0: 시간대 계산은 `Intl.DateTimeFormat` 부품(timeZone)만으로 한다 — 벽시계(로컬) 시각을 후보로 만들고
 *  그 벽시계가 실제로 존재하는 UTC 순간을 역산한다.
 *
 * 문법: `분 시 일 월 요일` 각 필드에 `*` · `*\/n` · `a` · `a-b` · `a-b/n` · `a/n` · `a,b,…`. 요일 0~7(0·7 = 일요일).
 *  이름(MON·JAN)·`?`·`L`·`W`·`#` 는 지원하지 않는다(→ AUTO_BAD_TRIGGER).
 *  일·요일 규칙은 vixie cron 과 같다: 둘 다 제한(`*` 로 시작하지 않음)이면 **OR**, 하나라도 `*` 면 AND.
 *
 * DST 규칙(결정적, 테스트 픽스처 cron-01 이 고정):
 *  · 존재하지 않는 벽시계(봄 전환의 02:30 등)는 **건너뛴다**.
 *  · 두 번 존재하는 벽시계(가을 전환의 01:30)는 **앞의 것 한 번만** 실행한다(같은 날 두 번 돌지 않는다).
 */
const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const SEARCH_DAYS = 366 * 5; // 이 안에 한 번도 안 맞으면 "영원히 안 도는" 식(2월 31일 등)으로 본다

function codedError(code, message) { const e = new Error(message); e.code = code; return e; }
const bad = (msg) => codedError('AUTO_BAD_TRIGGER', msg);

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

function parseField(src, f) {
  const set = new Set();
  for (const part of String(src).split(',')) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw bad(`cron ${f.name} 필드가 올바르지 않습니다: ${part}`);
    let lo; let hi;
    if (m[1] === '*') { lo = f.min; hi = f.max; } else {
      lo = parseInt(m[2], 10);
      hi = m[3] != null ? parseInt(m[3], 10) : (m[4] != null ? f.max : lo);
    }
    const step = m[4] != null ? parseInt(m[4], 10) : 1;
    if (!(step >= 1) || lo < f.min || hi > f.max || lo > hi) throw bad(`cron ${f.name} 범위가 올바르지 않습니다: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(f.name === 'dow' && v === 7 ? 0 : v);
  }
  if (!set.size) throw bad(`cron ${f.name} 필드가 비었습니다`);
  return set;
}

/** parse(expr) → {minute[], hour[], dom:Set, month:Set, dow:Set, domStar, dowStar, expr}. 틀리면 AUTO_BAD_TRIGGER. */
function parse(expr) {
  if (typeof expr !== 'string') throw bad('cron 식이 필요합니다');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || expr.length > 120) throw bad('cron 식은 5필드(분 시 일 월 요일)여야 합니다');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    expr: parts.join(' '),
    minute: [...sets[0]].sort((a, b) => a - b),
    hour: [...sets[1]].sort((a, b) => a - b),
    dom: sets[2], month: sets[3], dow: sets[4],
    domStar: parts[2].startsWith('*'), dowStar: parts[4].startsWith('*'),
  };
}

// ── 시간대 ────────────────────────────────────────────────────────────────────
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { dtf(tz); return true; } catch (_) { return false; }
}

function systemTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}

/** ms 순간의 tz 벽시계 부품 {y, mo(1-12), d, h, mi, s}. */
function partsAt(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

/** tz 의 UTC 오프셋(ms, 동쪽 +) — ms 순간 기준. */
function offsetAt(ms, tz) {
  const p = partsAt(ms, tz);
  const floored = ms - (((ms % 1000) + 1000) % 1000);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - floored;
}

/** tz 벽시계(y-mo-d h:mi) → 그 벽시계가 존재하는 가장 이른 UTC ms. 존재하지 않으면(DST 공백) null. */
function wallToUtc(y, mo, d, h, mi, tz) {
  const base = Date.UTC(y, mo - 1, d, h, mi);
  let best = null;
  for (const o of new Set([offsetAt(base - 12 * 3600 * 1000, tz), offsetAt(base, tz), offsetAt(base + 12 * 3600 * 1000, tz)])) {
    const utc = base - o;
    const p = partsAt(utc, tz);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi && (best == null || utc < best)) best = utc;
  }
  return best;
}

/** tz 기준 날짜 키 'YYYY-MM-DD'(하루 실행 상한의 날짜 경계). */
function dayKey(ms, tz) {
  const p = partsAt(ms, validTz(tz) ? tz : 'UTC');
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ── 다음 시각 ─────────────────────────────────────────────────────────────────
/** next(exprOrParsed, fromMs, tz) → fromMs **초과**(분 단위)인 첫 실행 시각 ms, 5년 안에 없으면 null. */
function next(spec, fromMs, tz) {
  const c = typeof spec === 'string' ? parse(spec) : spec;
  const zone = validTz(tz) ? tz : 'UTC';
  const start = Math.floor(fromMs / MIN_MS) * MIN_MS + MIN_MS;
  const p0 = partsAt(start, zone);
  const day0 = Date.UTC(p0.y, p0.mo - 1, p0.d);
  for (let k = 0; k <= SEARCH_DAYS; k++) {
    const dt = new Date(day0 + k * DAY_MS);
    const Y = dt.getUTCFullYear(); const M = dt.getUTCMonth() + 1; const D = dt.getUTCDate(); const W = dt.getUTCDay();
    if (!c.month.has(M)) continue;
    const dayOk = c.domStar && c.dowStar ? true
      : c.domStar ? c.dow.has(W)
        : c.dowStar ? c.dom.has(D)
          : (c.dom.has(D) || c.dow.has(W));
    if (!dayOk) continue;
    for (const h of c.hour) {
      for (const mi of c.minute) {
        const utc = wallToUtc(Y, M, D, h, mi, zone);
        if (utc != null && utc >= start) return utc;
      }
    }
  }
  return null;
}

/** nextN(expr, fromMs, tz, n) → 다음 n 개(모자라면 그만큼만). */
function nextN(spec, fromMs, tz, n) {
  const c = typeof spec === 'string' ? parse(spec) : spec;
  const out = [];
  let from = fromMs;
  for (let i = 0; i < n; i++) {
    const t = next(c, from, tz);
    if (t == null) break;
    out.push(t);
    from = t;
  }
  return out;
}

/**
 * validate(expr, tz, {minIntervalMs, now}) → {parsed, nextRunAt}. 문법·시간대·"영원히 안 돎"·최소 간격 위반이면
 *  AUTO_BAD_TRIGGER. 최소 간격은 두 방식으로 본다: (1) 같은 시(hour) 안의 분 간격(+ 연속된 시가 있으면 시 경계를
 *  넘는 간격) — 식 자체의 성질이라 날짜와 무관하게 결정적 (2) 실제 다음 60회의 연속 간격(DST·월 경계 포함).
 */
function validate(expr, tz, { minIntervalMs = 15 * MIN_MS, now = Date.now() } = {}) {
  if (!validTz(tz)) throw bad(`시간대가 올바르지 않습니다: ${tz}`);
  const c = parse(expr);
  const first = next(c, now, tz);
  if (first == null) throw bad('이 cron 식은 실행될 날이 없습니다');
  const mins = c.minute;
  let gap = Infinity;
  for (let i = 1; i < mins.length; i++) gap = Math.min(gap, (mins[i] - mins[i - 1]) * MIN_MS);
  const hs = new Set(c.hour);
  const consecutiveHours = c.hour.some((h) => hs.has((h + 1) % 24));
  if (consecutiveHours) gap = Math.min(gap, (60 - mins[mins.length - 1] + mins[0]) * MIN_MS);
  const seq = nextN(c, now, tz, 60);
  for (let i = 1; i < seq.length; i++) gap = Math.min(gap, seq[i] - seq[i - 1]);
  if (gap < minIntervalMs) throw bad(`실행 간격이 너무 짧습니다(최소 ${Math.round(minIntervalMs / MIN_MS)}분)`);
  return { parsed: c, nextRunAt: first };
}

module.exports = { parse, next, nextN, validate, validTz, systemTz, dayKey, partsAt, wallToUtc, offsetAt };
