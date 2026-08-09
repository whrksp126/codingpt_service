/**
 * tmux send-keys 키 표기 → 바이트 변환기 (설계 계약 1).
 *
 * 상위 계층(cpt-server 등)이 tmux 에 보내던 키 이름을 **그대로** 받아 pty 에 쓸 바이트로 바꾼다.
 * 커버 대상 = 데몬 실사용 표기 전수(2026-08 grep 실측):
 *   Enter · Escape · Tab · BTab(=S-Tab) · Up/Down/Left/Right · C-u · C-c · BSpace(-N 반복) ·
 *   M-Enter · Home/End · PPage/NPage · DC · Space · 숫자/문자 리터럴 · `-l --` 리터럴 모드 ·
 *   bracketed paste 마커(호출자가 리터럴 문자열에 \x1b[200~…\x1b[201~ 를 직접 심는다 — 여기서
 *   변환하지 않는다. tmux send-keys -l 도 동일하게 그대로 통과시켰다).
 *
 * tmux 와 동일한 의미론:
 *  · 이름 조회 실패 = 문자열을 리터럴로 전송(tmux man: "If the key is not recognised, the string
 *    is sent as a series of characters").
 *  · 방향키는 DECCKM(application cursor keys) 상태에 따라 CSI/SS3 를 가른다 — 호출측이
 *    opts.appCursor 로 세션의 현재 모드를 넘긴다(tmux 가 pane 모드를 보고 가르는 것과 동일).
 *  · 수식어 접두 C-/M-/S-/^ 를 중첩 허용(C-M-x). 수식어 붙은 특수키는 xterm CSI 1;m 규약.
 *
 * 순수 함수(플랫폼/전역 상태 무접촉) — mac 에서 node --test 로 검증한다.
 */
'use strict';

// 이름 → 고정 바이트(수식어 없음 기준).
const NAMED = {
  Enter: '\r',
  Escape: '\x1b',
  Esc: '\x1b',
  Tab: '\t',
  BTab: '\x1b[Z',            // shift+tab — tmux 표기 BTab(S-Tab 도 아래에서 여기로 접는다)
  Space: ' ',
  BSpace: '\x7f',            // tmux 기본 backspace = DEL(0x7f)
  BackSpace: '\x7f',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~',
  F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

// 방향키 — CSI(기본) / SS3(application cursor keys) 이원.
const CURSOR = { Up: 'A', Down: 'B', Right: 'C', Left: 'D' };

// tilde 계열 특수키(수식어는 CSI <n>;<m>~ 로 확장).
const TILDE = { Home: 1, IC: 2, Insert: 2, DC: 3, Delete: 3, End: 4, PPage: 5, PageUp: 5, PgUp: 5, NPage: 6, PageDown: 6, PgDn: 6 };

// xterm 수식어 파라미터: 1 + shift(1) + meta(2) + ctrl(4)
function modParam(m) {
  return 1 + (m.shift ? 1 : 0) + (m.meta ? 2 : 0) + (m.ctrl ? 4 : 0);
}

function ctrlByte(ch) {
  if (ch === ' ' || ch === '@') return '\x00';
  if (ch === '?') return '\x7f';
  const c = ch.toUpperCase().charCodeAt(0);
  // A-Z·[·\·]·^·_ 범위 밖(예: C-1)은 제어코드가 없다 — tmux 도 문자를 그대로 보낸다.
  const code = c & 0x1f;
  if (c >= 0x3f && c <= 0x5f) return String.fromCharCode(code);
  return ch;
}

/**
 * 키 1개(tmux 표기)를 바이트 문자열로.
 * @param {string} key   tmux 키 표기('C-c', 'Enter', 'BSpace', …) 또는 리터럴 문자열
 * @param {object} opts  { literal?: boolean, appCursor?: boolean }
 * @returns {string} pty 에 쓸 바이트(문자열 — Buffer.from(s,'binary') 가 아닌 utf8 write 대상)
 */
function keyToBytes(key, opts = {}) {
  const s = String(key);
  if (opts.literal) return s;                     // send-keys -l — 무변환(bracketed paste 마커 포함)
  if (!s) return '';

  // 16진 표기(tmux: 0x03 등)
  if (/^0x[0-9a-fA-F]{1,2}$/.test(s)) return String.fromCharCode(parseInt(s, 16));

  // 수식어 접두 파싱 — C-/M-/S-/^ 중첩 허용. '^' 단독은 리터럴 '^'.
  const m = { ctrl: false, meta: false, shift: false };
  let rest = s;
  for (;;) {
    if (/^C-/.test(rest) && rest.length > 2) { m.ctrl = true; rest = rest.slice(2); continue; }
    if (/^M-/.test(rest) && rest.length > 2) { m.meta = true; rest = rest.slice(2); continue; }
    if (/^S-/.test(rest) && rest.length > 2) { m.shift = true; rest = rest.slice(2); continue; }
    if (/^\^/.test(rest) && rest.length > 1) { m.ctrl = true; rest = rest.slice(1); continue; }
    break;
  }

  // S-Tab = BTab(\x1b[Z) — cpt 실사용 표기.
  if (rest === 'Tab' && m.shift && !m.ctrl && !m.meta) return NAMED.BTab;

  // 방향키 — 수식어 있으면 CSI 1;mX, 없으면 DECCKM 에 따라 SS3/CSI.
  if (CURSOR[rest]) {
    if (m.ctrl || m.meta || m.shift) return `\x1b[1;${modParam(m)}${CURSOR[rest]}`;
    return (opts.appCursor ? '\x1bO' : '\x1b[') + CURSOR[rest];
  }

  // tilde 계열 — 수식어 있으면 CSI n;m~
  if (TILDE[rest] != null) {
    if (m.ctrl || m.meta || m.shift) return `\x1b[${TILDE[rest]};${modParam(m)}~`;
    return `\x1b[${TILDE[rest]}~`;
  }

  // 고정 이름(Enter/Escape/Tab/BSpace/F1…) — meta 는 ESC 접두(M-Enter = \x1b\r).
  if (NAMED[rest] != null) {
    let b = NAMED[rest];
    if (m.ctrl && rest === 'BSpace') b = '\x08';       // C-BSpace 관례(제어 BS)
    else if (m.ctrl && b.length === 1) b = ctrlByte(b); // C-Space=\x00 등 — 이름 결과가 단일 문자면 제어화
    return m.meta ? '\x1b' + b : b;
  }

  // 단일 문자 — ctrl 은 제어코드, shift 는 대문자, meta 는 ESC 접두.
  if ([...rest].length === 1) {
    let b = rest;
    if (m.shift) b = b.toUpperCase();
    if (m.ctrl) b = ctrlByte(b);
    return m.meta ? '\x1b' + b : b;
  }

  // 미인식 다중 문자 = 리터럴(tmux 동일 의미론). 수식어가 붙었어도 원문 전체를 리터럴로.
  return s;
}

/**
 * 키 배열 → 바이트(문자열). count(-N)는 배열 전체를 반복(tmux -N 과 동일).
 */
function keysToBytes(keys, opts = {}) {
  const list = Array.isArray(keys) ? keys : [keys];
  const once = list.map((k) => keyToBytes(k, opts)).join('');
  const n = Math.max(1, parseInt(opts.count, 10) || 1);
  return once.repeat(n);
}

module.exports = { keyToBytes, keysToBytes };
