// 스킬 스텁 설치/회수 회귀 테스트 — node --test
//
// 지키는 불변식(2026-07-30 재발 실사고에서 도출):
//  A. 데몬이 설치하지 않는 레거시 경로(~/.agents/skills/cpt-cli)에 남은 **우리** 옛 스텁은
//     ensureSkillStub 이 돌 때마다 회수된다 — 7-26 실험 설치분이 7-29 sweep(.claude/.codex/.gemini)을
//     피해 살아남아, ~/.agents/skills 를 전역으로 읽는 codex 가 무관 프로젝트에서 cpt 를 집어 썼다.
//  B. 같은 경로의 **남의** 동명 스킬(내용에 CodingPT 없음)과 이웃 스킬은 절대 건드리지 않는다.
//  C. removeSkillStub(unpair)도 레거시 경로까지 회수한다.
//  D. 정상 설치는 그대로: ~/.claude 는 항상, ~/.codex 는 폴더가 이미 있을 때만.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-skills-'));
runtime.init({ root: HOME, stateDir: path.join(HOME, '.codingpt'), claudeHome: path.join(HOME, '.claude') });

const skills = require('../skills');

const LEGACY = path.join(HOME, '.agents', 'skills', 'cpt-cli');
const NEIGHBOR = path.join(HOME, '.agents', 'skills', 'objectstore');
// 7-26 실측 잔존물과 같은 형태: 자기-스코핑 이전 옛 스텁(우리 것 판별 문구 CodingPT 포함).
const OLD_STUB = '---\nname: cpt-cli\ndescription: Use the `cpt` CLI to operate the CodingPT workspace\n---\n# CodingPT cpt CLI\n';

function plant(dir, md) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
}

test('A. ensureSkillStub 이 레거시 ~/.agents 옛 스텁을 회수한다', () => {
  plant(LEGACY, OLD_STUB);
  plant(NEIGHBOR, '---\nname: objectstore\n---\n사용자 본인 스킬\n');
  const r = skills.ensureSkillStub();
  assert.equal(r.installed, true);
  assert.equal(fs.existsSync(LEGACY), false, '우리 옛 스텁은 회수돼야 한다');
  assert.equal(fs.existsSync(path.join(NEIGHBOR, 'SKILL.md')), true, '이웃 스킬은 불가침');
});

test('B. 남의 동명 스킬(내용에 CodingPT 없음)은 안 지운다', () => {
  plant(LEGACY, '---\nname: cpt-cli\n---\n남이 만든 무관한 스킬\n');
  skills.sweepLegacyStubs();
  assert.equal(fs.existsSync(path.join(LEGACY, 'SKILL.md')), true, '남의 파일은 절대 안 지운다');
  fs.rmSync(LEGACY, { recursive: true, force: true });
});

test('C. removeSkillStub(unpair)도 레거시 경로를 회수한다', () => {
  plant(LEGACY, OLD_STUB);
  const removed = skills.removeSkillStub();
  assert.equal(removed, true);
  assert.equal(fs.existsSync(LEGACY), false);
});

test('D. 정상 설치 경로는 그대로 — .claude 항상, .codex 는 기존 폴더일 때만', () => {
  fs.rmSync(path.join(HOME, '.claude', 'skills'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true }); // codex 사용자 시늉
  const r = skills.ensureSkillStub();
  assert.equal(r.installed, true);
  const claudeMd = path.join(HOME, '.claude', 'skills', 'cpt-cli', 'SKILL.md');
  const codexMd = path.join(HOME, '.codex', 'skills', 'cpt-cli', 'SKILL.md');
  assert.equal(fs.existsSync(claudeMd), true);
  assert.equal(fs.existsSync(codexMd), true);
  const md = fs.readFileSync(claudeMd, 'utf8');
  assert.match(md, /CPT_WS/, '설치본은 자기-스코핑 스텁이어야 한다');
  // 7-30 재발 2탄: CodingPT 소스 리포에서 도는 에이전트가 "여기가 CodingPT 환경"이라고 오독 —
  //  가드는 "소스 리포 작업 중 ≠ CodingPT 터미널"을 명시해야 한다(영/한 양쪽).
  assert.match(md, /does NOT make this a CodingPT terminal/, '영문 description 에 소스 리포 제외 명시');
  assert.match(md, /근거가 아니다/, '본문에 소스 리포 제외 명시');
  assert.equal(fs.existsSync(path.join(HOME, '.gemini')), false, '없던 에이전트 홈은 새로 만들지 않는다');
});

// ── 전용 명령 스텁(/orch) — 2026-10-06 ──
//  E. claude 에는 항상, codex 는 폴더가 있을 때만 깔린다. 스텁은 자기-스코핑(CPT_WS)이고 인자 자리를 가진다.
//  F. 이름이 흔하다(orch) — 남의 동명 스킬은 덮어쓰지도 지우지도 않는다.
//  G. unpair 는 우리 것만 지운다.
const ORCH_C = path.join(HOME, '.claude', 'skills', 'orch');
const ORCH_X = path.join(HOME, '.codex', 'skills', 'orch');

test('E. /orch 스텁 설치 — 자기-스코핑 + 인자 자리 + 내장 서브에이전트 금지', () => {
  fs.rmSync(ORCH_C, { recursive: true, force: true });
  fs.rmSync(ORCH_X, { recursive: true, force: true });
  skills.ensureSkillStub();
  const md = fs.readFileSync(path.join(ORCH_C, 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: orch\n/);
  assert.match(md, /CPT_WS/);
  assert.match(md, /\$ARGUMENTS/);
  assert.match(md, /cpt skills get orch/);
  assert.match(md, /내장 서브에이전트/);
  assert.equal(fs.existsSync(path.join(ORCH_X, 'SKILL.md')), true, 'codex 사용자에게도 깐다');
  assert.equal(skills.hasExtraStub('codex', 'orch'), true);
  assert.equal(fs.existsSync(path.join(HOME, '.gemini')), false, '없던 에이전트 홈은 새로 만들지 않는다');
  // description 은 목록에서 앞 ~1000자만 보인다 — 그 안에 트리거가 다 들어 있어야 한다
  const desc = md.split('---')[1];
  assert.ok(desc.length < 1100, 'description 이 너무 길다: ' + desc.length);
});

test('F. 남의 동명 스킬은 덮어쓰지 않는다', () => {
  const mine = '---\nname: orch\n---\n사용자가 직접 만든 오케스트라 스킬\n';
  plant(ORCH_C, mine);
  skills.ensureSkillStub();
  assert.equal(fs.readFileSync(path.join(ORCH_C, 'SKILL.md'), 'utf8'), mine);
  assert.equal(skills.hasExtraStub('claude', 'orch'), false);
  assert.equal(skills.removeSkillStub(), true);
  assert.equal(fs.existsSync(path.join(ORCH_C, 'SKILL.md')), true, 'unpair 도 남의 것은 안 지운다');
  assert.equal(fs.existsSync(ORCH_X), false, '우리 것(codex)은 지운다');
  fs.rmSync(ORCH_C, { recursive: true, force: true });
});

test('G. 채팅 팔레트·입력 — codex 는 /orch 를 $orch 로 바꿔 보낸다, claude 와 다른 글은 그대로', () => {
  const commands = require('../commands');
  commands._clearCache();
  assert.equal(commands.listCommands({ agent: 'codex' }).items.some((x) => x.name === '/orch'), false, '스텁이 없으면 목록에도 없다');
  skills.ensureSkillStub();
  commands._clearCache();
  assert.equal(commands.listCommands({ agent: 'codex' }).items.some((x) => x.name === '/orch'), true);
  assert.equal(commands.rewriteForAgent('codex', '/orch 로그인 점검'), '$orch 로그인 점검');
  assert.equal(commands.rewriteForAgent('codex', '/orch'), '$orch');
  assert.equal(commands.rewriteForAgent('codex', '/orchestra 연습'), '/orchestra 연습');
  assert.equal(commands.rewriteForAgent('codex', '설명: /orch 는'), '설명: /orch 는');
  assert.equal(commands.rewriteForAgent('claude', '/orch 로그인 점검'), '/orch 로그인 점검');
});

// ── 안내서 = 기능별 파일 + 인덱스(2026-10-07) ─────────────────────────────────────────
//  한 파일에 다 넣으면 에이전트가 통째로 읽거나(낭비) 아예 안 읽는다. 인덱스만 늘 보이게 하고 쓸 기능만 골라 읽게 한다.
test('H. 안내서 — 주제마다 파일, 인덱스가 전부 가리킨다, 옛 이름도 통한다', () => {
  const { execFileSync } = require('child_process');
  const CLI = path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js');
  const GD = path.join(__dirname, '..', '..', 'cpt-cli', 'guides');
  const run = (args, env = {}) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CPT_WS: '', ...env } });
  const topics = run(['skills', 'list']).split('\n').map((l) => l.split(/\s+/)[0]).filter((x) => /^[a-z]+$/.test(x));
  assert.deepEqual(topics.slice().sort(), fs.readdirSync(GD).map((f) => f.replace(/\.md$/, '')).sort(), '목록 = guides/ 의 파일들');
  const index = fs.readFileSync(path.join(GD, 'index.md'), 'utf8');
  for (const t of topics.filter((x) => x !== 'index')) {
    assert.ok(index.includes('`' + t + '`'), `인덱스가 ${t} 를 가리킨다`);
    const g = run(['skills', 'get', t]);
    assert.ok(g.length > 200 && g.length < 30000, `${t} 안내서 크기: ${g.length}`);
  }
  assert.ok(index.length < 3000, '인덱스는 작아야 한다(세션마다 들어간다): ' + index.length);
  assert.equal(run(['skills', 'get', 'cpt-cli']), index, '옛 이름 cpt-cli = 인덱스');
  assert.equal(run(['skills', 'get', 'cpt-orch']), fs.readFileSync(path.join(GD, 'orch.md'), 'utf8'), '옛 이름 cpt-orch = orch');
  assert.ok(run(['skills', 'get', 'all']).length > index.length * 5);
  assert.match(fs.readFileSync(path.join(GD, 'browser.md'), 'utf8'), /cpt preview open/, '브라우저 안내서가 여는 법부터 말한다');
});

test('I. 세션 컨텍스트 — CodingPT 터미널에서만 인덱스를 낸다 · 훅에 걸려 있다', () => {
  const { execFileSync } = require('child_process');
  const CLI = path.join(__dirname, '..', '..', 'cpt-cli', 'bin', 'cpt.js');
  const run = (env) => execFileSync(process.execPath, [CLI, 'session-context'], { encoding: 'utf8', env: { ...process.env, ...env } });
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'cpt-cli', 'guides', 'index.md'), 'utf8');
  assert.equal(run({ CPT_WS: 'work/app' }), index);
  assert.equal(run({ CPT_WS: '' }), '', 'CodingPT 터미널이 아니면 아무것도 내지 않는다(다른 도구의 claude 를 오염시키지 않는다)');
  const shim = fs.readFileSync(path.join(__dirname, '..', 'shim.js'), 'utf8');
  assert.match(shim, /SessionStart: \[\.\.\.hook\('session-start', 5\), \{ hooks: \[\{ type: 'command', command: `"\$\{cptAbs\}" session-context`, timeout: 5 \}\] \}\]/, 'SessionStart 에 동기 훅(무 async)으로 걸려 있다');
});
