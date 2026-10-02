// fileicons.js — VS Code **Material Icon Theme**(MIT, PKief/material-extensions) 실제 SVG.
//  예전엔 색 배지+모노그램으로 "근사"했다(2026-10 사용자: "마음에 안 든다, vscode 의 그것으로").
//  데이터 = fileicons-data.js(자주 쓰는 확장자·파일명·폴더명에 걸리는 아이콘만 추린 부분집합, 생성물).
//  앱(codingpt_app src/workspace/fileIconsData.ts)과 같은 데이터·같은 판정 — 한쪽만 고치지 말 것.
import D from "./fileicons-data.js";

function sized(id, size) {
  const svg = D.svgs[id] || D.svgs[D.file];
  return svg.replace("<svg", `<svg width="${size}" height="${size}" class="mi"`);
}

/** 파일 이름 → 아이콘 id. 파일명 > 겹확장자(d.ts·spec.ts) > 확장자 > 기본. */
export function fileIconId(name) {
  const n = String(name || "").split("/").pop().toLowerCase();
  if (D.names[n]) return D.names[n];
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) {
    const e = parts.slice(i).join(".");
    if (D.ext[e]) return D.ext[e];
  }
  return D.file;
}

export function fileIcon(name, size = 16) { return sized(fileIconId(name), size); }

export function folderIcon(open, size = 16, name) {
  const n = String(name || "").split("/").pop().toLowerCase();
  const id = (open ? D.foldersOpen[n] : D.folders[n]) || (open ? D.folderOpen : D.folder);
  return sized(id, size);
}
