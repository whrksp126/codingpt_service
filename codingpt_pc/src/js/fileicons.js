// fileicons.js — Material Icon Theme 스타일 파일/폴더 아이콘.
//  실제 npm material-icon-theme 의 색·모노그램 배지 룩을 근사(오프라인 인라인 SVG).
//  파일 = 브랜드 컬러 라운드 배지 + 흰 모노그램/심볼. 폴더 = 테마 컬러 채운 폴더(특수폴더 색 구분).

// 확장자 → { c: 배지색, t: 모노그램 }
const EXT = {
  js: { c: "#f0db4f", t: "JS", dark: 1 }, mjs: { c: "#f0db4f", t: "JS", dark: 1 }, cjs: { c: "#f0db4f", t: "JS", dark: 1 },
  jsx: { c: "#61dafb", t: "JS", dark: 1 },
  ts: { c: "#3178c6", t: "TS" }, tsx: { c: "#3178c6", t: "TS" }, mts: { c: "#3178c6", t: "TS" }, cts: { c: "#3178c6", t: "TS" },
  json: { c: "#f5de19", t: "{ }", dark: 1 }, jsonc: { c: "#f5de19", t: "{ }", dark: 1 },
  html: { c: "#e34f26", t: "<>" }, htm: { c: "#e34f26", t: "<>" },
  css: { c: "#42a5f5", t: "#" }, scss: { c: "#cd6799", t: "S" }, sass: { c: "#cd6799", t: "S" }, less: { c: "#2a4d80", t: "L" },
  vue: { c: "#41b883", t: "V" }, svelte: { c: "#ff3e00", t: "S" }, astro: { c: "#ff5d01", t: "A" },
  md: { c: "#42a5f5", t: "M" }, markdown: { c: "#42a5f5", t: "M" }, mdx: { c: "#fbc02d", t: "M", dark: 1 },
  py: { c: "#3c78aa", t: "PY" }, pyc: { c: "#3c78aa", t: "PY" },
  rb: { c: "#e0245e", t: "RB" }, go: { c: "#00acd7", t: "GO" }, rs: { c: "#ff7043", t: "RS" },
  java: { c: "#f44336", t: "JV" }, kt: { c: "#a97bff", t: "KT" }, kts: { c: "#a97bff", t: "KT" },
  swift: { c: "#ff7043", t: "SW" }, dart: { c: "#29b6f6", t: "DT" },
  c: { c: "#0288d1", t: "C" }, h: { c: "#0288d1", t: "H" },
  cpp: { c: "#0288d1", t: "C+" }, cc: { c: "#0288d1", t: "C+" }, hpp: { c: "#0288d1", t: "H+" },
  cs: { c: "#7b1fa2", t: "C#" }, php: { c: "#7e57c2", t: "PHP" },
  sh: { c: "#4caf50", t: ">_" }, bash: { c: "#4caf50", t: ">_" }, zsh: { c: "#4caf50", t: ">_" }, fish: { c: "#4caf50", t: ">_" },
  yml: { c: "#ff5252", t: "YM" }, yaml: { c: "#ff5252", t: "YM" }, toml: { c: "#9e9e9e", t: "TO" }, ini: { c: "#9e9e9e", t: "IN" },
  xml: { c: "#ff7043", t: "<>" }, svg: { c: "#ffb300", t: "SVG", dark: 1 },
  sql: { c: "#ff9800", t: "SQL", dark: 1 }, db: { c: "#607d8b", t: "DB" },
  env: { c: "#fdd835", t: "ENV", dark: 1 },
  png: { c: "#26a69a", t: "IMG" }, jpg: { c: "#26a69a", t: "IMG" }, jpeg: { c: "#26a69a", t: "IMG" },
  gif: { c: "#26a69a", t: "IMG" }, webp: { c: "#26a69a", t: "IMG" }, ico: { c: "#26a69a", t: "ICO" }, bmp: { c: "#26a69a", t: "IMG" },
  pdf: { c: "#f44336", t: "PDF" }, zip: { c: "#b0bec5", t: "ZIP", dark: 1 }, gz: { c: "#b0bec5", t: "GZ", dark: 1 },
  tar: { c: "#b0bec5", t: "TAR", dark: 1 }, rar: { c: "#b0bec5", t: "RAR", dark: 1 },
  txt: { c: "#90a4ae", t: "TXT" }, log: { c: "#90a4ae", t: "LOG" }, csv: { c: "#66bb6a", t: "CSV" },
  lock: { c: "#9e9e9e", t: "•" }, gradle: { c: "#02303a", t: "GR" }, dockerfile: { c: "#0288d1", t: "DK" },
};
// 전체 파일명 특수 케이스.
const NAME = {
  "package.json": { c: "#43a047", t: "N" }, "package-lock.json": { c: "#43a047", t: "N" },
  "tsconfig.json": { c: "#3178c6", t: "TS" }, "jsconfig.json": { c: "#f0db4f", t: "JS", dark: 1 },
  ".gitignore": { c: "#e64a19", t: "GIT" }, ".gitattributes": { c: "#e64a19", t: "GIT" },
  "dockerfile": { c: "#0288d1", t: "DK" }, "docker-compose.yml": { c: "#0288d1", t: "DK" }, "docker-compose.yaml": { c: "#0288d1", t: "DK" },
  ".env": { c: "#fdd835", t: "ENV", dark: 1 }, ".env.local": { c: "#fdd835", t: "ENV", dark: 1 }, ".env.dev": { c: "#fdd835", t: "ENV", dark: 1 }, ".env.prod": { c: "#fdd835", t: "ENV", dark: 1 },
  "readme.md": { c: "#42a5f5", t: "i" }, "license": { c: "#d4a017", t: "L" }, "license.md": { c: "#d4a017", t: "L" },
  "cargo.toml": { c: "#ff7043", t: "RS" }, "cargo.lock": { c: "#ff7043", t: "RS" },
  "vite.config.js": { c: "#bd34fe", t: "V" }, "vite.config.ts": { c: "#bd34fe", t: "V" },
  ".eslintrc": { c: "#4b32c3", t: "ES" }, ".eslintrc.js": { c: "#4b32c3", t: "ES" }, ".eslintrc.json": { c: "#4b32c3", t: "ES" },
  ".prettierrc": { c: "#56b3b4", t: "PR" }, "tailwind.config.js": { c: "#38bdf8", t: "TW" },
};

function metaFor(name) {
  const lower = (name || "").toLowerCase();
  if (NAME[lower]) return NAME[lower];
  const dot = lower.indexOf(".");
  // 확장자(마지막) 우선, 없으면 default.
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return EXT[ext] || { c: "#90a4ae", t: lower && dot !== 0 ? (lower[0] || "?").toUpperCase() : "•" };
}

// 파일 아이콘 — 라운드 배지 + 모노그램.
export function fileIcon(name, size = 16) {
  const m = metaFor(name);
  const fg = m.dark ? "#1a1a1a" : "#ffffff";
  const t = String(m.t || "?");
  const fs = t.length >= 3 ? 6.2 : t.length === 2 ? 8.2 : 10.5;
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="2.5" y="2" width="19" height="20" rx="4" fill="${m.c}"/>` +
    `<text x="12" y="12.6" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="-apple-system, system-ui, sans-serif" font-size="${fs}" font-weight="700" fill="${fg}" ` +
    `letter-spacing="-0.3">${escXml(t)}</text></svg>`
  );
}

// 특수 폴더 색.
const FOLDER_COLORS = {
  src: "#ef5350", app: "#ef5350",
  components: "#29b6f6", component: "#29b6f6", widgets: "#29b6f6",
  dist: "#66bb6a", build: "#66bb6a", out: "#66bb6a", target: "#66bb6a",
  node_modules: "#8d6e63",
  public: "#ffa726", static: "#ffa726", assets: "#ffa726", asset: "#ffa726",
  images: "#26a69a", img: "#26a69a", icons: "#26a69a",
  test: "#26a69a", tests: "#26a69a", __tests__: "#26a69a", spec: "#26a69a",
  ".git": "#e64a19", ".github": "#78909c", ".vscode": "#78909c",
  config: "#78909c", configs: "#78909c", settings: "#78909c",
  docs: "#42a5f5", doc: "#42a5f5",
  hooks: "#ec407a", store: "#ec407a", stores: "#ec407a", redux: "#ec407a",
  utils: "#7e57c2", util: "#7e57c2", lib: "#7e57c2", libs: "#7e57c2", helpers: "#7e57c2",
  api: "#26c6da", server: "#26c6da", services: "#26c6da", service: "#26c6da",
  styles: "#ab47bc", css: "#ab47bc", scss: "#ab47bc",
  routes: "#5c6bc0", router: "#5c6bc0", pages: "#5c6bc0",
  models: "#8bc34a", model: "#8bc34a", schema: "#8bc34a",
  controllers: "#ffca28", controller: "#ffca28",
  middlewares: "#26a69a", middleware: "#26a69a",
};
function folderColor(name) {
  return FOLDER_COLORS[(name || "").toLowerCase()] || "#90a4ae";
}

// 폴더 아이콘(닫힘/열림) — 채운 Material 스타일. name 으로 특수폴더 색 지정.
export function folderIcon(open, size = 16, name) {
  const c = folderColor(name);
  if (open) {
    return (
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<path fill="${c}" opacity="0.45" d="M3 6.2c0-.8.6-1.4 1.4-1.4H9l2 2h7.6c.8 0 1.4.6 1.4 1.4V11H8.2a2 2 0 0 0-1.9 1.4L3.6 20H3z"/>` +
      `<path fill="${c}" d="M6.4 11.4A1.6 1.6 0 0 1 7.9 10.3H21.4l-2.3 7.2A1.6 1.6 0 0 1 17.6 18.7H3.4z"/></svg>`
    );
  }
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<path fill="${c}" d="M3 6.4c0-.8.6-1.4 1.4-1.4H9l2 2h8.6c.8 0 1.4.6 1.4 1.4v9.8c0 .8-.6 1.4-1.4 1.4H4.4C3.6 19.6 3 19 3 18.2z"/></svg>`
  );
}

function escXml(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
