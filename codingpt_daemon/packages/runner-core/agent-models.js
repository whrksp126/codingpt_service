'use strict';
// agent-models.js — 이 PC 에 설치된 AI CLI 가 **실제로 아는** 모델·추론 강도(2026-10-02 QA).
//
// 새 작업/한 줄 지시가 "claude" "codex" 이름만 고르게 해서 소넷인지 오퍼스인지 알 수 없다는 지적 →
//  사용자 PC 의 CLI 자신에게 묻는다(앱이 모델 목록을 하드코딩하지 않는다. CLI 가 갱신되면 목록도 따라온다).
//  · claude: `claude --help` 의 --model 별칭('fable','opus','sonnet' …)·--effort 단계를 파싱 + 바이너리에 박힌 모델 ID
//    (5.4/5.5 같은 세부 버전) + 사용자 settings.json 의 기본 model. 목록 파일이 없는 CLI 라 이게 최선.
//  · codex: ~/.codex/models_cache.json(CLI 가 갱신) 의 visibility=list 모델과 모델별 지원 추론 강도·기본값.
//  · gemini: 모델 목록 출처가 없다 → 기본값만(선택지 없음).
// 결과는 agents.list 항목에 `models`/`efforts`/`defaultModel`/`defaultEffort` 로 얹는다(없으면 필드 생략 = 모름).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SAFE = /^[A-Za-z0-9._:\-\[\]]{1,80}$/;
const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // id → { at, info }

function home() { return os.homedir(); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function titleCase(s) { return String(s).replace(/(^|[-_ ])(\w)/g, (m, a, b) => (a ? ' ' : '') + b.toUpperCase()); }

function run(bin, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout, maxBuffer: 1 << 20, env: { ...process.env, NO_COLOR: '1' } }, (err, out, errOut) => resolve(String(out || '') + String(errOut || '')));
    } catch (_) { resolve(''); }
  });
}

// claude 바이너리(단일 실행 파일)에는 모델 ID 가 문자열로 박혀 있다 — 5.4/5.5 같은 세부 버전을 CLI 자신에게서 읽는다.
//  청크 스트리밍(바이너리 ~225MB)이라 느리다 → 호출부가 바이너리 경로 단위로 캐시(describe TTL).
function scanBinaryModelIds(bin) {
  return new Promise((resolve) => {
    const found = new Set();
    let tail = '';
    let rs;
    try { rs = fs.createReadStream(fs.realpathSync(bin), { highWaterMark: 8 << 20, encoding: 'latin1' }); } catch (_) { resolve([]); return; }
    rs.on('data', (chunk) => {
      const text = tail + chunk;
      for (const m of text.matchAll(/claude-(?:opus|sonnet|fable|haiku)-\d+(?:-\d{1,2})?(?:-20\d{6})?(?![\w-])/g)) found.add(m[0]);
      tail = text.slice(-64);
    });
    rs.on('end', () => resolve([...found]));
    rs.on('error', () => resolve([...found]));
  });
}
/** 별칭이 아닌 "분명한 버전" ID 만 — 날짜 접미/베드록 변형 제외, 계열별 최신 4개. */
function pickVersionedIds(ids) {
  const fam = {};
  for (const id of ids) {
    const m = id.match(/^claude-(opus|sonnet|fable|haiku)-(\d+)-(\d{1,2})(-20\d{6})?$/);
    if (!m) continue;
    // 날짜 접미 버전은 같은 버전의 날짜 없는 ID 가 있으면 버린다(중복).
    if (m[4] && ids.includes(`claude-${m[1]}-${m[2]}-${m[3]}`)) continue;
    (fam[m[1]] = fam[m[1]] || []).push({ id, v: [Number(m[2]), Number(m[3])] });
  }
  const out = [];
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) {
    const l = (fam[f] || []).sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1]).slice(0, 4);
    for (const x of l) out.push(x.id);
  }
  return out;
}

async function claudeInfo(bin) {
  const help = bin ? await run(bin, ['--help']) : '';
  // --model: "… alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') …"
  const aliasBlock = (help.match(/--model <model>[\s\S]{0,400}/) || [''])[0];
  const aliases = [...aliasBlock.matchAll(/'([a-z][a-z0-9-]{1,20})'/g)].map((m) => m[1]);
  for (const a of ['opus', 'sonnet', 'haiku']) if (!aliases.includes(a)) aliases.push(a);
  // --effort: "(low, medium, high, xhigh, max)"
  const effRaw = (help.match(/--effort <level>[\s\S]{0,200}?\(([a-z, ]+)\)/) || [])[1] || 'low, medium, high, xhigh, max';
  const efforts = effRaw.split(',').map((x) => x.trim()).filter((x) => SAFE.test(x));
  const models = aliases.map((id) => ({ id, label: titleCase(id), hint: '최신' }));
  const versioned = bin ? pickVersionedIds(await scanBinaryModelIds(bin)) : [];
  for (const id of versioned) if (!models.some((m) => m.id === id)) models.push({ id, label: id.replace(/^claude-/, '').replace(/-/g, ' ').replace(/(\d) (\d)/, '$1.$2').replace(/^\w/, (c) => c.toUpperCase()), hint: '' });
  const st = readJson(path.join(home(), '.claude', 'settings.json'));
  const defaultModel = st && typeof st.model === 'string' && SAFE.test(st.model) ? st.model : null;
  if (defaultModel && !models.some((m) => m.id === defaultModel)) models.push({ id: defaultModel, label: defaultModel, hint: '내 설정' });
  const defaultEffort = st && typeof st.effortLevel === 'string' && efforts.includes(st.effortLevel) ? st.effortLevel : null;
  return { models, efforts, defaultModel, defaultEffort };
}

function codexInfo() {
  const j = readJson(path.join(home(), '.codex', 'models_cache.json'));
  const list = j && Array.isArray(j.models) ? j.models : [];
  const models = list
    .filter((m) => m && m.visibility === 'list' && SAFE.test(String(m.slug || '')))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map((m) => ({
      id: m.slug, label: m.display_name || m.slug, hint: m.description || '',
      efforts: (m.supported_reasoning_levels || []).map((x) => x && x.effort).filter((x) => x && SAFE.test(x)),
      defaultEffort: m.default_reasoning_level || null,
    }));
  const efforts = [...new Set(models.flatMap((m) => m.efforts))];
  let defaultModel = null;
  try {
    const t = fs.readFileSync(path.join(home(), '.codex', 'config.toml'), 'utf8');
    const mm = t.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (mm && SAFE.test(mm[1])) defaultModel = mm[1];
  } catch (_) { /* noop */ }
  return { models, efforts, defaultModel, defaultEffort: null };
}

/** { models:[{id,label,hint,efforts?,defaultEffort?}], efforts:[], defaultModel, defaultEffort } — 모름이면 null. */
async function describe(id, bin) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  let info = null;
  try {
    if (id === 'claude') info = await claudeInfo(bin);
    else if (id === 'codex') info = codexInfo();
  } catch (_) { info = null; }
  cache.set(id, { at: Date.now(), info });
  return info;
}

/** 런치 인자 — 값은 검증 후 작은따옴표로 감싼다(셸 한 줄에 그대로 붙는다). 모르거나 비었으면 []. */
function launchArgs(agentId, sel) {
  const model = sel && typeof sel.model === 'string' && SAFE.test(sel.model) ? sel.model : null;
  const effort = sel && typeof sel.effort === 'string' && SAFE.test(sel.effort) ? sel.effort : null;
  const q = (v) => `'${v}'`;
  const a = [];
  if (agentId === 'claude') {
    if (model) a.push('--model', q(model));
    if (effort) a.push('--effort', q(effort));
  } else if (agentId === 'codex') {
    if (model) a.push('-m', q(model));
    if (effort) a.push('-c', `'model_reasoning_effort="${effort}"'`);
  } else if (agentId === 'gemini') {
    if (model) a.push('-m', q(model));
  }
  return a;
}

/** 헤드리스(플래너)용 인자 — 셸을 거치지 않으므로 따옴표 없이. */
function headlessArgs(agentId, sel) {
  return launchArgs(agentId, sel).map((x) => x.replace(/^'(.*)'$/, '$1').replace(/^model_reasoning_effort="(.*)"$/, 'model_reasoning_effort="$1"'));
}

function valid(v) { return v == null || (typeof v === 'string' && SAFE.test(v)); }

module.exports = { describe, launchArgs, headlessArgs, valid, SAFE, _cache: cache };
