// codex 훅 병합(shim §4.7) — ~/.codex/hooks.json **비파괴 병합**의 회귀 테스트.
//
// 지켜야 하는 불변식:
//  ① 다른 도구(Orca 등)의 항목을 절대 건드리지 않는다 — 우리 항목만 마커로 식별해 추가/제거.
//  ② 무변경이면 다시 쓰지 않는다 — 파일 내용이 바뀌면 codex 가 "훅 변경" 재신뢰를 요구한다.
//  ③ 배선 OFF 면 우리 항목만 걷는다. 파일이 없으면 만들지 않는다(~/.codex 무생성).
//  ④ 명령은 자기-스코핑(CPT_SOCK 가드) + 가드형([ -x cpt ] 실패 시 cat) — 전역 유출/잔재 에러 차단.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../runtime');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cdxh-'));
runtime.init({ root: ROOT, stateDir: path.join(ROOT, '.codingpt') });

const { _codexHooks } = require('../shim');
const { ensureCodexApprovalHook, CODEX_HOOK_MARKER } = _codexHooks;

const CPT = '/opt/state/bin/cpt';
const AB = { cliWaitMs: 86410000, hookTimeoutSec: 86425 };

let dir; let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-cdxh-file-'));
  file = path.join(dir, 'hooks.json');
});

const ORCA_ENTRY = {
  hooks: [{ type: 'command', command: "if [ -x '/Users/u/.orca/hook.sh' ]; then /bin/sh '/Users/u/.orca/hook.sh'; else cat >/dev/null; fi", timeout: 10 }],
};

test('병합: 기존(타 도구) 항목을 보존하고 우리 항목을 뒤에 추가한다', () => {
  fs.writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [ORCA_ENTRY], Stop: [ORCA_ENTRY] } }, null, 2));
  ensureCodexApprovalHook(CPT, AB, true, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(j.hooks.PermissionRequest.length, 2, '타 도구 항목이 사라졌다');
  assert.match(JSON.stringify(j.hooks.PermissionRequest[0]), /orca/, '순서: 기존 항목이 앞');
  const ours = JSON.stringify(j.hooks.PermissionRequest[1]);
  assert.ok(ours.includes(CODEX_HOOK_MARKER));
  assert.ok(ours.includes('CPT_SOCK'), '자기-스코핑 가드(CPT_SOCK)가 없으면 CodingPT 밖 codex 에서도 발화한다');
  // 가드형 폴백 — 2026-08-10 Node 원라이너 치환(win32 에 sh 없음) 후에는 stdin 드레인 + exit 0 이 등가물.
  assert.ok(ours.includes('stdin.resume'), '가드형 폴백(stdin 드레인)이 없으면 앱 제거/스코프 밖에서 훅이 매달린다');
  assert.ok(ours.includes('existsSync'), 'cpt CLI 부재 가드가 없으면 앱 제거 후 훅 에러가 남는다');
  // 셸 교집합 문법 계약 — -e 코드 안에 큰따옴표/$/% 가 들어가면 sh("…")/cmd("…") 인용이 깨진다.
  const cmd = j.hooks.PermissionRequest[1].hooks[0].command;
  const inner = cmd.split(' -e ')[1] || '';
  const code = (inner.match(/^"([^"]*)"/) || [])[1] || '';
  assert.ok(code.length > 0, '-e 코드가 큰따옴표 한 쌍으로 감싸여 있어야 한다');
  assert.ok(!/[$%\\]/.test(code), '-e 코드에 $·%·역슬래시가 있으면 셸 교집합 문법이 깨진다');
  assert.deepStrictEqual(j.hooks.Stop, [ORCA_ENTRY], '다른 이벤트가 오염됐다');
});

test('멱등: 두 번 불러도 내용이 그대로다(재신뢰 유발 금지)', () => {
  fs.writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [ORCA_ENTRY] } }));
  ensureCodexApprovalHook(CPT, AB, true, file);
  const once = fs.readFileSync(file, 'utf8');
  ensureCodexApprovalHook(CPT, AB, true, file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), once);
});

test('회수: 배선 OFF 면 우리 항목만 걷고 타 도구 항목은 남긴다', () => {
  fs.writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [ORCA_ENTRY] } }));
  ensureCodexApprovalHook(CPT, AB, true, file);
  ensureCodexApprovalHook(CPT, AB, false, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(j.hooks.PermissionRequest.length, 1);
  assert.match(JSON.stringify(j.hooks.PermissionRequest[0]), /orca/);
});

test('회수: 우리 항목만 있었으면 이벤트 키 자체를 지운다', () => {
  ensureCodexApprovalHook(CPT, AB, true, file);
  ensureCodexApprovalHook(CPT, AB, false, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('PermissionRequest' in (j.hooks || {})));
});

test('파일이 없으면: OFF 는 아무것도 만들지 않고, ON 은 새로 만든다', () => {
  ensureCodexApprovalHook(CPT, AB, false, file);
  assert.ok(!fs.existsSync(file), 'OFF 인데 ~/.codex 에 파일을 만들었다');
  ensureCodexApprovalHook(CPT, AB, true, file);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(j.hooks.PermissionRequest.length, 1);
});

test('손상된 JSON: 무접촉 — 재작성하면 형식만 깨진 타 도구 항목을 날릴 수 있다', () => {
  fs.writeFileSync(file, '{broken');
  ensureCodexApprovalHook(CPT, AB, true, file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken', '손상 파일을 건드렸다');
});
