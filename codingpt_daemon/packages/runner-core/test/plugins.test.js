// plugins — 계약 판정과 **진짜 설치**(로컬 git 저장소를 만들어 끝까지 돌린다).
//
// 여기서 지키려는 것:
//  ① 사용자가 **동의한 것만** 설치된다(권한이 늘어난 업데이트는 다시 물어야 한다).
//  ② 플러그인이 준 경로가 설치 폴더 **밖**으로 못 나간다(심링크 포함).
//  ③ 남의 스킬 파일을 절대 안 덮고 안 지운다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const runtime = require('../runtime');
const M = require('../plugin-manifest');

// 각 테스트가 자기 stateDir·claudeHome 을 갖게 한다.
//
// ★ `runtime.init` 은 `home` 같은 건 모른다 — **키 이름은 root/stateDir/claudeHome/codexHome** 이다.
//   처음에 `{ home }` 을 넘겨 놓고 격리했다고 믿었다가 **진짜 `~/.claude/skills` 에 파일을 썼다**
//   (Claude 가 그 스킬을 인식해서 알았다). 그래서 아래 guard 가 있다 — 격리가 안 됐으면
//   테스트가 파일을 만지기 전에 **먼저 실패**한다.
let sandbox;
function useSandbox() {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-plug-'));
  runtime.init({
    root: sandbox,
    stateDir: path.join(sandbox, '.codingpt'),
    claudeHome: path.join(sandbox, '.claude'),
    codexHome: path.join(sandbox, '.codex'),
  });
  fs.mkdirSync(path.join(sandbox, '.codingpt'), { recursive: true });
  guardIsolated();
  return sandbox;
}

/** 격리 확인 — 실제 홈을 가리키고 있으면 **아무것도 하기 전에** 멈춘다. */
function guardIsolated() {
  const real = os.homedir();
  for (const [name, dir] of [['stateDir', runtime.stateDir()], ['claudeHome', runtime.claudeHome()]]) {
    assert.ok(dir.startsWith(os.tmpdir()), `${name} 가 샌드박스 밖이다: ${dir}`);
    assert.ok(!dir.startsWith(path.join(real, '.')), `${name} 가 진짜 홈이다: ${dir}`);
  }
}

// ── 계약(순수 판정) ──────────────────────────────────────────────────────────

const GOOD = {
  manifestVersion: 1,
  id: 'deploy-helper',
  publisher: 'acme',
  name: '배포 도우미',
  version: '1.2.0',
  engines: { codingpt: '>=0.1.0' },
  capabilities: ['quick-commands'],
  contributes: { quickCommands: [{ label: '배포', kind: 'shell', text: './deploy.sh' }] },
};

test('manifest — 제대로 된 것은 통과하고 정규화된 값을 준다', () => {
  const r = M.parseManifest(GOOD, '0.1.235');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.manifest.key, 'acme.deploy-helper');
  assert.strictEqual(r.manifest.contributes.quickCommands[0].target, 'new');   // 기본값이 채워진다
  assert.deepStrictEqual(r.manifest.contributes.commands, []);
});

test('★ 권한을 선언하지 않고 기여하면 거부한다', () => {
  const bad = { ...GOOD, capabilities: [] };
  const r = M.parseManifest(bad, '0.1.235');
  assert.ok(!r.ok);
  assert.match(r.error, /quick-commands/);
});

test('★ 모르는 권한·모르는 기여 종류는 무시가 아니라 거부다', () => {
  // 무시하면 사용자는 "설치했는데 아무 일도 안 일어나는" 상태가 되고,
  // 반대로 새 권한을 옛 호스트가 무시하면 **동의 안 한 일**이 벌어질 수 있다.
  assert.ok(!M.parseManifest({ ...GOOD, capabilities: ['file-system'] }, '0.1.0').ok);
  assert.ok(!M.parseManifest({ ...GOOD, contributes: { panels: [] } }, '0.1.0').ok);
});

test('engines — 호스트가 낮으면 거부, 높거나 같으면 통과', () => {
  const need = { ...GOOD, engines: { codingpt: '>=0.2.0' } };
  assert.ok(!M.parseManifest(need, '0.1.235').ok);
  assert.ok(M.parseManifest(need, '0.2.0').ok);
  assert.ok(M.parseManifest(need, '1.0.0').ok);
  // 버전을 모르면(헤드리스) 막지 않는다
  assert.ok(M.parseManifest(need, '').ok);
});

test('★ 경로에 상위 탈출·절대경로가 있으면 거부한다', () => {
  for (const p of ['../../../etc/passwd', '/etc/passwd', 'a/../../b', './../x']) {
    const bad = { ...GOOD, capabilities: ['agent-skills'], contributes: { skills: [{ name: 'x', path: p }] } };
    assert.ok(!M.parseManifest(bad, '0.1.0').ok, p);
  }
});

test('마켓플레이스 인덱스 — ref 없는 항목은 거부(같은 목록이 날마다 달라진다)', () => {
  const base = { name: '테스트 마켓', plugins: [{ id: 'acme.a', source: { kind: 'git', url: 'https://x/y.git', ref: 'main' } }] };
  assert.ok(M.parseMarketplace(base).ok);
  const noRef = JSON.parse(JSON.stringify(base));
  delete noRef.plugins[0].source.ref;
  assert.ok(!M.parseMarketplace(noRef).ok);
  const dup = { name: 'm', plugins: [base.plugins[0], base.plugins[0]] };
  assert.ok(!M.parseMarketplace(dup).ok);
});

test('git 주소 — 로컬 경로·file:// 는 받지 않는다', () => {
  assert.ok(M.isAllowedGitUrl('https://github.com/a/b.git'));
  assert.ok(M.isAllowedGitUrl('git@github.com:a/b.git'));
  assert.ok(!M.isAllowedGitUrl('file:///etc'));
  assert.ok(!M.isAllowedGitUrl('/Users/me/repo'));
  assert.ok(!M.isAllowedGitUrl('http://insecure/a.git'));
});

// ── 진짜 설치 ────────────────────────────────────────────────────────────────

/** 로컬 git 저장소를 만들어 플러그인처럼 꾸민다(네트워크 없이 설치 경로를 끝까지 돈다). */
function makeRepo(dir, manifest, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, M.MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files || {})) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g(['init', '--quiet', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '--quiet', '-m', 'init']);
  return dir;
}

/** 설치기는 https/ssh 만 받는다 — 테스트에서는 그 관문만 잠시 넓힌다(경로 검증은 그대로 탄다). */
async function withLocalGit(fn) {
  const orig = M.isAllowedGitUrl;
  M.isAllowedGitUrl = (u) => orig(u) || /^\/|^[A-Za-z]:\\/.test(String(u || ''));
  // ⚠ **await 해야 한다.** sync try/finally 로 두면 fn() 이 promise 를 돌려주는 순간 finally 가
  //   먼저 돌아 원복돼 버린다 — 정작 설치가 실행될 때는 패치가 이미 풀려 있다(실제로 그렇게 깨졌다).
  try { return await fn(); } finally { M.isAllowedGitUrl = orig; }
}

test('★ 설치 왕복 — 미리보기 지문으로 동의하고 설치하면 목록·기여가 보인다', async () => {
  const home = useSandbox();
  const P = require('../plugins');
  const repo = makeRepo(path.join(home, 'repo'), {
    ...GOOD,
    capabilities: ['quick-commands', 'agent-skills', 'language-packs'],
    contributes: {
      quickCommands: [{ label: '배포', kind: 'shell', text: './deploy.sh' }],
      skills: [{ name: 'deploy-helper', path: 'SKILL.md' }],
      languagePacks: [{ lang: 'en', path: 'i18n/en.json' }],
    },
  }, {
    'SKILL.md': '# 배포 도우미\n',
    'i18n/en.json': JSON.stringify({ '배포': 'Deploy' }),
  });

  await withLocalGit(async () => {
    const pv = await P.preview({ url: repo, ref: 'main' });
    assert.strictEqual(pv.manifest.key, 'acme.deploy-helper');
    assert.strictEqual(pv.permissions.length, 3);
    assert.match(pv.commit, /^[0-9a-f]{40}$/);

    // 미리보기가 준 지문을 그대로 쓴다 — 화면이 계산할 수 있으면 동의라는 장치가 무의미해진다.
    assert.strictEqual(pv.consent, P._consentFingerprint(pv.manifest));
    const fp = pv.consent;
    // 동의 지문이 다르면 설치되지 않는다
    await assert.rejects(() => P.install({ url: repo, ref: 'main', consent: 'nope' }), /다시 확인/);

    const r = await P.install({ url: repo, ref: 'main', consent: fp });
    assert.ok(r.ok);
    assert.strictEqual(r.plugin.source.commit, pv.commit);   // **커밋으로 고정**된다
  });

  const list = P.installed();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].missing, false);
  // git 히스토리는 들고 있지 않는다
  assert.ok(!fs.existsSync(path.join(P._root(), 'acme.deploy-helper', '.git')));

  const qc = P.contributedQuickCommands();
  assert.strictEqual(qc.length, 1);
  assert.strictEqual(qc[0].label, '배포');
  assert.ok(qc[0].readOnly, '플러그인이 꽂은 항목은 사용자가 직접 못 지운다');

  const packs = P.contributedLanguagePacks('en');
  assert.strictEqual(packs.en['배포'], 'Deploy');
});

test('★ 권한이 늘어난 업데이트는 옛 동의로 설치되지 않는다', async () => {
  const home = useSandbox();
  const P = require('../plugins');
  const repo = path.join(home, 'repo2');
  makeRepo(repo, { ...GOOD }, {});
  await withLocalGit(async () => {
    const pv = await P.preview({ url: repo, ref: 'main' });
    const oldFp = pv.consent;
    await P.install({ url: repo, ref: 'main', consent: oldFp });

    // 권한을 하나 더 요구하도록 리포를 고친다
    fs.writeFileSync(path.join(repo, M.MANIFEST_FILENAME), JSON.stringify({
      ...GOOD, version: '1.3.0',
      capabilities: ['quick-commands', 'agent-skills'],
      contributes: { ...GOOD.contributes, skills: [{ name: 'x', path: 'SKILL.md' }] },
    }));
    fs.writeFileSync(path.join(repo, 'SKILL.md'), '# x\n');
    const g = (a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    g(['add', '-A']); g(['commit', '--quiet', '-m', 'more perms']);

    await assert.rejects(() => P.install({ url: repo, ref: 'main', consent: oldFp }), /다시 확인/);
  });
});

test("★ 'codingpt' 이름표는 우리 리포에서만 나올 수 있다", async () => {
  const home = useSandbox();
  const P = require('../plugins');
  const repo = makeRepo(path.join(home, 'repo3'), { ...GOOD, publisher: 'codingpt' }, {});
  await withLocalGit(async () => {
    const pv = await P.preview({ url: repo, ref: 'main' });
    await assert.rejects(
      () => P.install({ url: repo, ref: 'main', consent: pv.consent }),
      /예약된 이름/);
  });
  assert.ok(P._isOfficialSource('https://github.com/codingpt/plugins.git'));
  assert.ok(!P._isOfficialSource('https://github.com/codingpt-fake/plugins.git'));
});

test('★ 심링크로 설치 폴더 밖을 가리키면 읽지 않는다', () => {
  const home = useSandbox();
  const P = require('../plugins');
  const base = path.join(home, 'base');
  fs.mkdirSync(base, { recursive: true });
  const outside = path.join(home, 'secret.txt');
  fs.writeFileSync(outside, 'top secret');
  try { fs.symlinkSync(outside, path.join(base, 'link.txt')); }
  catch (_) { return; }   // 심링크를 못 만드는 파일시스템 — 이 검사는 건너뛴다
  assert.strictEqual(P._safeJoin(base, 'link.txt'), null, '밖을 가리키는 심링크는 거부');
  fs.writeFileSync(path.join(base, 'ok.txt'), 'fine');
  assert.ok(P._safeJoin(base, 'ok.txt'));
  assert.strictEqual(P._safeJoin(base, '../secret.txt'), null);
});

test('★ 남의 스킬 파일은 덮지도 지우지도 않는다', () => {
  const home = useSandbox();
  const P = require('../plugins');
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'mine', 'SKILL.md'), '# 내가 직접 쓴 스킬\n');
  // 같은 이름으로 우리가 놓으려 해도 덮지 않는다
  fs.mkdirSync(path.join(P._root(), 'acme.x'), { recursive: true });
  fs.writeFileSync(path.join(P._root(), 'acme.x', M.MANIFEST_FILENAME), JSON.stringify({
    ...GOOD, id: 'x', capabilities: ['agent-skills'],
    contributes: { skills: [{ name: 'mine', path: 'S.md' }] },
  }));
  fs.writeFileSync(path.join(P._root(), 'acme.x', 'S.md'), '# 플러그인 스킬\n');
  P._writeList([{ key: 'acme.x', enabled: true, capabilities: ['agent-skills'] }]);

  guardIsolated();
  P.applySkills();
  assert.match(fs.readFileSync(path.join(skills, 'mine', 'SKILL.md'), 'utf8'), /내가 직접 쓴 스킬/);

  // 플러그인을 끄면 **우리 것만** 회수한다 — 남의 것은 그대로 남는다
  P._writeList([]);
  guardIsolated();
  P.applySkills();
  assert.ok(fs.existsSync(path.join(skills, 'mine', 'SKILL.md')));
});

test('스킬 반영 — 우리가 놓은 것은 끄면 회수된다', () => {
  const home = useSandbox();
  const P = require('../plugins');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(P._root(), 'acme.y'), { recursive: true });
  fs.writeFileSync(path.join(P._root(), 'acme.y', M.MANIFEST_FILENAME), JSON.stringify({
    ...GOOD, id: 'y', capabilities: ['agent-skills'],
    contributes: { skills: [{ name: 'y-skill', path: 'S.md' }] },
  }));
  fs.writeFileSync(path.join(P._root(), 'acme.y', 'S.md'), '# y\n');
  P._writeList([{ key: 'acme.y', enabled: true }]);
  guardIsolated();
  P.applySkills();
  const f = path.join(home, '.claude', 'skills', 'y-skill', 'SKILL.md');
  assert.ok(fs.existsSync(f));
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(P.SKILL_MARK), '우리 표식이 있어야 회수할 수 있다');

  P._writeList([{ key: 'acme.y', enabled: false }]);
  guardIsolated();
  P.applySkills();
  assert.ok(!fs.existsSync(f), '끄면 사라진다');
});

test('번역 팩 — 프로토타입 오염 키는 버린다', () => {
  useSandbox();
  const P = require('../plugins');
  const f = path.join(sandbox, 'pack.json');
  fs.writeFileSync(f, '{"__proto__":"x","정상":"ok","constructor":"y"}');
  const r = P._readLanguagePack(f);
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(r.catalog), ['정상']);
  assert.strictEqual(({}).polluted, undefined);
});

test('알 수 없는 메서드는 조용히 성공하지 않는다', async () => {
  useSandbox();
  const P = require('../plugins');
  await assert.rejects(() => P.handle('plugins.nope', {}), /알 수 없는 메서드/);
});
