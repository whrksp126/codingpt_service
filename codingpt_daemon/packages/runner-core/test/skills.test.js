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
