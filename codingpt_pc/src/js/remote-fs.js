// remote-fs.js — 다른 PC 워크스페이스의 파일 접근(back fs 릴레이, hostDeviceId 지정).
//  로컬 fsapi(api.fs*)와 동일한 시그니처/모양을 돌려주는 어댑터라 IdeView 가 전송 계층만 갈아끼운다.
//  경로 규약은 양쪽 다 "그 호스트 홈-상대"라 1:1 — 데몬 fs jail(safeResolve)이 서버측에서 강제.
import { api } from "./api.js";

const enc = encodeURIComponent;

// 데몬 fs.tree 는 "파일 flat 목록"(선택 루트 기준 상대) — PC IDE 의 중첩 노드 트리로 변환.
//  flat 이 전량(상한 4000/깊이 8)이라 children 이 항상 채워짐 → IdeView 의 lazy 로드는 자연히 미발동.
function nestTree(rootRel, items) {
  const root = { children: new Map() };
  for (const it of items || []) {
    const parts = String(it.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let rel = rootRel;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      rel = rel ? `${rel}/${name}` : name;
      const isDir = i < parts.length - 1;
      let node = cur.children.get(name);
      if (!node) {
        node = { name, path: rel, dir: isDir, children: isDir ? new Map() : null };
        cur.children.set(name, node);
      }
      cur = node;
    }
  }
  const toArr = (m) => [...m.values()]
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)))
    .map((n) => ({ name: n.name, path: n.path, dir: n.dir, children: n.dir ? toArr(n.children) : null }));
  return toArr(root.children);
}

export function makeRemoteFs(hostDeviceId) {
  const hid = Number(hostDeviceId);
  const q = (rel) => `path=${enc(rel || "")}&hostDeviceId=${hid}`;
  const post = (route, body) => api.backApi("POST", `/api/daemon/fs/${route}`, { ...body, hostDeviceId: hid });
  return {
    remote: true,
    hostDeviceId: hid,
    async fsTree(rel) {
      const r = await api.backApi("GET", `/api/daemon/fs/tree?${q(rel)}`);
      return nestTree(rel || "", r?.items);
    },
    async fsSearch(rel, query) {
      const r = await api.backApi("GET", `/api/daemon/fs/grep?${q(rel)}&q=${enc(query || "")}`);
      const base = (rel || "").replace(/\/+$/, "");
      return (r?.matches || []).map((m) => ({
        path: base ? `${base}/${m.path}` : m.path,
        name: String(m.path || "").split("/").pop(),
        line: m.line,
        text: m.text,
      }));
    },
    async fsRead(rel) {
      const r = await api.backApi("GET", `/api/daemon/fs/read?${q(rel)}`);
      if (r?.binary) throw "바이너리 파일은 열 수 없습니다.";
      if (r?.tooLarge) throw "파일이 너무 큽니다(2MB 초과).";
      return r?.content ?? "";
    },
    fsWrite: (rel, content) => post("write", { path: rel, content }).then(() => {}),
    fsMkdir: (rel) => post("mkdir", { path: rel }).then(() => {}),
    fsCreateFile: (rel) => post("create", { path: rel }).then(() => {}),
    fsRename: (rel, dest) => post("rename", { path: rel, dest }).then(() => {}),
    fsDelete: (rel) => post("delete", { path: rel }).then(() => {}),
  };
}
