// windows-port.mjs — Windows 포팅(워크스트림 C)의 DOM 무관 로직 고정.
//
// 고정하는 것 세 가지:
//  ① win32 기본 바인딩 표(WIN_KEYS 오버라이드) — 터미널 제어문자와 충돌하지 않는 조합이어야 하고,
//    실제 키 이벤트(comboFromEvent)와 문자열까지 일치해야 단축키가 눌린다.
//  ② combo 포맷의 Ctrl 명시 수식어 — 비-Apple 에선 Ctrl≡Mod 라 접어야(fold) 매칭이 살고,
//    mac 저장값(Mod+X)은 그대로 호환돼야 한다. AltGr(ctrl+alt)는 항상 문자 입력으로 통과.
//  ③ path-utils — `/` 경로에서 종전 split("/") 구현과 동일해야 macOS 회귀가 없고,
//    `\` 경로에서도 같은 의미가 나와야 win32 가 산다. shellQuote 는 셸별 인용.
//
// `node --test` 규약(test 러너)으로 작성 — `node test/windows-port.mjs` 단독 실행도 동작한다.
import { test } from "node:test";
import assert from "node:assert/strict";

const C = await import("../src/js/commands.js");
const P = await import("../src/js/path-utils.js");

// ── ① win32 기본 바인딩 표 ───────────────────────────────────────────────────
test("win32 기본값: Ctrl+글자 단독(제어문자 충돌) 조합이 하나도 없다", () => {
  const b = C.resolveBindings("pc", null, true);
  for (const [id, combo] of Object.entries(b)) {
    if (!combo) continue;
    const parts = combo.split("+");
    const key = parts.pop();
    if (/^[A-Z]$/.test(key)) {
      assert.ok(!(parts.length === 1 && parts[0] === "Mod"),
        `${id}=${combo} 가 Ctrl+${key} 로 풀려 셸 ^${key} 를 삼킨다`);
    }
    assert.ok(!(parts.includes("Mod") && parts.includes("Alt")),
      `${id}=${combo} 는 Ctrl+Alt(AltGr) 계열 — win32 기본값 금지`);
  }
});

test("win32 기본값: 핵심 조합이 계약(WT/VS Code 관용)대로다", () => {
  const b = C.defaultBindings("pc", true);
  assert.equal(b["palette.open"], "Mod+Shift+P");
  assert.equal(b["find.open"], "Mod+Shift+F");
  assert.equal(b["sidebar.toggle"], "Mod+Shift+B");
  assert.equal(b["pane.splitRight"], "Mod+Shift+D");
  assert.equal(b["pane.splitDown"], "Alt+Shift+D");
  assert.equal(b["pane.close"], "Mod+Shift+W");
  assert.equal(b["ws.addTerminal"], "Mod+Shift+T");
  assert.equal(b["ws.addIde"], "Mod+Shift+E");
  assert.equal(b["ws.addPreview"], "Mod+Shift+O");
  assert.equal(b["pane.focusLeft"], "Alt+ArrowLeft");
  // Ctrl 로 풀려도 제어문자가 아닌 것들은 mac 표 그대로.
  assert.equal(b["ws.select1"], "Mod+1");
  assert.equal(b["app.settings"], "Mod+Comma");
  assert.equal(b["notif.latestUnread"], "Mod+Shift+U");
});

test("win32 기본값: 충돌 0", () => {
  assert.deepEqual(C.findConflicts(C.resolveBindings("pc", null, true)), {});
});

test("mac 경로 회귀 0: windows 인자 없는 호출은 종전과 동일", () => {
  const b = C.resolveBindings("pc", null);
  assert.equal(b["palette.open"], "Mod+P");
  assert.equal(b["find.open"], "Mod+F");
  assert.equal(b["pane.focusLeft"], "Mod+Alt+ArrowLeft");
  assert.deepEqual(C.defaultBindings("pc"), C.defaultBindings("pc", false));
});

// ── ② 이벤트 → 조합, Ctrl 명시 수식어 ────────────────────────────────────────
test("비-Apple: Ctrl+Shift+P 이벤트가 win 기본값 문자열과 정확히 매칭된다", () => {
  const combo = C.comboFromEvent({ code: "KeyP", key: "P", ctrlKey: true, shiftKey: true }, false);
  assert.equal(combo, "Mod+Shift+P");
  const resolved = C.resolveBindings("pc", null, true);
  assert.equal(C.commandForCombo(resolved, combo), "palette.open");
});

test("비-Apple: AltGr(ctrl+alt 동시)는 조합이 아니다(문자 입력 통과)", () => {
  assert.equal(C.comboFromEvent({ code: "KeyE", key: "€", ctrlKey: true, altKey: true }, false), null);
  assert.equal(C.comboFromEvent({ code: "Digit2", key: "²", ctrlKey: true, altKey: true }, false), null);
  // Apple 은 ⌃⌥ 가 딴 조합이라 종전대로 산다(mac 회귀 0).
  assert.equal(C.comboFromEvent({ code: "KeyE", key: "e", ctrlKey: true, altKey: true }, true), "Ctrl+Alt+E");
});

test("Ctrl 명시 저장값(수기 편집): win 에선 Mod 로 접혀 매칭된다", () => {
  assert.equal(C.foldCtrlIntoMod("Ctrl+Shift+K"), "Mod+Shift+K");
  assert.equal(C.foldCtrlIntoMod("Mod+Ctrl+X"), "Mod+X");
  assert.equal(C.foldCtrlIntoMod("nonsense"), null);
  const r = C.resolveBindings("pc", { "find.open": "Ctrl+Shift+K" }, true);
  assert.equal(r["find.open"], "Mod+Shift+K");
  // mac(3번째 인자 없음)에선 접지 않는다 — ⌘⌃ 조합 보존.
  const rMac = C.resolveBindings("pc", { "find.open": "Mod+Ctrl+K" });
  assert.equal(rMac["find.open"], "Mod+Ctrl+K");
});

test("표기: 비-Apple 에서 Mod+Ctrl 이 Ctrl 하나로 접힌다(mac 표기는 종전 그대로)", () => {
  assert.equal(C.formatCombo("Mod+Ctrl+X", false), "Ctrl+X");
  assert.equal(C.formatCombo("Mod+Shift+D", false), "Ctrl+Shift+D");
  assert.equal(C.formatCombo("Mod+Ctrl+X", true), "⌘⌃X");
  assert.equal(C.formatCombo("Mod+P", true), "⌘P");
});

// ── ③ path-utils ────────────────────────────────────────────────────────────
test("basename/dirname: `/` 경로에서 종전 split('/') 구현과 동일", () => {
  const olds = (p) => p.split("/").pop() || p;
  const oldd = (p) => p.split("/").slice(0, -1).join("/");
  for (const p of ["a/b/c.txt", "a", "a/b", "src/js/pane.js", ".hidden"]) {
    assert.equal(P.basename(p) || p, olds(p), `basename(${p})`);
    assert.equal(P.dirname(p), oldd(p), `dirname(${p})`);
  }
});

test("basename/dirname/splitSegs: `\\` 경로도 같은 의미", () => {
  assert.equal(P.basename("C:\\Users\\x\\a.txt"), "a.txt");
  assert.equal(P.dirname("C:\\Users\\x\\a.txt"), "C:\\Users\\x");
  assert.deepEqual(P.splitSegs("C:\\Users\\x"), ["C:", "Users", "x"]);
  assert.deepEqual(P.splitSegs("a/b/c"), ["a", "b", "c"]);
  assert.equal(P.basename("proj\\src/mix.js"), "mix.js");
});

test("isAbs: POSIX·드라이브·UNC 전부, 상대 경로는 아님", () => {
  assert.ok(P.isAbs("/a/b"));
  assert.ok(P.isAbs("C:\\a"));
  assert.ok(P.isAbs("c:/a"));
  assert.ok(P.isAbs("\\\\server\\share"));
  assert.ok(!P.isAbs("a/b"));
  assert.ok(!P.isAbs("~/a")); // ~ 는 절대가 아니라 홈-상대 표기다(호출부가 따로 본다)
});

test("joinPath: `/` 기반은 종전 `a + '/' + b` 와 동일, win 스타일은 `\\` 로 잇는다", () => {
  assert.equal(P.joinPath("a/b", "c.txt"), "a/b/c.txt");
  assert.equal(P.joinPath("a/b/", "c.txt"), "a/b/c.txt");
  assert.equal(P.joinPath("C:\\Users\\x", "a.txt"), "C:\\Users\\x\\a.txt");
  assert.equal(P.joinPath("", "c.txt"), "c.txt");
});

test("shellQuote: POSIX 는 종전 shq 와 동일, win32 는 PowerShell 인용(' 두 배)", () => {
  const oldShq = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'";
  for (const p of ["/a/b c.txt", "/a/it's.txt", "한글 경로/파일.png"]) {
    assert.equal(P.shellQuote(p, false), oldShq(p), `posix(${p})`);
  }
  assert.equal(P.shellQuote("C:\\a b\\c.txt", true), "'C:\\a b\\c.txt'");
  assert.equal(P.shellQuote("C:\\it's.txt", true), "'C:\\it''s.txt'");
});
