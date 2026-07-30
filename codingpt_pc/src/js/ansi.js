// ansi.js — TUI statusline 미러용 최소 ANSI(SGR) → HTML 변환기.
//  캡처 원문(2026-07-30 실측)에 등장하는 서브셋이 정본: 0 리셋 · 1 bold · 2 dim · 3 italic ·
//  4 underline · 7 반전 · 22/23/24/27 해제 · 30-37/90-97 fg · 39 기본 fg · 38;5;n(256) ·
//  38;2;r;g;b(truecolor) · 40-47/100-107/48;5/48;2/49 bg. 그 외 SGR 은 무시, 비-SGR CSI/OSC 는 제거.
//  16색은 터미널 팔레트(theme.termTheme())를 그대로 써 pane 터미널과 색이 일치한다.

const NAMED16 = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

// xterm 256색 표준 공식 — 16-231 = 6×6×6 큐브, 232-255 = 그레이 램프.
function color256(n, palette) {
  if (n < 16) return palette[NAMED16[n]] || null;
  if (n < 232) {
    const c = n - 16;
    const lv = (v) => (v === 0 ? 0 : 55 + v * 40);
    const r = lv(Math.floor(c / 36)), g = lv(Math.floor((c % 36) / 6)), b = lv(c % 6);
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * ANSI 한 줄 → HTML(스팬). palette = termTheme() 반환(named 16색 + foreground/background).
 * 상태ful 이지만 줄 단위 호출(줄 시작마다 리셋) — statusline 은 줄마다 자체 색을 다시 칠한다(실측).
 */
export function ansiToHtml(line, palette) {
  const pal = palette || {};
  const st = { bold: false, dim: false, italic: false, underline: false, inverse: false, fg: null, bg: null };
  const out = [];
  let text = "";
  const flush = () => {
    if (!text) return;
    const styles = [];
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { const t = fg || pal.foreground || "inherit"; fg = bg || pal.background || "inherit"; bg = t; }
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    if (st.bold) styles.push("font-weight:700");
    if (st.dim) styles.push("opacity:0.6");
    if (st.italic) styles.push("font-style:italic");
    if (st.underline) styles.push("text-decoration:underline");
    out.push(styles.length ? `<span style="${styles.join(";")}">${esc(text)}</span>` : esc(text));
    text = "";
  };
  const s = String(line || "");
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\x1b") {
      if (s[i + 1] === "[") {
        const m = /^\x1b\[([0-9;:]*)m/.exec(s.slice(i));
        if (m) {
          flush();
          applySgr(st, m[1], pal);
          i += m[0].length;
          continue;
        }
        const other = /^\x1b\[[0-9;:?]*[A-Za-z]/.exec(s.slice(i)); // 비-SGR CSI — 제거
        if (other) { i += other[0].length; continue; }
      }
      if (s[i + 1] === "]") { // OSC — BEL/ST 까지 제거
        const end = s.indexOf("\x07", i);
        const st2 = s.indexOf("\x1b\\", i);
        const stop = end >= 0 && (st2 < 0 || end < st2) ? end + 1 : st2 >= 0 ? st2 + 2 : s.length;
        i = stop;
        continue;
      }
      i += 2; // 그 외 이스케이프(2바이트) 스킵
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out.join("");
}

function applySgr(st, params, pal) {
  const p = (params || "").split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) { st.bold = st.dim = st.italic = st.underline = st.inverse = false; st.fg = st.bg = null; }
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 7) st.inverse = true;
    else if (n === 22) { st.bold = false; st.dim = false; }
    else if (n === 23) st.italic = false;
    else if (n === 24) st.underline = false;
    else if (n === 27) st.inverse = false;
    else if (n >= 30 && n <= 37) st.fg = pal[NAMED16[n - 30]] || null;
    else if (n >= 90 && n <= 97) st.fg = pal[NAMED16[n - 90 + 8]] || null;
    else if (n === 39) st.fg = null;
    else if (n >= 40 && n <= 47) st.bg = pal[NAMED16[n - 40]] || null;
    else if (n >= 100 && n <= 107) st.bg = pal[NAMED16[n - 100 + 8]] || null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      const isFg = n === 38;
      if (p[i + 1] === 5 && p.length > i + 2) {
        const c = color256(p[i + 2], pal);
        if (isFg) st.fg = c; else st.bg = c;
        i += 2;
      } else if (p[i + 1] === 2 && p.length > i + 4) {
        const c = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
        if (isFg) st.fg = c; else st.bg = c;
        i += 4;
      }
    }
  }
}
