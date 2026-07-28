/**
 * skills — cpt 를 claude(및 skill 지원 에이전트)가 "인지"하게 하는 스킬 스텁 자동 설치.
 *
 * Claude Code 는 `~/.claude/skills/<name>/SKILL.md` 를 발견해 frontmatter description 으로
 * 관련 상황에서 스킬을 로드한다. 데몬이 부팅 시 cpt-cli 스텁을 이 경로에 설치하면, 워크스페이스
 * 터미널의 claude 가 cpt 를 스스로 쓸 수 있게 된다(전체 가이드는 `cpt skills get cpt-cli` 가 서빙).
 *
 * 원칙: 훅과 달리 스킬은 `--settings` 실행 주입이 불가능해 파일 설치가 유일한 방법이다. 이는
 * 사용자 설정을 "수정"하는 게 아니라 자기 폴더에 "추가"하는 순수 add 이며, opt-out(CPT_SKILL_INSTALL=0)
 * + unpair 삭제로 되돌릴 수 있다. 스텁엔 명령 목록을 넣지 않아(드리프트 차단) 바이너리 버전과
 * 항상 일치하는 가이드로 수렴한다.
 */
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

// claude 가 스킬을 찾는 곳 = 러너 HOME 의 ~/.claude/skills. (claude 가 도는 그 머신)
function skillDir() { return path.join(runtime.claudeHome(), 'skills', 'cpt-cli'); }
// codex/gemini 도 같은 스킬 규약(~/.<agent>/skills/<name>/SKILL.md)을 읽는다 — 러너 HOME 은
//  claudeHome 의 부모(러너 HOME 의 ~/.claude)에서 역산해 로컬/클라우드 공통.
function agentSkillDirs() {
  const home = path.dirname(runtime.claudeHome());
  return [
    { home: path.join(home, '.codex'), dir: path.join(home, '.codex', 'skills', 'cpt-cli') },
    { home: path.join(home, '.gemini'), dir: path.join(home, '.gemini', 'skills', 'cpt-cli') },
  ];
}
// 스텁 정본 = cpt-cli 패키지에 커밋된 SKILL.md(cpt 바이너리와 함께 배포되어 버전 일치).
function stubSrc() { return path.join(__dirname, '..', 'cpt-cli', 'SKILL.md'); }

// 내용이 같으면 안 쓴다(mtime 보존 — 불필요 재설치 신호 방지).
function writeIfChanged(file, content) {
  try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch (_) { /* 없음 → 쓴다 */ }
  fs.writeFileSync(file, content);
  return true;
}

// ~/.claude/skills/cpt-cli/SKILL.md 설치(멱등). opt-out: env CPT_SKILL_INSTALL=0.
//  codex/gemini 는 해당 홈 디렉토리(~/.codex, ~/.gemini)가 **이미 존재할 때만** 같은 스텁을 설치한다
//  (그 에이전트를 실제로 쓰는 사용자에게만 add — 폴더를 새로 만들지 않는다).
//  ⚠ opt-out 은 설치 중단이 아니라 **회수(sweep)까지** 다 — 스위치를 켜도 기설치분이 남아 있으면
//   무관한 프로젝트의 에이전트가 cpt 를 계속 발견한다(2026-07-29 실사고: 다른 도구의 codex 가
//   전역 스텁을 보고 cpt 를 집어 씀). Orca 도 off 스위치에서 기설치 훅을 sweep 한다(동일 결론).
function ensureSkillStub() {
  if (String(process.env.CPT_SKILL_INSTALL || '') === '0') {
    let removed = false;
    try { removed = removeSkillStub(); } catch (_) { /* noop */ }
    return { installed: false, reason: 'opt-out', removed };
  }
  let content;
  try { content = fs.readFileSync(stubSrc(), 'utf8'); }
  catch (_) { return { installed: false, reason: 'no-source' }; }
  const dir = skillDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return { installed: false, reason: 'mkdir-failed' }; }
  const changed = writeIfChanged(path.join(dir, 'SKILL.md'), content);
  // codex/gemini 스킬(베스트에포트) — 개별 실패는 claude 설치 결과에 영향 없음.
  for (const a of agentSkillDirs()) {
    try {
      if (!fs.existsSync(a.home)) continue; // 해당 에이전트 미사용 — 건너뜀
      fs.mkdirSync(a.dir, { recursive: true });
      writeIfChanged(path.join(a.dir, 'SKILL.md'), content);
    } catch (_) { /* noop */ }
  }
  return { installed: true, changed, dir };
}

// unpair(연결 해제) 시 우리가 설치한 스텁만 정리 — 순수 add 를 되돌린다(claude+codex/gemini 대칭).
function removeSkillStub() {
  let removed = false;
  try { fs.rmSync(skillDir(), { recursive: true, force: true }); removed = true; } catch (_) { /* noop */ }
  for (const a of agentSkillDirs()) {
    try { if (fs.existsSync(a.dir)) { fs.rmSync(a.dir, { recursive: true, force: true }); removed = true; } } catch (_) { /* noop */ }
  }
  return removed;
}

module.exports = { ensureSkillStub, removeSkillStub, skillDir, agentSkillDirs };
