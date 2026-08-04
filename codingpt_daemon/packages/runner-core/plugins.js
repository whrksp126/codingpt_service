/**
 * plugins — 플러그인 마켓플레이스의 **설치·보관·적용**. 계약(모양 판정)은 plugin-manifest.js.
 *
 * 왜 우리 서버가 없나(2026-08-05 설계 확정):
 *  마켓플레이스 = **git 저장소 하나**다(`codingpt-marketplace.json` 이 루트에 있는 리포). 설치 =
 *  그 리포가 가리키는 플러그인 리포를 **커밋에 고정해** clone 하는 것. 서버를 세우면 우리가 배포
 *  파이프라인·심사·다운타임을 떠안는데, 얻는 게 "우리 목록"뿐이다. 오르카도 같은 결론이다
 *  (실측: `orca-marketplace.json` + `{kind:'git', url, ref}`, 설치 시 ref→커밋 고정).
 *
 * 보관 위치: `<stateDir>/plugins/<publisher>.<id>/` + `<stateDir>/plugins.json`(설치 목록).
 *  머신 영속이다 — 저장한 명령(quick-commands.json)과 같은 이유로 계정 동기화가 아니다.
 *  플러그인은 그 PC 에 실제로 있는 도구를 부른다.
 *
 * 안전 규율(하나라도 어기면 설치 거부):
 *  · 설치는 **항상 커밋 해시로 고정**한다. 브랜치로 두면 같은 목록이 날마다 다른 코드를 가져온다.
 *  · clone 은 `--depth 1 --no-tags`, 서브모듈 금지, `core.hooksPath=/dev/null` — 리포가 준
 *    훅이 clone 도중에 실행되면 그건 이미 임의 코드 실행이다.
 *  · 플러그인이 주는 경로는 전부 설치 폴더 **안쪽**으로 realpath 검증한다(심링크 탈출 차단).
 *  · 사용자가 **동의한 권한 지문**을 저장한다. 업데이트로 권한이 늘면 다시 묻는다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const runtime = require('./runtime');
const M = require('./plugin-manifest');

const SCHEMA_VERSION = 1;
const MAX_INSTALLED = 60;
const CLONE_TIMEOUT_MS = 90_000;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_PACK_BYTES = 2 * 1024 * 1024;

function root() { return path.join(runtime.stateDir(), 'plugins'); }
function listFile() { return path.join(runtime.stateDir(), 'plugins.json'); }

function git(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: (opts && opts.cwd) || undefined,
      timeout: (opts && opts.timeoutMs) || CLONE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        // 자격증명 프롬프트가 뜨면 데몬이 그 자리에서 멈춘다(사용자는 아무것도 못 본다).
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve(String(stdout || ''));
    });
  });
}

// ── 설치 목록 보관 ───────────────────────────────────────────────────────────

function readList() {
  try {
    const raw = JSON.parse(fs.readFileSync(listFile(), 'utf8'));
    if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.items)) return [];
    return raw.items.filter((i) => i && M.isPluginKey(i.key));
  } catch (_) { return []; }
}

function writeList(items) {
  const dir = path.dirname(listFile());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = listFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, items }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, listFile());   // 원자적 교체 — 중간에 죽어도 목록이 반쪽으로 남지 않는다
}

/**
 * 사용자가 동의한 내용의 지문. **권한 + 기여 종류**를 담는다.
 *  버전만 보면 "권한이 늘어난 업데이트"를 조용히 통과시킨다 — 그게 이 지문의 존재 이유다.
 */
function consentFingerprint(manifest) {
  const caps = [...manifest.capabilities].sort();
  const kinds = Object.keys(manifest.contributes).filter((k) => manifest.contributes[k].length).sort();
  return crypto.createHash('sha256').update(JSON.stringify({ caps, kinds })).digest('hex').slice(0, 16);
}

// ── 경로 안전 ────────────────────────────────────────────────────────────────

/**
 * 플러그인이 준 상대경로를 **설치 폴더 안쪽**으로만 푼다.
 *  문자 검사(`..` 금지)만으로는 부족하다 — 심링크는 문자열에 안 나타난다. realpath 로 확인한다.
 */
function safeJoin(baseDir, rel) {
  if (!M._REL_PATH_RE.test(String(rel || ''))) return null;
  const abs = path.resolve(baseDir, rel);
  let realBase;
  let realAbs;
  try { realBase = fs.realpathSync(baseDir); } catch (_) { return null; }
  try { realAbs = fs.realpathSync(abs); } catch (_) { return null; }
  if (realAbs !== realBase && !realAbs.startsWith(realBase + path.sep)) return null;
  return realAbs;
}

// ── 마켓플레이스(목록) ───────────────────────────────────────────────────────

/**
 * 마켓플레이스 인덱스 읽기 — 리포를 얕게 받아 `codingpt-marketplace.json` 만 본다.
 *  캐시하지 않는다(목록은 자주 안 보고, 캐시하면 "왜 새 플러그인이 안 보이지"가 된다).
 */
async function fetchMarketplace(url, ref) {
  if (!M.isAllowedGitUrl(url)) throw new Error('git 주소가 이상해요(https 또는 ssh 만 받아요)');
  const tmp = fs.mkdtempSync(path.join(runtime.stateDir(), 'mkt-'));
  try {
    await cloneAt(url, ref || 'HEAD', tmp);
    const file = path.join(tmp, M.MARKETPLACE_FILENAME);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error(`이 저장소에 ${M.MARKETPLACE_FILENAME} 이 없어요`); }
    const parsed = M.parseMarketplace(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.marketplace;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

/** ref(브랜치·태그·커밋) → 그 시점 트리. 훅·서브모듈은 쓰지 않는다. */
async function cloneAt(url, ref, dest) {
  const common = ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
  await git([...common, 'init', '--quiet', dest]);
  await git([...common, 'remote', 'add', 'origin', url], { cwd: dest });
  try {
    await git([...common, 'fetch', '--depth', '1', '--no-tags', 'origin', ref], { cwd: dest });
  } catch (e) {
    throw new Error(`받아오지 못했어요: ${String(e.stderr || e.message).split('\n')[0]}`);
  }
  await git([...common, 'checkout', '--quiet', 'FETCH_HEAD'], { cwd: dest });
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: dest })).trim();
  return sha;
}

// ── 설치 ─────────────────────────────────────────────────────────────────────

/**
 * 미리보기 — **설치하지 않고** manifest 만 읽어 온다. 화면이 "무엇을 허용하는지"를 먼저 보여 줘야
 *  사용자가 동의할 수 있다(동의 없이 설치되는 경로를 만들지 않는다).
 */
async function preview(args) {
  const { url, ref, subdir } = normalizeSource(args);
  const tmp = fs.mkdtempSync(path.join(runtime.stateDir(), 'pv-'));
  try {
    const sha = await cloneAt(url, ref, tmp);
    const base = subdir ? safeJoin(tmp, subdir) : tmp;
    if (!base) throw new Error('subdir 가 이상해요');
    const parsed = readManifestAt(base);
    if (!parsed.ok) throw new Error(parsed.error);
    return {
      manifest: parsed.manifest,
      commit: sha,
      permissions: parsed.manifest.capabilities.map((c) => ({ kind: c, label: M.CAPABILITIES[c] })),
      // ★ 동의 지문 — 설치는 **이 값을 그대로 되돌려받아야** 통과한다. 화면이 A 를 보여 주고
      //   그 사이 리포가 바뀌어 B 가 깔리는 일을 막는 유일한 장치다(클라이언트는 이걸 만들 수 없다).
      consent: consentFingerprint(parsed.manifest),
      official: M.claimsOfficial(parsed.manifest.key) && isOfficialSource(url),
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function readManifestAt(dir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, M.MANIFEST_FILENAME), 'utf8')); }
  catch (_) { return { ok: false, error: `${M.MANIFEST_FILENAME} 을 읽을 수 없어요` }; }
  return M.parseManifest(raw, runtime.hostVersion ? runtime.hostVersion() : '');
}

function normalizeSource(args) {
  const a = args || {};
  const url = String(a.url || '');
  if (!M.isAllowedGitUrl(url)) throw new Error('git 주소가 이상해요(https 또는 ssh 만 받아요)');
  const ref = String(a.ref || 'HEAD');
  if (ref.length > 200 || /[\s;|&`$()<>]/.test(ref)) throw new Error('ref 가 이상해요');
  const subdir = a.subdir ? String(a.subdir) : '';
  if (subdir && !M._REL_PATH_RE.test(subdir)) throw new Error('subdir 가 이상해요');
  return { url, ref, subdir };
}

/**
 * 설치. `consent` 는 **미리보기에서 본 지문**이어야 한다 — 화면이 A 를 보여 주고 B 가 설치되는
 *  레이스를 막는다(리포가 그 사이에 바뀔 수 있다).
 */
async function install(args) {
  const a = args || {};
  const src = normalizeSource(a);
  const items = readList();
  if (items.length >= MAX_INSTALLED) throw new Error(`플러그인은 최대 ${MAX_INSTALLED}개까지예요`);

  const staging = fs.mkdtempSync(path.join(runtime.stateDir(), 'inst-'));
  let manifest;
  let sha;
  try {
    sha = await cloneAt(src.url, src.ref, staging);
    const base = src.subdir ? safeJoin(staging, src.subdir) : staging;
    if (!base) throw new Error('subdir 가 이상해요');
    const parsed = readManifestAt(base);
    if (!parsed.ok) throw new Error(parsed.error);
    manifest = parsed.manifest;

    if (M.claimsOfficial(manifest.key) && !isOfficialSource(src.url)) {
      // 우리 이름표는 우리 조직 리포에서만 나올 수 있다.
      throw new Error(`'${M.OFFICIAL_PUBLISHER}' 는 예약된 이름이에요`);
    }
    const fp = consentFingerprint(manifest);
    if (String(a.consent || '') !== fp) {
      throw new Error('허용 내용이 바뀌었어요 — 다시 확인해 주세요');
    }
    // 기여 파일들이 실제로 있고 폴더 안쪽인지 **설치 전에** 확인한다(반쪽 설치 금지).
    for (const s of manifest.contributes.skills) {
      const p = safeJoin(base, s.path);
      if (!p || !fs.statSync(p).isFile()) throw new Error(`스킬 파일이 없어요: ${s.path}`);
      if (fs.statSync(p).size > MAX_SKILL_BYTES) throw new Error(`스킬 파일이 너무 커요: ${s.path}`);
    }
    for (const lp of manifest.contributes.languagePacks) {
      const p = safeJoin(base, lp.path);
      if (!p || !fs.statSync(p).isFile()) throw new Error(`번역 파일이 없어요: ${lp.path}`);
      if (fs.statSync(p).size > MAX_PACK_BYTES) throw new Error(`번역 파일이 너무 커요: ${lp.path}`);
      const pack = readLanguagePack(p);
      if (!pack.ok) throw new Error(`${lp.path}: ${pack.error}`);
    }

    // 자리 잡기 — 기존 설치는 통째로 갈아 끼운다(부분 갱신은 옛 파일이 남는다).
    const dest = path.join(root(), manifest.key);
    fs.mkdirSync(root(), { recursive: true });
    const backup = fs.existsSync(dest) ? dest + '.old-' + Date.now() : null;
    if (backup) fs.renameSync(dest, backup);
    try {
      fs.cpSync(base, dest, { recursive: true, dereference: false });
      fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });   // 히스토리는 안 들고 있는다
    } catch (e) {
      if (backup) { try { fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(backup, dest); } catch (_) { /* noop */ } }
      throw e;
    }
    if (backup) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) { /* noop */ } }

    const item = {
      key: manifest.key,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: { kind: 'git', url: src.url, ref: src.ref, subdir: src.subdir, commit: sha },
      capabilities: manifest.capabilities,
      consent: fp,
      installedAt: new Date().toISOString(),
      enabled: true,
    };
    writeList([...items.filter((i) => i.key !== manifest.key), item]);
    applySkills();
    return { ok: true, plugin: item };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function isOfficialSource(url) {
  return /^https:\/\/github\.com\/codingpt(?:\/|$)/i.test(String(url || ''))
    || /^git@github\.com:codingpt\//i.test(String(url || ''));
}

async function uninstall(key) {
  if (!M.isPluginKey(key)) throw new Error('플러그인 id 가 이상해요');
  const items = readList();
  if (!items.some((i) => i.key === key)) throw new Error('설치되지 않은 플러그인이에요');
  try { fs.rmSync(path.join(root(), key), { recursive: true, force: true }); } catch (_) { /* noop */ }
  writeList(items.filter((i) => i.key !== key));
  applySkills();
  return { ok: true };
}

function setEnabled(key, enabled) {
  if (!M.isPluginKey(key)) throw new Error('플러그인 id 가 이상해요');
  const items = readList();
  const hit = items.find((i) => i.key === key);
  if (!hit) throw new Error('설치되지 않은 플러그인이에요');
  hit.enabled = !!enabled;
  writeList(items);
  applySkills();
  return { ok: true, plugin: hit };
}

// ── 기여 읽기(설치된 것들이 실제로 무엇을 꽂았는가) ──────────────────────────

function manifestOf(key) {
  const dir = path.join(root(), key);
  const parsed = readManifestAt(dir);
  return parsed.ok ? parsed.manifest : null;
}

function installed() {
  const items = readList();
  return items.map((i) => {
    const mf = manifestOf(i.key);
    return {
      ...i,
      // 폴더가 사라졌으면 목록에 있어도 **없다고 말한다**(눌러도 아무 일 없는 유령 방지).
      missing: !mf,
      contributes: mf ? mf.contributes : null,
    };
  });
}

/** 켜져 있는 플러그인들이 꽂은 저장 명령 — quick-commands 목록에 얹어 보여 준다. */
function contributedQuickCommands() {
  const out = [];
  for (const i of installed()) {
    if (!i.enabled || i.missing) continue;
    for (const [n, q] of (i.contributes.quickCommands || []).entries()) {
      out.push({
        id: `plugin:${i.key}#qc${n}`,
        label: q.label, kind: q.kind, text: q.text, prompt: q.prompt, agent: q.agent,
        target: q.target, scope: 'global',
        // 플러그인이 꽂은 항목은 사용자가 여기서 지울 수 없다(플러그인을 끄거나 지워야 한다).
        //  안 그러면 "지웠는데 다시 생기는" 항목이 된다.
        fromPlugin: { key: i.key, name: i.name },
        readOnly: true,
      });
    }
  }
  return out;
}

/** 켜져 있는 플러그인들이 꽂은 팔레트 명령. */
function contributedCommands() {
  const out = [];
  for (const i of installed()) {
    if (!i.enabled || i.missing) continue;
    for (const c of i.contributes.commands || []) {
      out.push({ id: `plugin:${i.key}/${c.id}`, title: c.title, run: c.run, fromPlugin: { key: i.key, name: i.name } });
    }
  }
  return out;
}

/** 번역 팩 — 우리 카탈로그와 같은 모양(한국어 원문 → 번역)만 받는다. */
function readLanguagePack(absPath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(absPath, 'utf8')); }
  catch (_) { return { ok: false, error: '번역 파일이 JSON 이 아니에요' }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '번역 파일은 객체여야 해요' };
  const keys = Object.keys(raw);
  if (keys.length > M.LIMITS.catalogEntries) return { ok: false, error: `번역 항목이 너무 많아요(${M.LIMITS.catalogEntries} 초과)` };
  const out = {};
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;   // 프로토타입 오염 차단
    const v = raw[k];
    if (typeof v !== 'string' || !v) continue;
    if (k.length > 500 || v.length > 2000) continue;
    out[k] = v;
  }
  return { ok: true, catalog: out };
}

/** 언어별로 합쳐 준다 — 화면(PC·폰)이 자기 카탈로그 **위에** 얹는다. */
function contributedLanguagePacks(lang) {
  const merged = {};
  for (const i of installed()) {
    if (!i.enabled || i.missing) continue;
    const dir = path.join(root(), i.key);
    for (const lp of i.contributes.languagePacks || []) {
      if (lang && lp.lang !== lang) continue;
      const p = safeJoin(dir, lp.path);
      if (!p) continue;
      const pack = readLanguagePack(p);
      if (!pack.ok) continue;
      const bucket = merged[lp.lang] || (merged[lp.lang] = {});
      Object.assign(bucket, pack.catalog);
    }
  }
  return merged;
}

/**
 * 에이전트 스킬 반영 — 켜진 플러그인의 SKILL.md 를 `~/.claude/skills/<name>/` 등에 놓는다.
 *  기존 `skills.js`(cpt 스텁)와 **같은 규율**이다: 남의 동명 스킬은 절대 안 건드리고, 우리가 놓은
 *  것만 회수한다(파일에 표식을 남겨 판정).
 */
const SKILL_MARK = '<!-- codingpt-plugin -->';

function agentSkillRoots() {
  const home = path.dirname(runtime.claudeHome());
  return [
    runtime.claudeHome(),
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
  ].filter((d) => { try { return fs.existsSync(d); } catch (_) { return false; } });
}

function applySkills() {
  const want = new Map();   // name → 내용
  for (const i of installed()) {
    if (!i.enabled || i.missing) continue;
    const dir = path.join(root(), i.key);
    for (const s of i.contributes.skills || []) {
      const p = safeJoin(dir, s.path);
      if (!p) continue;
      let body;
      try { body = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      // 표식을 맨 앞에 박는다 — 나중에 "이건 우리가 놓은 것"을 알아보고 회수할 수 있어야 한다.
      want.set(s.name, `${SKILL_MARK}\n${body}`);
    }
  }
  let wrote = 0;
  let removed = 0;
  for (const home of agentSkillRoots()) {
    const skillsDir = path.join(home, 'skills');
    // 우리가 놓았던 것 중 더 이상 필요 없는 것 회수
    let existing = [];
    try { existing = fs.readdirSync(skillsDir); } catch (_) { existing = []; }
    for (const name of existing) {
      if (want.has(name)) continue;
      const f = path.join(skillsDir, name, 'SKILL.md');
      try {
        if (!fs.readFileSync(f, 'utf8').startsWith(SKILL_MARK)) continue;   // 남의 것 — 불가침
        fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
        removed++;
      } catch (_) { /* 없음/접근불가 — noop */ }
    }
    for (const [name, body] of want) {
      const dir = path.join(skillsDir, name);
      const f = path.join(dir, 'SKILL.md');
      try {
        // 우리 표식이 없는 파일이 이미 있으면 **덮어쓰지 않는다**(사용자·다른 도구의 스킬).
        if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').startsWith(SKILL_MARK)) continue;
        if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === body) continue;   // 같으면 안 쓴다(mtime 보존)
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(f, body);
        wrote++;
      } catch (_) { /* noop */ }
    }
  }
  return { wrote, removed };
}

// ── RPC ──────────────────────────────────────────────────────────────────────

async function handle(method, params) {
  const p = params || {};
  switch (String(method || '')) {
    case 'plugins.list': return { plugins: installed(), capabilities: M.CAPABILITIES };
    case 'plugins.marketplace': return fetchMarketplace(p.url, p.ref);
    case 'plugins.preview': return preview(p);
    case 'plugins.install': return install(p);
    case 'plugins.uninstall': return uninstall(p.key);
    case 'plugins.setEnabled': return setEnabled(p.key, p.enabled);
    case 'plugins.contributions': return {
      quickCommands: contributedQuickCommands(),
      commands: contributedCommands(),
      languagePacks: contributedLanguagePacks(p.lang),
    };
    default: throw new Error(`알 수 없는 메서드: ${method}`);
  }
}

module.exports = {
  handle, installed, install, uninstall, setEnabled, preview, fetchMarketplace,
  contributedQuickCommands, contributedCommands, contributedLanguagePacks, applySkills,
  // 테스트용
  _consentFingerprint: consentFingerprint, _safeJoin: safeJoin, _readLanguagePack: readLanguagePack,
  _readList: readList, _writeList: writeList, _root: root, _isOfficialSource: isOfficialSource,
  SKILL_MARK,
};
