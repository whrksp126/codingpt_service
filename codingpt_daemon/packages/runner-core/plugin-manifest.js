/**
 * plugin-manifest — `codingpt-plugin.json` 의 계약(v1). **순수 판정만** 한다(파일·네트워크 없음).
 *
 * 무엇을 플러그인이라 부르는가:
 *  우리 제품의 정체성은 "네 PC 에서 도는 **네** 에이전트"다. 그래서 플러그인은 새 UI 를 그리는 것이
 *  아니라, **이미 있는 자리에 항목을 꽂는 것**이다:
 *   · `quickCommands` — 저장한 명령(터미널에서 도는 것)
 *   · `commands`      — 명령 팔레트 + 단축키 표
 *   · `skills`        — 에이전트가 읽는 SKILL.md (claude·codex·gemini 공통 규약)
 *   · `languagePacks` — 화면 문구 번역(우리 카탈로그와 같은 모양: 한국어 원문 → 번역)
 *
 * ⚠ **샌드박스 패널(플러그인이 그리는 UI)은 v1 에 없다.** Orca 는 iframe + 별도 워커로 그걸 하는데,
 *   우리는 화면이 PC 웹뷰와 RN 두 벌이라 샌드박스를 두 번 세워야 한다. 그 비용이 "플러그인이
 *   버튼 하나를 그릴 수 있다"의 값보다 크다. 대신 Orca 가 **아직 거부하는** `skills` 를 우리는
 *   연다 — BYO 제품에서 그게 제일 값진 기여다(오르카 소스 실측: marketplace 의 skills/themes
 *   카테고리는 `UNSUPPORTED_MARKETPLACE_CATEGORIES` 로 숨겨져 있다).
 *
 * 신뢰 표시(official/bundled)는 **호스트가 준다**. manifest 가 자기를 공식이라고 주장할 수 없다.
 */

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const ENGINE_RE = /^>=\d+\.\d+\.\d+$/;
/** 플러그인 파일 경로 — 플러그인 폴더 **안쪽**만. `..`·절대경로·심링크 탈출을 문자 단계에서 막는다. */
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-\/]{1,200}$/;

const MANIFEST_FILENAME = 'codingpt-plugin.json';
const MARKETPLACE_FILENAME = 'codingpt-marketplace.json';

/** 우리 이름표 — 남이 이 이름으로 공식인 척할 수 없게 예약한다. */
const OFFICIAL_PUBLISHER = 'codingpt';

const LIMITS = {
  quickCommands: 50,
  commands: 50,
  skills: 20,
  languagePacks: 14,      // 7개 언어 × 여유
  capabilities: 16,
  catalogEntries: 5000,
};

/**
 * 권한(capability) — **선언한 것만** 호스트가 허용한다. v0 은 닫힌 집합이다:
 *  새 Codingpt 에서 생긴 권한을 옛 호스트가 "모르는 값 = 무시" 로 조용히 통과시키면,
 *  사용자는 동의하지 않은 일이 벌어지는 걸 못 본다 → 모르는 값은 **설치 실패**다.
 */
const CAPABILITIES = {
  'quick-commands': '저장한 명령 목록에 항목을 추가해요',
  'palette-commands': '명령 팔레트와 단축키 표에 항목을 추가해요',
  'agent-skills': '이 PC 의 AI CLI 가 읽는 스킬 문서를 추가해요',
  'language-packs': '화면 문구 번역을 추가해요',
};

function isStr(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function fail(msg) { return { ok: false, error: msg }; }

/** 기여 항목들의 모양 검사 — 하나라도 이상하면 **플러그인 전체를 거부**한다(반만 설치 금지). */
function checkContributes(c) {
  if (c == null) return { ok: true, value: { quickCommands: [], commands: [], skills: [], languagePacks: [] } };
  if (typeof c !== 'object' || Array.isArray(c)) return fail('contributes 는 객체여야 해요');
  const known = ['quickCommands', 'commands', 'skills', 'languagePacks'];
  for (const k of Object.keys(c)) {
    // 모르는 기여 종류를 조용히 버리면, 사용자는 "설치했는데 아무 일도 안 일어나는" 상태가 된다.
    if (!known.includes(k)) return fail(`아직 지원하지 않는 기여 종류예요: ${k}`);
  }
  const out = { quickCommands: [], commands: [], skills: [], languagePacks: [] };

  for (const k of known) {
    const arr = c[k];
    if (arr == null) continue;
    if (!Array.isArray(arr)) return fail(`contributes.${k} 는 배열이어야 해요`);
    if (arr.length > LIMITS[k]) return fail(`contributes.${k} 는 최대 ${LIMITS[k]}개예요`);
  }

  for (const q of c.quickCommands || []) {
    if (!q || typeof q !== 'object') return fail('quickCommands 항목이 객체가 아니에요');
    if (!isStr(q.label, 40)) return fail('quickCommands.label 이 필요해요(1~40자)');
    if (q.kind !== 'shell' && q.kind !== 'agent') return fail('quickCommands.kind 는 shell 또는 agent 예요');
    if (q.kind === 'shell' && !isStr(q.text, 2000)) return fail('quickCommands.text 가 필요해요');
    if (q.kind === 'agent' && !isStr(q.prompt, 4000)) return fail('quickCommands.prompt 가 필요해요');
    if (q.agent != null && !isStr(q.agent, 40)) return fail('quickCommands.agent 가 이상해요');
    if (q.target != null && q.target !== 'new' && q.target !== 'current') return fail('quickCommands.target 이 이상해요');
    out.quickCommands.push({
      label: q.label, kind: q.kind,
      text: q.kind === 'shell' ? q.text : undefined,
      prompt: q.kind === 'agent' ? q.prompt : undefined,
      agent: q.agent || undefined,
      target: q.target || 'new',
    });
  }

  for (const cmd of c.commands || []) {
    if (!cmd || typeof cmd !== 'object') return fail('commands 항목이 객체가 아니에요');
    if (!isStr(cmd.id, 60) || !ID_RE.test(String(cmd.id).replace(/\./g, '-'))) return fail(`commands.id 가 이상해요: ${cmd.id}`);
    if (!isStr(cmd.title, 60)) return fail('commands.title 이 필요해요');
    if (!isStr(cmd.run, 2000)) return fail('commands.run 이 필요해요(터미널에서 실행할 문장)');
    // 기본 단축키는 **받지 않는다**: 남의 플러그인이 ⌘P 를 가져가면 사용자는 왜 안 먹는지 모른다.
    //  단축키는 설치 후 사용자가 설정에서 직접 준다(표에는 자동으로 올라간다).
    out.commands.push({ id: cmd.id, title: cmd.title, run: cmd.run });
  }

  for (const s of c.skills || []) {
    if (!s || typeof s !== 'object') return fail('skills 항목이 객체가 아니에요');
    if (!isStr(s.name, 60) || !ID_RE.test(s.name)) return fail(`skills.name 이 이상해요: ${s.name}`);
    if (!isStr(s.path, 200) || !REL_PATH_RE.test(s.path)) return fail(`skills.path 가 이상해요: ${s.path}`);
    out.skills.push({ name: s.name, path: s.path });
  }

  for (const lp of c.languagePacks || []) {
    if (!lp || typeof lp !== 'object') return fail('languagePacks 항목이 객체가 아니에요');
    if (!isStr(lp.lang, 12)) return fail('languagePacks.lang 이 필요해요');
    if (!isStr(lp.path, 200) || !REL_PATH_RE.test(lp.path)) return fail(`languagePacks.path 가 이상해요: ${lp.path}`);
    out.languagePacks.push({ lang: lp.lang, path: lp.path });
  }
  return { ok: true, value: out };
}

/** 기여 종류 → 그걸 하려면 반드시 선언해야 하는 권한. */
const NEEDED_CAP = {
  quickCommands: 'quick-commands',
  commands: 'palette-commands',
  skills: 'agent-skills',
  languagePacks: 'language-packs',
};

/**
 * manifest 파싱. 성공하면 **정규화된 값**을 준다(호출부가 원본을 다시 뒤지지 않게).
 * @param {unknown} raw  JSON.parse 결과
 * @param {string} hostVersion  이 데몬(=PC 앱) 버전 — engines 게이트
 */
function parseManifest(raw, hostVersion) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('manifest 가 객체가 아니에요');
  if (raw.manifestVersion !== 1) return fail('manifestVersion 은 1 이어야 해요');
  if (!isStr(raw.id, 40) || !ID_RE.test(raw.id)) return fail(`id 가 이상해요(소문자·숫자·하이픈): ${raw.id}`);
  if (!isStr(raw.publisher, 40) || !ID_RE.test(raw.publisher)) return fail(`publisher 가 이상해요: ${raw.publisher}`);
  if (!isStr(raw.name, 80)) return fail('name 이 필요해요');
  if (!isStr(raw.version, 40) || !SEMVER_RE.test(raw.version)) return fail(`version 이 semver 가 아니에요: ${raw.version}`);
  if (raw.description != null && !isStr(raw.description, 500)) return fail('description 이 너무 길어요(500자)');
  if (raw.homepage != null && !isStr(raw.homepage, 500)) return fail('homepage 가 이상해요');

  const eng = raw.engines && raw.engines.codingpt;
  if (!isStr(eng, 32) || !ENGINE_RE.test(eng)) return fail('engines.codingpt 는 ">=x.y.z" 여야 해요');
  if (hostVersion && !satisfiesEngine(hostVersion, eng)) {
    return fail(`이 플러그인은 CodingPT ${eng.slice(2)} 이상이 필요해요 (지금 ${hostVersion})`);
  }

  const caps = raw.capabilities == null ? [] : raw.capabilities;
  if (!Array.isArray(caps)) return fail('capabilities 는 배열이어야 해요');
  if (caps.length > LIMITS.capabilities) return fail('capabilities 가 너무 많아요');
  for (const c of caps) {
    // 모르는 권한은 **거부**한다(무시하면 사용자가 동의하지 않은 일이 조용히 벌어질 수 있다).
    if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, c)) return fail(`알 수 없는 권한이에요: ${c}`);
  }

  const contributes = checkContributes(raw.contributes);
  if (!contributes.ok) return contributes;

  // 선언한 권한과 실제 기여가 어긋나면 거부 — "권한은 안 받고 일은 하는" 플러그인을 막는다.
  for (const [kind, cap] of Object.entries(NEEDED_CAP)) {
    if (contributes.value[kind].length && !caps.includes(cap)) {
      return fail(`${kind} 를 넣으려면 '${cap}' 권한을 선언해야 해요`);
    }
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: 1,
      id: raw.id,
      publisher: raw.publisher,
      key: `${raw.publisher}.${raw.id}`,
      name: raw.name,
      version: raw.version,
      description: raw.description || '',
      homepage: raw.homepage || '',
      engines: { codingpt: eng },
      capabilities: [...new Set(caps)],
      contributes: contributes.value,
    },
  };
}

/** `>=x.y.z` 게이트. 프리릴리스 꼬리는 순서 비교에서 무시한다. */
function satisfiesEngine(hostVersion, range) {
  const min = String(range).slice(2);
  const p = (v) => String(v).split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const a = p(hostVersion);
  const b = p(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/** `<publisher>.<id>` — 설치 폴더 이름이자 유일한 식별자. */
function isPluginKey(v) {
  if (typeof v !== 'string') return false;
  const parts = v.split('.');
  return parts.length === 2 && ID_RE.test(parts[0]) && ID_RE.test(parts[1]);
}

/** 우리 이름표를 사칭하는가 — 목록·설치 양쪽에서 막는다. */
function claimsOfficial(key) {
  return typeof key === 'string' && key.split('.')[0] === OFFICIAL_PUBLISHER;
}

/**
 * 마켓플레이스 인덱스(`codingpt-marketplace.json`) 파싱.
 *  모양은 오르카와 같은 결이다 — git 저장소 하나가 곧 마켓플레이스다. 우리 서버가 없다.
 */
function parseMarketplace(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('마켓플레이스 파일이 객체가 아니에요');
  if (!isStr(raw.name, 80)) return fail('name 이 필요해요');
  if (!Array.isArray(raw.plugins)) return fail('plugins 는 배열이어야 해요');
  if (raw.plugins.length > 2000) return fail('plugins 가 너무 많아요');
  const out = [];
  const seen = new Set();
  for (const p of raw.plugins) {
    if (!p || typeof p !== 'object') return fail('plugins 항목이 객체가 아니에요');
    if (!isPluginKey(p.id)) return fail(`plugins.id 가 <publisher>.<id> 가 아니에요: ${p.id}`);
    if (seen.has(p.id)) return fail(`plugins 에 같은 id 가 두 번 있어요: ${p.id}`);
    seen.add(p.id);
    const src = p.source;
    if (!src || src.kind !== 'git' || !isStr(src.url, 2000) || !isAllowedGitUrl(src.url)) {
      return fail(`plugins.source 가 이상해요(https/ssh git URL 필요): ${p.id}`);
    }
    // ref 를 안 적으면 "원격 기본 브랜치"가 되어 **같은 목록이 날마다 다른 것을 설치**한다.
    if (!isStr(src.ref, 200)) return fail(`plugins.source.ref 가 필요해요(브랜치·태그·커밋): ${p.id}`);
    out.push({
      id: p.id,
      source: { kind: 'git', url: src.url, ref: src.ref, subdir: isStr(src.subdir, 200) && REL_PATH_RE.test(src.subdir) ? src.subdir : '' },
      description: isStr(p.description, 500) ? p.description : '',
      categories: Array.isArray(p.categories) ? p.categories.filter((c) => isStr(c, 40)).slice(0, 12) : [],
    });
  }
  return { ok: true, marketplace: { name: raw.name, plugins: out } };
}

/** 설치가 받아 주는 git URL 모양 — 로컬 경로·file:// 는 안 받는다(임의 파일 복사 경로가 된다). */
function isAllowedGitUrl(url) {
  const s = String(url || '').trim();
  if (/^https:\/\/[^\s]+$/i.test(s)) return true;
  if (/^ssh:\/\/[^\s]+$/i.test(s)) return true;
  if (/^[^\s@/:]+@[^\s:]+:[^\s]+$/.test(s)) return true;   // git@github.com:owner/repo.git
  return false;
}

module.exports = {
  MANIFEST_FILENAME, MARKETPLACE_FILENAME, OFFICIAL_PUBLISHER, CAPABILITIES, LIMITS,
  parseManifest, parseMarketplace, satisfiesEngine, isPluginKey, claimsOfficial, isAllowedGitUrl,
  _ID_RE: ID_RE, _REL_PATH_RE: REL_PATH_RE,
};
