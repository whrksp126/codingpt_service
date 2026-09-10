// 스크롤 라우팅 계약 — PC(pane.js) 와 앱(TerminalWebView) 이 **같은 정본·같은 우선순위**인지.
//
// 회귀 배경(2026-09-04):
//  · 클라이언트가 DECSET 을 엿보며 추측하던 시절, tmux 의 smcup@ 때문에 1049 가 안 와서
//    vim/less 를 일반 셸로 오판했다. PC 는 그걸 "codex 브랜드면 방향키" 하드코딩으로 때웠고,
//    이번 브랜치가 그 하드코딩을 지우면서 PC 쪽 보완이 통째로 사라졌다.
//  · 정본은 tmux/서버 VT 다. 두 구현이 같은 소스를 보고 같은 순서(mouse > alternate)로 갈라야 한다.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pane = fs.readFileSync(path.join(here, '../src/js/pane.js'), 'utf8');
const app = fs.readFileSync(
  path.join(here, '../../../codingpt_app/src/components/module/ide/TerminalWebView.tsx'),
  'utf8',
);

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, `FAIL ${label}`); console.log(`PASS ${label}`); pass++; };

// 1) v3 는 원시 PTY 바이트가 그대로 오므로 **모드는 로컬 xterm 이 안다** — 서버 조회는 없다.
//    (2026-09-06 삭제. win32 legacy 만 pty_modes 폴백을 남긴다.)
ok('PC 는 로컬 xterm 으로 alt-screen 을 판정한다', pane.includes("this.term?.buffer?.active?.type === \"alternate\""));
ok('PC 의 pty_modes 는 win32 legacy 게이트 안에만 있다',
  /if \(localTmuxBackend\(\) \|\| !this\.ctx\.isLocal\)[\s\S]{0,200}?api\.ptyModes\(this\.id\)/.test(pane));
ok('앱은 서버 modes 를 조회하지 않는다', !app.includes("type:'modes'"));
ok('앱은 로컬 xterm 상태로 스크롤을 라우팅한다',
  app.includes('if (__mouseActive())') && app.includes('if (__alternateActive())'));

// 2) 우선순위는 양쪽이 같다: mouse > alternate > 일반 셸(자기 버퍼 스크롤 = 과거 포함).
ok('PC 는 mouse tracking 이면 xterm 경로 유지', /if \(tracking\) return;/.test(pane));
ok('PC 는 mouse 다음에 alternate 를 본다', /if \(tracking\) return;[\s\S]{0,700}?if \(modes\.altScreen\)[\s\S]{0,400}?this\.term\?\.scrollLines\(/.test(pane));
ok('앱은 mouse tracking 이 alternate 보다 우선', /if \(__mouseActive\(\)\)[\s\S]{0,300}?if \(__alternateActive\(\)\)/.test(app));

// 3) 브랜드 하드코딩 금지 — 판정은 모드로만 한다.
ok('PC 휠 보완에 codex 브랜드 분기가 없다', !/_activeAgentBrand\(\) !== "codex"/.test(pane));

// 4) alternate 화면에서는 방향키(alternate-scroll 등가), application cursor 도 따른다.
ok('PC 가 application cursor 모드를 반영한다', pane.includes('applicationCursorKeysMode') && pane.includes('\\x1bOA'));
ok('앱이 application cursor 모드를 반영한다', app.includes('term.modes&&term.modes.applicationCursorKeysMode'));

// 5) tmux 옵션 전제 — alternate-screen 이 off 면 tmux 가 alt 버퍼를 따로 두지 않아 TUI 화면이
//    pane history 로 밀려들어간다(= 재시작 시드가 쓰레기가 된다). 기본이 on 이라 명시 설정은
//    2026-09-06 제거했고, **off 로 되돌리는 것만** 금지한다.
for (const conf of ['../../codingpt_daemon/tmux.conf', '../../codingpt_back/tmux.conf']) {
  const text = fs.readFileSync(path.join(here, conf), 'utf8');
  ok(`${path.basename(path.dirname(conf))}/tmux.conf 가 alternate-screen 을 끄지 않는다`,
    !/alternate-screen\s+off/m.test(text));
}

// 6) 과거(스크롤백)의 정본 — 2026-09-10 재설계. **라이브 버퍼 하나가 곧 과거다.**
//    근거(실측): ① v3 control mode 는 tty 를 안 그린다 → 리사이즈에도 %output 재도장 바이트 0
//    (v2 tty attach 시절 "재도장 잔재" 때문에 스크롤백을 0 으로 죽였던 이유가 사라졌다).
//    ② 스냅샷 `ansi`(serializeRepaint)가 데몬 VT 의 **스크롤백까지 통째로** 담는다(과거 301줄 +
//    화면 24줄 = 2.8KB). 그래서 어느 기기에서 언제 붙어도 같은 과거가 그 버퍼에 들어오고, 위로
//    스크롤은 일반 터미널과 완전히 같아진다 — 별도 과거 오버레이·페이지 요청은 전부 삭제했다.
//    계약을 지키는 데몬측 회귀: runner-core/test/terminal-host.test.js('스냅샷 하나로 …').
ok('PC 라이브 격자가 과거를 담는다', /scrollback: LIVE_SCROLLBACK,/.test(pane));
ok('앱 라이브 격자가 같은 한도로 과거를 담는다', /scrollback: 10000,/.test(app));
ok('PC 일반 셸 스크롤은 자기 버퍼로 간다', /this\.term\?\.scrollLines\(dy < 0 \? -count : count\)/.test(pane));
ok('앱 일반 셸 스크롤도 자기 버퍼로 간다', /term\.scrollLines\(lines\)/.test(app));
// 과거 오버레이(별도 xterm·페이지 요청·모드 전환 배너)가 되살아나지 않게 부재를 못 박는다.
for (const [label, src, needles] of [
  ['PC', pane, ['_histOn', '_histTerm', 'pane-term-hist', 'pane-hist-tag', 'type: "history"']],
  ['앱', app, ['__histOn', '__histTerm', 'historyViewport', 'hist-on', "type:'history'"]],
]) {
  for (const n of needles) ok(`${label} 에 과거 오버레이 잔재가 없다 (${n})`, !src.includes(n));
}
// 입력하면 맨 아래(라이브)로 — 일반 터미널 규칙. 두 구현 다 xterm 키 핸들러를 우회하므로 명시적으로 한다.
ok('PC: 입력하면 맨 아래로 내려온다', /_write\(d\) \{[\s\S]{0,400}?this\.term\?\.scrollToBottom\(\)/.test(pane));
ok('앱: 입력하면 맨 아래로 내려온다', /var send = function\(s\)\{ try \{\s*term\.scrollToBottom\(\);/.test(app));
// clear 가 과거를 지우는 유일한 경로 = TERM 의 E3(CSI 3J) — xterm 네이티브. 임의 2J 훅은 데몬 VT 와
//  어긋나 그 기기에서만 과거가 사라진다(실측: 3J 로 과거 31→0, 2J 로는 안 지워짐).
ok('앱에 임의 CSI 2J 스크롤백 삭제 훅이 없다', !app.includes("registerCsiHandler({ final:'J' }"));
ok('PC 에도 없다', !pane.includes("registerCsiHandler"));

// 6-6) v3 뷰어 계약(docs/terminal-v3-design.md §4) — 격자는 소유자 것, 크기 주장은 소유자만, 비소유자는 축소.
{
  const pcV3 = fs.readFileSync(path.join(here, '../src/js/terminal-stream-v3.js'), 'utf8');
  const dmV3 = fs.readFileSync(path.join(here, '../../codingpt_daemon/packages/runner-core/terminal-stream-v3.js'), 'utf8');
  const codes = (t, from, to) => Object.fromEntries([...t.slice(t.indexOf(from), to ? t.indexOf(to) : undefined).matchAll(/([A-Z_]+):\s*(\d+)/g)].map((m) => [m[1], m[2]]));
  ok('PC/데몬 v3 opcode 표 일치', JSON.stringify(codes(pcV3, 'TERMINAL_OPCODE_V3')) === JSON.stringify(codes(dmV3, 'OPCODE = Object.freeze', 'function encode')));
  ok('PC/데몬 v3 MAGIC·헤더 길이 일치', pcV3.includes('0x43, 0x50, 0x54, 0x33') && dmV3.includes("Buffer.from('CPT3')") && pcV3.includes('HEADER_BYTES = 14') && dmV3.includes('4 + 1 + 1 + 4 + 4'));
  ok('PC: 크기는 소유자만 주장한다', /if \(!this\._isOwner && !this\._ownerFree\) return;\n\s+if \(this\.ws && this\.ws\.readyState === 1\) this\.ws\.send\(JSON\.stringify\(\{ type: "resize"/.test(pane));
  // ★ 축소는 CSS transform 이 아니라 **글꼴 크기**로 한다(2026-09-06 안드로이드 실기 회귀 — Android
  //   WebView 는 WebGL 캔버스를 별도 하드웨어 레이어로 합성해 조상 transform 배율을 안 먹는다).
  //   앱(TerminalWebView)도 같은 계약이라 여기서 한 벌로 고정한다.
  ok('PC: 비소유자는 격자를 바꾸지 않고 글꼴로 줄여 본다',
    /if \(this\._grid && !this\._isOwner && !this\._ownerFree\) \{[\s\S]{0,300}?this\._applyScale\(\);\s+return;/.test(pane)
      && /this\.term\.options\.fontSize = want/.test(pane)
      && /this\.term\.resize\(this\._grid\.cols, this\._grid\.rows\)/.test(pane)
      && !/style\.transform = `?scale/.test(pane));
  ok('앱도 같은 축소 계약(글꼴)을 쓴다', /term\.options\.fontSize = want/.test(app) && !/style\.transform = 'scale/.test(app));
  ok('PC: 스냅샷은 입력 모드(1049·마우스·bracketed paste)를 먼저 복원한다', /if \(md\.altScreen\) pre \+= "\\x1b\[\?1049h"/.test(pane) && /md\.mouseTracking\) pre \+= "\\x1b\[\?1000h\\x1b\[\?1006h"/.test(pane));
  // ★ epoch 를 같이 보내야 한다(2026-09-06 실기 사고). 데몬이 재시작하면 host 의 seq 가 0 부터 다시
  //   세는데, 세대 없이 큰 lastSeq 만 보내면 데몬이 "너는 최신"으로 오판해 아무것도 안 보내고 화면이
  //   영원히 멈춘다. 스냅샷의 epoch 를 보관했다가 hello 에 동봉한다.
  ok('PC: 재접속은 hello{lastSeq, epoch} 로 이어받는다',
    /JSON\.stringify\(\{ type: "hello", lastSeq: this\._v3Seq, epoch: this\._v3Epoch \}\)/.test(pane)
      && /this\._v3Epoch = m\.epoch/.test(pane));
  ok('PC: 소유권은 명시적 claim 만(자동 탈취 없음)', /JSON\.stringify\(\{ type: "claim" \}\)/.test(pane) && !/type: "claim"[\s\S]{0,40}setInterval/.test(pane));
  ok('PC: 스크롤 라우팅 판정이 로컬 xterm 상태다(서버 modes 조회 없음)', /buffer\?\.active\?\.type === "alternate"; return;/.test(pane));
}
// 6-3) 퇴화 크기 전송 금지(2026-09-05 안드로이드 실기): 격자가 숨겨진 순간 FitAddon 은 최소값
//   (2x1)을 준다. 그게 공유 tmux window 로 나가면 전 기기 터미널이 접힌다.
ok('앱: 퇴화 크기는 전송하지 않는다', /term\.cols >= 8 && term\.rows >= 3/.test(app) && /ws\.readyState === 1 && __sane\(\)/.test(app));
ok('PC: 퇴화 크기는 전송하지 않는다', /if \(this\.term\.cols < 8 \|\| this\.term\.rows < 3\) return;/.test(pane));

// 6-5) tmux 는 배경이 줄 끝까지 이어지면 리셋을 안 붙인다 → 행은 자족적이어야 한다(색 번짐).
//   (뷰어는 이제 안 쓰지만 historyPage 는 승인·상태감지 등 서버측 소비자가 계속 쓴다.)
{
  const tmuxBackend = fs.readFileSync(path.join(here, '../../codingpt_daemon/packages/runner-core/term-backend-tmux.js'), 'utf8');
  const rust = fs.readFileSync(path.join(here, '../src-tauri/src/pty.rs'), 'utf8');
  ok('데몬이 과거 행마다 속성을 닫는다', /if \(ansi\.includes\('\\x1b'\)\) ansi \+= '\\x1b\[0m';/.test(tmuxBackend));
  ok('PC(로컬)도 과거 행마다 속성을 닫는다', /raw\.contains\('\\u\{1b\}'\)[\s\S]{0,80}?\\u\{1b\}\[0m/.test(rust));
}

// 7) 프레임 opcode 표가 데몬과 어긋나면 과거 응답을 통째로 놓친다(조용한 실패). v2 표는 2026-09-06 삭제.
{
  const pcV3 = fs.readFileSync(path.join(here, '../src/js/terminal-stream-v3.js'), 'utf8');
  const dmV3 = fs.readFileSync(path.join(here, '../../codingpt_daemon/packages/runner-core/terminal-stream-v3.js'), 'utf8');
  const codes = (t) => Object.fromEntries([...t.matchAll(/([A-Z_]+):\s*(\d+)/g)].map((m) => [m[1], m[2]]));
  const a = codes(pcV3.slice(pcV3.indexOf('TERMINAL_OPCODE_V3')));
  const b = codes(dmV3.slice(dmV3.indexOf('OPCODE = Object.freeze'), dmV3.indexOf('function encode')));
  ok('PC/데몬 CPT3 opcode 표 일치', JSON.stringify(a) === JSON.stringify(b) && a.HISTORY_PAGE === '5');
  // 구 v2 디코더가 되살아나지 않게 부재를 못 박는다(두 리포 모두).
  ok('v2 스트림 모듈이 남아 있지 않다',
    !fs.existsSync(path.join(here, '../src/js/terminal-stream-v2.js'))
    && !fs.existsSync(path.join(here, '../../codingpt_daemon/packages/runner-core/terminal-stream-v2.js')));
}

// 8) `clear` 가 과거까지 지우려면 tmux 가 지운 화면을 history 로 도로 밀지 않아야 한다.
for (const conf of ['../../codingpt_daemon/tmux.conf', '../../codingpt_back/tmux.conf']) {
  const text = fs.readFileSync(path.join(here, conf), 'utf8');
  ok(`${path.basename(path.dirname(conf))}/tmux.conf 가 scroll-on-clear 를 끈다`,
    /^\s*setw -g scroll-on-clear off\s*$/m.test(text));
}

console.log(`\nALL CONFORMANT — pass ${pass} / fail 0`);
