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

// 2) 우선순위는 양쪽이 같다: mouse > alternate > 과거(서버 정본).
ok('PC 는 mouse tracking 이면 xterm 경로 유지', /if \(tracking && !this\._histOn\) return;/.test(pane));
ok('PC 는 mouse 다음에 alternate 를 본다', /if \(tracking[\s\S]{0,600}?if \(modes\.altScreen[\s\S]{0,400}?_histScroll/.test(pane));
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

// 6) 과거(스크롤백)의 정본 — 2026-09-04 사용자 신고("PC 는 clear 해도 위로 스크롤되고 뭉개진 게 보인다").
//    tmux 는 리사이즈마다 pane 을 커서 위치에 다시 그린다(ED 없이 `\e[K`+`\r\n`). 그 스트림을 먹는
//    xterm 의 스크롤백에 쌓이는 건 과거가 아니라 재도장 잔재다. 그래서 라이브 격자는 스크롤백을
//    갖지 않고, 과거는 서버/tmux 정본에서 페이지로 받아 오버레이에 그린다 — PC·앱 같은 계약.
ok('PC 라이브 격자는 tmux 백엔드에서 스크롤백을 쌓지 않는다',
  /scrollback: this\._srvHistory \? 0 : LIVE_SCROLLBACK,/.test(pane)
  && /this\.term\.options\.scrollback = on \? 0 : LIVE_SCROLLBACK/.test(pane));
ok('PC 는 서버 과거가 없는 백엔드(term-host)에선 로컬 스크롤로 폴백한다',
  /if \(!this\._srvHistory\) \{ try \{ this\.term\?\.scrollLines\(n\); \}/.test(pane));
ok('PC 가 로컬 과거를 tmux 정본에서 읽는다', pane.includes('api.ptyHistory(this.id'));
ok('PC 가 과거를 데몬 v3 계약으로 읽는다(로컬·원격 동일)',
  /JSON\.stringify\(\{ type: "history", before: before \?\? null, limit: HIST_PAGE \}\)/.test(pane)
  && pane.includes('TERMINAL_OPCODE_V3.HISTORY_PAGE'));

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
ok('앱도 같은 요청 계약을 쓴다', /type:'history',before:before,limit:500/.test(app));
ok('PC 오버레이는 한 번 써 넣고 자체 스크롤한다(스텝마다 재작성 금지)',
  pane.includes('v.scrollLines(n)') && /this\._histWritten = this\._histTotal;/.test(pane));
ok('앱 오버레이도 같은 설계', app.includes('v.scrollLines(n)') && app.includes('__histWritten=__histTotal'));
ok('PC 오버레이는 보이게 만든 뒤 open 한다(흰 화면 회귀)',
  /_showHistory\(\)[\s\S]{0,400}?this\.histEl\.style\.display = "block"/.test(pane)
  && pane.includes('this.histEl.querySelector(".xterm-rows")'));

// 6-2) 실기에서 잡힌 결함 2종(2026-09-04) — 둘 다 "동작은 하는데 몇 초 뒤 사라진다" 류라 코드로 고정한다.
ok('PC: 리컨실러의 멱등 showActiveTab 이 과거 보기를 닫지 않는다',
  /this\._surfaceSig !== sig[\s\S]{0,120}?this\._hideHistory\(\)/.test(pane));
ok('PC: 과거 진입은 캐시를 믿지 않고 항상 새로 물어본다(clear 뒤 유령 과거 방지)',
  /if \(n > 0\) return;[\s\S]{0,400}?this\._requestHistory\(null\);\n\s+return;\n\s+\}/.test(pane)
  && !/if \(!this\._histTotal\) \{\s+\/\/ 총량/.test(pane));
ok('PC: 총량이 줄면(clear·상한초과) 캐시를 버린다',
  /if \(total < this\._histTotal\) \{ this\._histRows\.clear\(\)/.test(pane));

// 6-3) 퇴화 크기 전송 금지(2026-09-05 안드로이드 실기): 과거 보기 중 라이브 격자가 숨겨지면
//   FitAddon 이 최소값(2x1)을 준다. 그게 공유 tmux window 로 나가면 전 기기 터미널이 접힌다.
ok('앱: 과거 보기 중에는 fit 하지 않는다', /var __fitNow = function\(\)\{[\s\S]{0,700}?if \(__histOn\) return;/.test(app));
ok('앱: 퇴화 크기는 전송하지 않는다', /term\.cols >= 8 && term\.rows >= 3/.test(app) && /ws\.readyState === 1 && __sane\(\)/.test(app));
ok('앱: 과거 보기를 접으면 미룬 fit 을 따라잡는다', /classList\.remove\('hist-on'\)[\s\S]{0,300}?__fitNow\(\)/.test(app));
ok('PC: 퇴화 크기는 전송하지 않는다', /if \(this\.term\.cols < 8 \|\| this\.term\.rows < 3\) return;/.test(pane));

// 6-4) 과거 오버레이 자신이 스크롤 입력을 받아야 한다(2026-09-05 안드로이드 실기): 과거를 보는
//   동안 라이브 격자는 숨겨져 있으므로, 오버레이가 입력을 안 받으면 더 올라갈 수도 돌아올 수도 없다.
ok('앱 오버레이가 터치를 받는다(pointer-events:none 회귀 금지)',
  !/#historyViewport \{[^}]*pointer-events:none/.test(app)
  && /__histEl\.addEventListener\('touchmove'/.test(app));
ok('PC 오버레이가 휠을 받는다', /this\.histEl\?\.addEventListener\("wheel", onWheel, opt\)/.test(pane));

// 6-5) tmux 는 배경이 줄 끝까지 이어지면 리셋을 안 붙인다 → 행은 자족적이어야 한다(색 번짐).
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
