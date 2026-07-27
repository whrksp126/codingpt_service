/**
 * agents.js — 이 PC에 설치된 AI 코딩 에이전트 **카탈로그 · 감지 · 배선 상태**의 단일 출처.
 *
 * 왜 생겼나(2026-07-27): `shim.js` 가 설치 여부와 무관하게 `claude`/`codex` 래퍼를 만들고 있었다.
 *  그래서 codex 를 깔지도 않은 사용자가 `codex` 를 치면 OS 의 표준 `command not found` 대신
 *  `cpt-shim: codex 실행 파일을 찾을 수 없습니다` 가 떴다 — 사용자 눈에는 "CodingPT 가 codex 를
 *  망가뜨렸다"로 읽힌다(실제 제보). 없는 걸 감싸지 않는 것이 이 파일의 첫 존재 이유다.
 *
 * 배선 등급(tier) — **UI 에 이 값을 정직하게 표시한다.** 뭉개면 "폰에서 승인 카드를 기다렸는데
 *  아무것도 안 오는" 경험이 된다.
 *   · 'full'    claude — 실행 인자 `--settings` 로 훅 7종 주입 → 상태·**원격 승인**·알림·트랜스크립트
 *   · 'partial' codex  — 실행 인자 `-c notify=[...]` 만 → 알림/턴 종료. **원격 승인 없음**
 *   · 'launch'  그 외  — 실행·탭 로고까지만. 배선 0
 *
 * ⚠ 'launch' 를 'partial' 로 올리려면 그 에이전트의 **개인 설정 파일**(예: `~/.gemini/settings.json`)
 *  에 우리 훅을 써넣어야 한다(cmux 가 그렇게 한다). 우리는 사용자 확정(2026-07-27)으로 **하지 않는다**:
 *  ① 남의 개인 파일을 우리가 수정 ② CodingPT 밖에서 켜도 우리 훅이 발화 ③ 앱을 지우면 그 줄이 남아
 *  "cpt 를 못 찾겠다" 에러 — 위의 codex shim 사고와 똑같은 종류. claude/codex 는 **실행 인자만으로**
 *  배선되므로 사용자 파일 무오염이 성립한다(이 비대칭이 두 에이전트에 집중하는 이유).
 *
 * 설치 명령은 **이 파일(로컬 카탈로그)에만** 둔다. 서버가 내려준 문자열을 터미널에서 실행하면
 *  그건 원격 코드 실행 통로다. 그리고 명령은 낡을 수 있으므로 `docs` 를 항상 함께 싣고 UI 는
 *  "권장 설치 명령"으로 부른다. 설치 성공 판정은 **명령의 종료 코드가 아니라 재감지 결과**다
 *  (npm 전역 bin 이 PATH 에 없어 "성공했는데 안 잡히는" 경우가 흔하다).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const runtime = require('./runtime');
const config = require('./config');

// 우리 래퍼 디렉토리 — 감지에서 **반드시 제외**한다(제외 안 하면 우리 래퍼를 발견하고
//  "설치됨"이라 답한다 = 자기 자신을 근거로 하는 순환 판정).
function binDir() { return path.join(runtime.stateDir(), 'bin'); }

/**
 * 검증된 카탈로그(2026-07-27 실측). install[].cmd 는 그날 공식 문서·npm 레지스트리·HTTP 200 으로
 *  각각 확인한 것만 싣는다. 확인 못 한 방법은 **넣지 않는다**(사용자 셸에 들어갈 문자열이다).
 */
const CATALOG = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    tier: 'full',
    docs: 'https://code.claude.com/docs/en/setup',
    install: [
      { label: '공식 설치 스크립트 (권장)', cmd: 'curl -fsSL https://claude.ai/install.sh | bash' },
      { label: 'Homebrew', cmd: 'brew install --cask claude-code' },
      { label: 'npm', cmd: 'npm install -g @anthropic-ai/claude-code' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    tier: 'partial',
    docs: 'https://developers.openai.com/codex/cli',
    install: [
      { label: '공식 설치 스크립트 (권장)', cmd: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      { label: 'npm', cmd: 'npm install -g @openai/codex' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    tier: 'launch',
    docs: 'https://github.com/google-gemini/gemini-cli',
    install: [
      { label: 'npm', cmd: 'npm install -g @google/gemini-cli' },
      { label: 'Homebrew', cmd: 'brew install gemini-cli' },
    ],
  },
  {
    id: 'cursor-agent',
    name: 'Cursor CLI',
    bin: 'cursor-agent',
    tier: 'launch',
    docs: 'https://cursor.com/docs/cli',
    install: [
      { label: '공식 설치 스크립트', cmd: 'curl https://cursor.com/install -fsS | bash' },
    ],
  },
  {
    id: 'opencode',
    name: 'opencode',
    bin: 'opencode',
    tier: 'launch',
    docs: 'https://opencode.ai',
    install: [
      { label: 'npm', cmd: 'npm install -g opencode-ai' },
    ],
  },
];

const byId = new Map(CATALOG.map((a) => [a.id, a]));

/** 배선(훅 주입)이 **구조적으로** 가능한 등급인가. 'launch' 는 아무리 켜도 되는 게 없다. */
function wirable(tier) { return tier === 'full' || tier === 'partial'; }

// ── PATH 후보 ────────────────────────────────────────────────────────────────
// 함정: 데몬은 PC 앱(Finder/launchd)이 띄우는 사이드카라 **로그인 셸의 PATH 를 물려받지 않는다.**
//  `process.env.PATH` 만 보면 `~/.local/bin`·`/opt/homebrew/bin` 이 없어서 "설치 안 됨"이라
//  오답한다(같은 뿌리의 사고 전례: Finder 실행 앱의 LANG 부재 → tmux 목록 파싱 전멸).
//  그래서 ① process PATH ② 표준 설치 위치 고정 목록 ③ 로그인 셸 PATH(비동기·타임아웃) 의 합집합을 쓴다.
const FALLBACK_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/usr/bin',
  '/bin',
];

let loginPathCache = null; // string[] | null — 프로세스 수명 동안 1회만 조사

/**
 * 로그인 셸의 PATH — 사용자의 실제 터미널이 보는 것과 같은 목록. 실패하면 조용히 포기한다
 *  (없어도 ①②로 대부분 잡힌다 — 이건 정확도를 올리는 보강일 뿐 필수 경로가 아니다).
 *  `-l` 만 쓴다(`-i` 는 사용자 rc 전체를 돌려 느리고 프롬프트 이스케이프가 섞인다).
 */
function probeLoginPath() {
  if (loginPathCache) return Promise.resolve(loginPathCache);
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 2500, encoding: 'utf8' }, (err, stdout) => {
      const dirs = String(stdout || '').trim().split(':').filter(Boolean);
      loginPathCache = err ? [] : dirs;
      resolve(loginPathCache);
    });
  });
}

// 테스트 전용 탐색 경로 고정 — 감지 결과가 **이 머신에 무엇이 깔려 있는지**에 좌우되면 테스트가
//  기계마다 다른 답을 낸다("codex 없으면 래퍼 없음"을 codex 가 깔린 PC 에서 검증할 수 없다).
let searchOverride = null;

function searchDirs(extra) {
  const out = [];
  const seen = new Set();
  const bin = binDir();
  if (searchOverride) return searchOverride.filter((d) => d && d !== bin);
  const push = (d) => {
    if (!d || d === bin || seen.has(d)) return; // 우리 래퍼 디렉토리 제외(순환 판정 방지)
    seen.add(d);
    out.push(d);
  };
  for (const d of String(process.env.PATH || '').split(':')) push(d);
  for (const d of extra || []) push(d);
  for (const d of FALLBACK_DIRS) push(d);
  return out;
}

/** 실행 가능한 파일을 후보 디렉토리에서 찾는다(첫 히트). */
function findBin(name, dirs) {
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      const st = fs.statSync(p);            // 디렉토리가 X_OK 를 통과하므로 파일 확인 필수
      if (st.isDirectory()) continue;
      return p;
    } catch (_) { /* 다음 후보 */ }
  }
  return null;
}

// ── 감지 ─────────────────────────────────────────────────────────────────────
// 감지 결과 캐시: 설정 화면이 열릴 때마다 · 폴링마다 5개 바이너리를 stat 하면 낭비다.
//  TTL 은 짧게(설치 직후 재감지가 목적) 두고, 설치 시트는 refresh:true 로 강제 재조사한다.
let cache = { at: 0, items: null };
const CACHE_MS = 4000;

/** 버전 문자열 캐시 — `--version` 은 프로세스 스폰이라 비싸다(에이전트당 100~400ms). */
const versionCache = new Map(); // binPath → { at, version }
const VERSION_MS = 60000;

function probeVersion(binPath) {
  const hit = versionCache.get(binPath);
  if (hit && Date.now() - hit.at < VERSION_MS) return hit.version;
  let version = null;
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
      // 우리 래퍼를 타지 않게 PATH 에서 binDir 제외(래퍼 → REAL 재귀 방지의 안전벨트).
      env: { ...process.env, PATH: searchDirs([]).join(':') },
    });
    // 에이전트마다 형식이 다르다: "2.1.220 (Claude Code)" · "codex-cli 0.145.0" 등.
    //  버전처럼 보이는 첫 토큰만 뽑고, 없으면 첫 줄을 그대로 쓴다(추측해서 꾸미지 않는다).
    const line = String(out || '').split('\n').find((l) => l.trim()) || '';
    const m = line.match(/\d+\.\d+\.\d+[\w.-]*/);
    version = m ? m[0] : line.trim().slice(0, 40) || null;
  } catch (_) { version = null; } // 설치는 됐는데 --version 이 없거나 실패 — 그대로 null(거짓 표기 금지)
  versionCache.set(binPath, { at: Date.now(), version });
  return version;
}

/**
 * 사용자가 결정한 배선 on/off. **'아직 안 물어봄' 과 '끔' 을 구분한다** — 뭉개면 온보딩을 아직
 *  안 본 사용자를 "사용자가 끄기로 했다"로 취급해 기능이 조용히 사라진다(같은 실수의 전례가 있다).
 *   · 키 없음 = 아직 안 물어봄 → 동작은 **켜짐**(권장 기본값), 온보딩이 물어볼 대상
 *   · true/false = 사용자가 명시적으로 결정
 */
function wiredPrefs() {
  const c = config.load() || {};
  const a = c.agents;
  return a && typeof a === 'object' ? a : {};
}

function isWired(id) {
  const a = byId.get(id);
  if (!a || !wirable(a.tier)) return false;   // 등급이 안 되면 무조건 false(켠 척 금지)
  const prefs = wiredPrefs();
  return prefs[id] === undefined ? true : !!prefs[id];
}

/** 사용자가 명시적으로 결정한 적이 있나(온보딩 표시 여부 판단용). */
function wireDecided(id) { return wiredPrefs()[id] !== undefined; }

function setWired(id, on) {
  const a = byId.get(id);
  if (!a) throw new Error('unknown agent: ' + id);
  if (!wirable(a.tier)) throw new Error('배선을 지원하지 않는 에이전트입니다: ' + id);
  const c = config.load();
  if (!c) throw new Error('페어링 전에는 저장할 수 없습니다');
  c.agents = { ...(c.agents && typeof c.agents === 'object' ? c.agents : {}), [id]: !!on };
  config.save(c);
  cache = { at: 0, items: null };
  return isWired(id);
}

/** 온보딩을 본 시점 — 있으면 PC 앱이 첫 실행 스텝을 다시 띄우지 않는다. */
function onboardedAt() { return (config.load() || {}).agentsOnboardedAt || null; }
function markOnboarded() {
  const c = config.load();
  if (!c) return null;
  c.agentsOnboardedAt = new Date().toISOString();
  config.save(c);
  return c.agentsOnboardedAt;
}

/**
 * 감지 + 상태. 동기 경로만으로도 정답을 내지만(대부분), 로그인 셸 PATH 를 아직 못 조사했으면
 *  한 번 조사해 캐시한다(다음 호출부터 정확도 ↑).
 * @param {{refresh?:boolean, version?:boolean}} opt
 * @returns {Promise<Array>} [{id,name,bin,tier,docs,install,installed,path,version,wired,wirable,decided}]
 */
async function list(opt) {
  const refresh = !!(opt && opt.refresh);
  if (!refresh && cache.items && Date.now() - cache.at < CACHE_MS) return cache.items;
  const extra = await probeLoginPath();
  const dirs = searchDirs(extra);
  const wantVersion = !opt || opt.version !== false;
  const items = CATALOG.map((a) => {
    const found = findBin(a.bin, dirs);
    return {
      id: a.id,
      name: a.name,
      bin: a.bin,
      tier: a.tier,
      docs: a.docs,
      install: a.install,
      installed: !!found,
      path: found,
      version: found && wantVersion ? probeVersion(found) : null,
      wirable: wirable(a.tier),
      wired: !!found && isWired(a.id),
      decided: wireDecided(a.id),
    };
  });
  cache = { at: Date.now(), items };
  return items;
}

/** 감지 결과에서 한 에이전트의 실제 바이너리 경로(shim 생성용). 없으면 null. */
async function resolveBin(id) {
  const items = await list({ version: false });
  const hit = items.find((i) => i.id === id);
  return hit && hit.installed ? hit.path : null;
}

/** 동기 해석 — shim 생성 경로처럼 await 를 못 쓰는 자리에서 쓴다(로그인 셸 PATH 는 캐시된 것만). */
function resolveBinSync(id) {
  const a = byId.get(id);
  if (!a) return null;
  return findBin(a.bin, searchDirs(loginPathCache || []));
}

/** 터미널에서 실행할 명령 — 지금은 바이너리 이름 그대로다(런치 인자 미도입, 사용자 확정 2026-07-27). */
function launchCommand(id) {
  const a = byId.get(id);
  return a ? a.bin : null;
}

module.exports = {
  CATALOG,
  list,
  isWired,
  setWired,
  wireDecided,
  onboardedAt,
  markOnboarded,
  resolveBin,
  resolveBinSync,
  launchCommand,
  wirable,
  _internals: {
    findBin,
    searchDirs,
    probeVersion,
    resetCache: () => { cache = { at: 0, items: null }; versionCache.clear(); loginPathCache = null; },
    setLoginPath: (dirs) => { loginPathCache = dirs; },
    // 테스트에서만 쓴다: null 로 되돌리면 실제 PATH 탐색으로 복귀.
    setSearchOverride: (dirs) => {
      searchOverride = dirs;
      cache = { at: 0, items: null };
      versionCache.clear();
      if (dirs) loginPathCache = [];   // 로그인 셸 조사(느림·비결정)를 건너뛴다
    },
  },
};
