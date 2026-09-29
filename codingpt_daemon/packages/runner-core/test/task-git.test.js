'use strict';
// Agent Tasks git/gh 실행기(task-git.js) — 설계 정본 docs/agent-tasks-design.md §2.4·§2.9·§7.1.
//  실제 git + 임시 저장소 + **가짜 gh**(임시 bin 의 셸 스크립트). 사용자 전역 git 설정(서명·색·훅)이
//  결과를 바꾸지 않게 GIT_CONFIG_GLOBAL 을 빈 파일로 격리한다.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tgit-')));
const STATE = path.join(ROOT, '.codingpt');
const BIN = path.join(ROOT, 'fakebin');
const GLOBAL_CFG = path.join(ROOT, 'gitconfig-global');
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(GLOBAL_CFG, '');
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.CODINGPT_TMUX_SOCKET = `codingpt-tgit-${process.pid}`;
const GH_LOG = path.join(ROOT, 'gh.log');
const PR_JSON = path.join(ROOT, 'pr.json');
process.env.GH_LOG = GH_LOG;
process.env.GH_PR_JSON = PR_JSON;

const runtime = require('../runtime');
runtime.init({ ...runtime.get(), root: ROOT, stateDir: STATE });
const agents = require('../agents');
const tg = require('../task-git');

// 가짜 gh — 인자별 고정 출력. pr 계열은 --repo 가 없으면 exit 3(§2.4 "항상 --repo" 를 강제).
function writeFakeGh(dir, { unauth = false, auth = null } = {}) {
  const script = `#!/bin/sh
echo "$*" >> "$GH_LOG"
need_repo() { case " $* " in *" --repo "*) ;; *) echo "missing --repo" >&2; exit 3;; esac; }
case "$1" in
  --version) echo "gh version 2.60.0 (2024-10-01)"; exit 0;;
  auth) ${auth || (unauth ? 'echo "You are not logged into any GitHub hosts" >&2; exit 1' : 'exit 0')};;
  api) echo "tester"; exit 0;;
  repo) echo '{"owner":{"login":"acme"},"name":"demo"}'; exit 0;;
  pr)
    need_repo "$@"
    case "$2" in
      create) cat > "$GH_LOG.body"; echo "https://github.com/acme/demo/pull/7"; exit 0;;
      view) cat "$GH_PR_JSON"; exit 0;;
      merge) exit 0;;
    esac;;
esac
echo "unknown: $*" >&2; exit 2
`;
  const f = path.join(dir, 'gh');
  fs.writeFileSync(f, script, { mode: 0o755 });
  return f;
}
writeFakeGh(BIN);
agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
tg.resetCache();

after(() => {
  agents._internals.setSearchOverride(null);
  agents._internals.resetCache();
  tg.resetCache();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

const G = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

function makeRepo(name = 'repo') {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  G(dir, 'init', '-q', '-b', 'main');
  G(dir, 'config', 'user.email', 'dev@example.com');
  G(dir, 'config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.env.*\n!.env.local\nnode_modules\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-q', '-m', 'c1');
  fs.writeFileSync(path.join(dir, '한글.txt'), '안녕\n');
  G(dir, 'add', '-A');
  G(dir, 'commit', '-q', '-m', 'c2');
  return dir;
}

test('tools() — override 탐색으로 git·가짜 gh 를 찾고 인증 상태를 판정한다', async () => {
  const t = await tg.tools({ refresh: true });
  assert.strictEqual(t.git.ok, true);
  assert.ok(t.git.version);
  assert.strictEqual(t.gh.installed, true);
  assert.strictEqual(t.gh.path, path.join(BIN, 'gh'));
  assert.strictEqual(t.gh.authenticated, true);
  assert.strictEqual(t.gh.user, 'tester');
  assert.strictEqual(t.env.GIT_TERMINAL_PROMPT, '0');
  assert.strictEqual(t.env.GH_PROMPT_DISABLED, '1');
  assert.ok(!('GIT_SSH_COMMAND' in t.env) || t.env.GIT_SSH_COMMAND === process.env.GIT_SSH_COMMAND, 'GIT_SSH_COMMAND 를 만들지 않는다');
  assert.ok(!('TMUX' in t.env));
  assert.ok(t.env.PATH.split(path.delimiter)[0] === '/usr/bin' || t.env.PATH.includes(BIN));
});

test('tools() — gh 미인증(exit 1) → GH_NOT_AUTHED, requireGh 가 코드로 던진다', async () => {
  const bin2 = path.join(ROOT, 'fakebin-unauth');
  fs.mkdirSync(bin2, { recursive: true });
  writeFakeGh(bin2, { unauth: true });
  agents._internals.setSearchOverride([bin2, '/usr/bin', '/bin']);
  try {
    const t = await tg.tools({ refresh: true });
    assert.strictEqual(t.gh.installed, true);
    assert.strictEqual(t.gh.authenticated, false);
    assert.strictEqual(t.gh.error, 'GH_NOT_AUTHED');
    await assert.rejects(() => tg.requireGh(), (e) => e.code === 'GH_NOT_AUTHED');
  } finally {
    agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
    await tg.tools({ refresh: true });
  }
});

test('tools() — gh 없음 → GH_MISSING', async () => {
  const empty = path.join(ROOT, 'emptybin');
  fs.mkdirSync(empty, { recursive: true });
  agents._internals.setSearchOverride([empty, '/usr/bin', '/bin']);
  try {
    const t = await tg.tools({ refresh: true });
    // 이 머신 /usr/bin 에 gh 가 없다는 전제(Homebrew 는 /opt/homebrew/bin)
    if (!fs.existsSync('/usr/bin/gh')) {
      assert.strictEqual(t.gh.installed, false);
      assert.strictEqual(t.gh.error, 'GH_MISSING');
      await assert.rejects(() => tg.requireGh(), (e) => e.code === 'GH_MISSING');
    }
  } finally {
    agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
    await tg.tools({ refresh: true });
  }
});

test('env -i PATH=/usr/bin:/bin 재현 — searchDirs(표준 위치 ~/.local/bin)로 gh 를 찾는다', () => {
  // Finder 로 뜬 데몬과 같은 조건: PATH 에 gh 가 없다. HOME/.local/bin 은 agents FALLBACK_DIRS 에 있다.
  const home = path.join(ROOT, 'home-envi');
  const lb = path.join(home, '.local', 'bin');
  fs.mkdirSync(lb, { recursive: true });
  writeFakeGh(lb);
  const script = `
    const runtime = require(${JSON.stringify(path.join(__dirname, '..', 'runtime'))});
    runtime.init({ ...runtime.get(), root: ${JSON.stringify(home)}, stateDir: ${JSON.stringify(path.join(home, '.codingpt'))} });
    const tg = require(${JSON.stringify(path.join(__dirname, '..', 'task-git'))});
    tg.tools().then((t) => { process.stdout.write(JSON.stringify({ gh: t.gh.path, git: t.git.ok })); });
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    // SHELL=false — 로그인 셸 PATH 조사가 실패해도(= 가장 나쁜 경우) 표준 위치 목록으로 찾아야 한다.
    //  (/bin/sh -l 은 macOS path_helper 로 /opt/homebrew/bin 을 줘서 이 머신의 진짜 gh 를 먼저 찾는다.)
    env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/usr/bin/false', GH_LOG, GIT_CONFIG_GLOBAL: GLOBAL_CFG, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.git, true);
  // ~/.local/bin 이 임시 디렉토리(/var/folders) 아래면 agents.isTransientDir 가 후보에서 뺀다(영구 심 보호 규칙).
  //  그때는 표준 위치(/opt/homebrew/bin·/usr/local/bin)에 실제 gh 가 있는 머신에서만 검증한다.
  const stdGh = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((f) => fs.existsSync(f));
  if (agents._internals.isTransientDir(lb)) {
    if (stdGh) assert.strictEqual(out.gh, stdGh, 'PATH 에 없는 gh 를 표준 위치에서 찾아야 한다');
  } else {
    assert.strictEqual(out.gh, path.join(lb, 'gh'));
  }
  // 전제: 이 머신 /usr/bin·/bin 에 gh 가 없다(macOS 기본). 리눅스 CI 러너처럼 apt 로 /usr/bin/gh 가
  //  깔린 머신에선 PATH 에서 찾는 것이 정답이므로 이 단언은 전제가 성립할 때만 건다.
  if (!['/usr/bin/gh', '/bin/gh'].some((f) => fs.existsSync(f))) {
    assert.ok(!out.gh || !['/usr/bin', '/bin'].includes(path.dirname(out.gh)));
  }
});

test('repoInfo — top/common/subdir 정규화', async () => {
  const dir = makeRepo('r-info');
  const info = await tg.repoInfo(path.join(dir, 'sub'));
  assert.strictEqual(info.top, dir);
  assert.strictEqual(info.subdir, 'sub');
  assert.strictEqual(info.common, fs.realpathSync(path.join(dir, '.git')));
  assert.strictEqual(await tg.repoInfo(ROOT), null);
});

test('worktree add/remove + diff(커밋+인덱스+워킹트리+미추적, dedupe, 한글 경로 원문)', async () => {
  const dir = makeRepo('r-diff');
  const base = G(dir, 'rev-parse', 'main');
  const wt = path.join(STATE, 'worktrees', 'r-diff-abcdef-1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await tg.worktreeAdd(dir, { branch: 'cpt/abcdef-1', absDir: wt, startPoint: base });
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
  // 이미 있으면 WORKTREE_ADD_FAILED
  await assert.rejects(() => tg.worktreeAdd(dir, { branch: 'cpt/abcdef-9', absDir: wt, startPoint: base }), (e) => e.code === 'WORKTREE_ADD_FAILED');
  // 커밋 1개(a.txt 수정) + 그 위에 워킹트리 수정(같은 파일 → dedupe) + 인덱스(한글) + 미추적
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\n');
  G(wt, 'commit', '-qam', 'w1');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  fs.writeFileSync(path.join(wt, '한글.txt'), '안녕\n세계\n');
  G(wt, 'add', '한글.txt');
  fs.writeFileSync(path.join(wt, '새파일.md'), 'x\ny\n');
  fs.writeFileSync(path.join(wt, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]));
  const { files, mergeBase } = await tg.changedFiles(wt, base);
  assert.strictEqual(mergeBase, base);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepStrictEqual(Object.keys(byPath).sort(), ['a.txt', 'bin.dat', '새파일.md', '한글.txt'].sort());
  assert.strictEqual(byPath['a.txt'].status, 'M');
  assert.strictEqual(byPath['a.txt'].additions, 2, '커밋분+워킹트리분을 merge-base 대비 한 번에 센다');
  assert.strictEqual(byPath['한글.txt'].additions, 1);
  assert.strictEqual(byPath['새파일.md'].status, '?');
  assert.strictEqual(byPath['새파일.md'].additions, 2);
  assert.strictEqual(byPath['bin.dat'].binary, true);
  const st = await tg.runStat(wt, base);
  assert.strictEqual(st.ahead, 1);
  assert.strictEqual(st.dirty, true);
  assert.strictEqual(st.diff.files, 4);
  assert.strictEqual(st.pushed, false);
  const txt = await tg.fileDiffText(wt, base, '한글.txt', false);
  assert.match(txt, /\+세계/);
  const un = await tg.fileDiffText(wt, base, '새파일.md', true);
  assert.match(un, /\+x/);
  // remove
  const r = await tg.git(['worktree', 'remove', '--force', '--', wt], { cwd: dir });
  assert.strictEqual(r.ok, true);
  assert.ok(!fs.existsSync(wt));
});

test('copyEnvFiles — ignored 만, example 제외, 1MB 상한, 심링크 제외, worktree 안 check-ignore', async () => {
  const dir = makeRepo('r-env');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dir, '.env.production'), 'P=1\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'X=\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'NOT_IGNORED=1\n');    // .gitignore 의 !.env.local — 추적 대상이라 복사 금지
  fs.writeFileSync(path.join(dir, '.env.big'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, '.env.link'));
  fs.writeFileSync(path.join(dir, 'sub', '.env'), 'SUB=1\n');
  const base = G(dir, 'rev-parse', 'main');
  const wt = path.join(STATE, 'worktrees', 'r-env-abcdef-1');
  await tg.worktreeAdd(dir, { branch: 'cpt/env-1', absDir: wt, startPoint: base });
  const copied = await tg.copyEnvFiles(dir, 'sub', wt);
  assert.deepStrictEqual(copied.sort(), ['.env', '.env.production', 'sub/.env'].sort());
  assert.strictEqual(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=1\n');
  assert.ok(!fs.existsSync(path.join(wt, '.env.example')));
  assert.ok(!fs.existsSync(path.join(wt, '.env.local')));
  assert.ok(!fs.existsSync(path.join(wt, '.env.big')));
  assert.ok(!fs.existsSync(path.join(wt, '.env.link')));
});

test('commit — identity 없음 / 복사한 .env 는 exclude / 훅 실패 → COMMIT_HOOK_FAILED, --no-verify 성공 / 변경 0', async () => {
  const dir = makeRepo('r-commit');
  const base = G(dir, 'rev-parse', 'main');
  const wt = path.join(STATE, 'worktrees', 'r-commit-abcdef-1');
  await tg.worktreeAdd(dir, { branch: 'cpt/commit-1', absDir: wt, startPoint: base });
  // .env 를 강제로 추적 가능하게 만든 상황(gitignore 무력화)에서도 exclude pathspec 이 막는다.
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(wt, 'feature.js'), 'export const a = 1;\n');
  // identity 없음
  G(dir, 'config', '--unset', 'user.email');
  await assert.rejects(() => tg.commit(wt, { message: 'feat', exclude: ['.env'] }), (e) => e.code === 'GIT_IDENTITY_MISSING');
  G(dir, 'config', 'user.email', 'dev@example.com');
  // pre-commit 훅 실패
  const hooks = path.join(dir, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
  await assert.rejects(() => tg.commit(wt, { message: 'feat', exclude: ['.env'] }), (e) => e.code === 'COMMIT_HOOK_FAILED' && /lint failed/.test(e.stderrTail));
  const ok = await tg.commit(wt, { message: '-starts-with-dash 한글', noVerify: true, exclude: ['.env'] });
  assert.match(ok.sha, /^[0-9a-f]{40}$/);
  assert.strictEqual(ok.short, ok.sha.slice(0, 7));
  const files = G(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n');
  assert.ok(files.includes('feature.js'));
  assert.ok(!files.includes('.env'), '복사한 시크릿은 커밋되지 않는다');
  assert.strictEqual(G(wt, 'log', '-1', '--format=%s'), '-starts-with-dash 한글', '- 로 시작하는 메시지가 옵션으로 오해되지 않는다');
  fs.rmSync(path.join(hooks, 'pre-commit'));
  // 남은 건 .env(exclude)뿐 → 변경 0
  await assert.rejects(() => tg.commit(wt, { message: 'again', exclude: ['.env'] }), (e) => e.code === 'NOTHING_TO_COMMIT');
});

test('mergeIn — merge/squash/ff + 충돌 abort → {ok:false, MERGE_CONFLICT, files}', async () => {
  const dir = makeRepo('r-merge');
  const base = G(dir, 'rev-parse', 'main');
  const mk = async (k, file, content) => {
    const wt = path.join(STATE, 'worktrees', `r-merge-abcdef-${k}`);
    await tg.worktreeAdd(dir, { branch: `cpt/m-${k}`, absDir: wt, startPoint: base });
    fs.writeFileSync(path.join(wt, file), content);
    G(wt, 'commit', '-qam', `w${k}`);
    return wt;
  };
  await mk(1, 'a.txt', 'one\ntwo\nm1\n');
  const r1 = await tg.mergeIn(dir, { branch: 'cpt/m-1', method: 'ff', message: 'x' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(G(dir, 'rev-parse', 'HEAD'), G(dir, 'rev-parse', 'cpt/m-1'));
  await mk(2, 'sub/b.txt', 'b2\n');
  const r2 = await tg.mergeIn(dir, { branch: 'cpt/m-2', method: 'merge', message: 'Merge cpt/m-2' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(G(dir, 'log', '-1', '--format=%s'), 'Merge cpt/m-2');
  assert.strictEqual(G(dir, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3, '--no-ff 머지 커밋');
  await mk(3, '한글.txt', '안녕\nsquash\n');
  const r3 = await tg.mergeIn(dir, { branch: 'cpt/m-3', method: 'squash', message: '작업 제목' });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(G(dir, 'log', '-1', '--format=%s'), '작업 제목');
  // 충돌: base 의 a.txt 와 다른 내용
  await mk(4, 'a.txt', 'one\ntwo\nCONFLICT\n');
  const r4 = await tg.mergeIn(dir, { branch: 'cpt/m-4', method: 'merge', message: 'Merge cpt/m-4' });
  assert.deepStrictEqual(r4, { ok: false, code: 'MERGE_CONFLICT', files: ['a.txt'] });
  assert.strictEqual(G(dir, 'status', '--porcelain'), '', '충돌 뒤 merge --abort 로 원상복구');
  const r5 = await tg.mergeIn(dir, { branch: 'cpt/m-4', method: 'squash', message: 't' });
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.code, 'MERGE_CONFLICT');
  assert.strictEqual(G(dir, 'status', '--porcelain'), '');
});

test('gh — githubRepo / prCreate(본문 stdin, 항상 --repo) / prView checks 접기 / prMerge', async () => {
  const dir = makeRepo('r-gh');
  fs.writeFileSync(GH_LOG, '');
  fs.writeFileSync(PR_JSON, JSON.stringify({
    number: 7, url: 'https://github.com/acme/demo/pull/7', state: 'OPEN', isDraft: false, title: 'T',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, headRefName: 'cpt/x-1', baseRefName: 'main',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://x/1' },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE', targetUrl: 'https://x/2' },
      { __typename: 'CheckRun', name: 'opt', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ],
    mergedAt: null, mergeCommit: null,
  }));
  const gh = await tg.githubRepo(dir);
  assert.deepStrictEqual(gh, { owner: 'acme', repo: 'demo' });
  const res = await tg.prCreate(dir, gh, { branch: 'cpt/x-1', base: 'main', title: '-제목', body: '본문\n두 줄', draft: true, now: 1 });
  assert.strictEqual(res.existed, false);
  assert.strictEqual(res.pr.number, 7);
  assert.strictEqual(res.pr.state, 'open');
  assert.deepStrictEqual(
    { status: res.pr.checks.status, total: res.pr.checks.total, passed: res.pr.checks.passed, failed: res.pr.checks.failed, pending: res.pr.checks.pending },
    { status: 'failing', total: 4, passed: 1, failed: 1, pending: 1 });
  assert.deepStrictEqual(res.pr.checks.items.map((i) => i.status), ['passing', 'pending', 'failing', 'skipped']);
  assert.strictEqual(fs.readFileSync(GH_LOG + '.body', 'utf8'), '본문\n두 줄', 'PR 본문은 stdin(--body-file=-)');
  const log = fs.readFileSync(GH_LOG, 'utf8');
  assert.match(log, /pr create --repo acme\/demo --head cpt\/x-1 --base main --title=-제목 --body-file=- --draft/);
  await tg.prMerge(dir, gh, 7, 'squash');
  assert.match(fs.readFileSync(GH_LOG, 'utf8'), /pr merge --repo acme\/demo 7 --squash/);
  assert.doesNotMatch(fs.readFileSync(GH_LOG, 'utf8'), /--delete-branch|auth token/);
  assert.deepStrictEqual(tg.foldChecks([]), { status: 'none', total: 0, passed: 0, failed: 0, pending: 0, items: [] });
});

test('exec — 데드라인 초과 시 자식을 죽이고 timedOut 으로 접는다(자식 종료를 기다린 뒤 회신)', async () => {
  const t0 = Date.now();
  const r = await tg.exec('/bin/sleep', ['5'], { timeout: 200 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.ok(Date.now() - t0 < 3000);
});

test('파서 — status -z(rename) / worktree porcelain', () => {
  const { parseStatusZ, parseWorktreeList } = tg._parse;
  assert.deepStrictEqual(parseStatusZ('R  new.txt\0old.txt\0?? 한글.txt\0'), [{ xy: 'R ', path: 'new.txt' }, { xy: '??', path: '한글.txt' }]);
  const wts = parseWorktreeList('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n');
  assert.deepStrictEqual(wts, [
    { path: '/a', head: '1', branch: 'refs/heads/main', detached: false, bare: false },
    { path: '/b', head: '2', branch: null, detached: true, bare: false },
  ]);
});

test('exec — 자식이 stdin 을 안 읽고 죽어도(EPIPE, 2MB 본문) 데몬이 죽지 않고 실패로 접는다', async () => {
  let uncaught = null;
  const onErr = (e) => { uncaught = e; };
  process.on('uncaughtException', onErr);
  try {
    const r = await tg.exec('/bin/sh', ['-c', 'sleep 0.1; exit 1'], { input: 'x'.repeat(2 * 1024 * 1024), timeout: 5000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 1);
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(uncaught, null, 'EPIPE 가 uncaught 로 새지 않는다');
  } finally { process.removeListener('uncaughtException', onErr); }
});

test('env — 메시지 로캘은 C 고정(영어 에러 분류), LC_ALL 은 지운다, 문자 인코딩은 유지', async () => {
  const prev = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  process.env.LC_ALL = 'ko_KR.UTF-8';
  process.env.LANG = 'ko_KR.UTF-8';
  try {
    const t = await tg.tools({ refresh: true });
    assert.ok(!('LC_ALL' in t.env));
    assert.strictEqual(t.env.LC_MESSAGES, 'C');
    assert.strictEqual(t.env.LANGUAGE, 'C');
    assert.strictEqual(t.env.LC_CTYPE, 'ko_KR.UTF-8');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    await tg.tools({ refresh: true });
  }
});

test('git() 는 gh 인증 조사(네트워크)를 기다리지 않는다 · 네트워크 실패는 GH_NOT_AUTHED 가 아니다', async () => {
  const slow = path.join(ROOT, 'fakebin-slowauth');
  fs.mkdirSync(slow, { recursive: true });
  writeFakeGh(slow, { auth: 'sleep 3; echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2; exit 1' });
  agents._internals.setSearchOverride([slow, '/usr/bin', '/bin']);
  tg.resetCache();
  try {
    const t0 = Date.now();
    const r = await tg.git(['--version'], { raw: true });
    assert.strictEqual(r.ok, true);
    assert.ok(Date.now() - t0 < 2500, `git 이 gh auth(3s)를 기다렸다: ${Date.now() - t0}ms`);
    const t = await tg.tools();
    assert.strictEqual(t.gh.authenticated, false);
    assert.strictEqual(t.gh.error, 'GH_ERROR', '오프라인은 로그인 필요가 아니다');
  } finally {
    agents._internals.setSearchOverride([BIN, '/usr/bin', '/bin']);
    tg.resetCache();
    await tg.tools({ refresh: true });
  }
});
