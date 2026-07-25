// remote-fs.js — 다른 PC 워크스페이스의 파일 접근(back fs 릴레이, hostDeviceId 지정).
//  로컬 fsapi(api.fs*)와 동일한 시그니처/모양을 돌려주는 어댑터라 IdeView 가 전송 계층만 갈아끼운다.
//  경로 규약은 양쪽 다 "그 호스트 홈-상대"라 1:1 — 데몬 fs jail(safeResolve)이 서버측에서 강제.
import { api } from "./api.js";
import { sealedRpc } from "./e2ee.js";
import lan from "./lan.js";

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
  // 종단간 암호화(기능2): 봉투 RPC 가 가능하면 그쪽을 먼저 쓴다(서버가 경로·내용을 못 본다).
  //  null 반환 = 미지원/정책 off → 아래 평문 REST 로 폴백(무마찰). 진짜 실패는 throw 되어 그대로 올라간다.
  const sealed = (method, params, timeoutMs) => sealedRpc(method, { ...params }, hid, timeoutMs);
  // LAN 직결(기능4): 같은 Wi-Fi 면 서버를 아예 안 지난다 → 봉인보다 **먼저** 시도한다(지연·프라이버시 동시 우위).
  //  null = 직결 미사용(조용히 아래 경로로). 데몬의 진짜 실패는 throw 되어 그대로 올라간다.
  //  ★ fs.watch 는 여기에 없다 — 데몬 watcher 가 프로세스 전역 단일이라 LAN watch 가 릴레이 watch 를
  //    죽여 IDE 라이브 동기화가 조용히 깨진다(설계 §5.6). 파일 감시는 계속 릴레이가 담당한다.
  const direct = (method, params) => lan.lanRpc(hid, method, { ...params });
  return {
    remote: true,
    hostDeviceId: hid,
    async fsTree(rel) {
      const e = (await direct("fs.tree", { path: rel || "" })) || await sealed("fs.tree", { path: rel || "" });
      const r = e || await api.backApi("GET", `/api/daemon/fs/tree?${q(rel)}`);
      return nestTree(rel || "", r?.items);
    },
    async fsSearch(rel, query) {
      const e = (await direct("fs.grep", { path: rel || "", query: query || "" })) || await sealed("fs.grep", { path: rel || "", query: query || "" }, 20000);
      const r = e || await api.backApi("GET", `/api/daemon/fs/grep?${q(rel)}&q=${enc(query || "")}`);
      const base = (rel || "").replace(/\/+$/, "");
      return (r?.matches || []).map((m) => ({
        path: base ? `${base}/${m.path}` : m.path,
        name: String(m.path || "").split("/").pop(),
        line: m.line,
        text: m.text,
      }));
    },
    async fsRead(rel) {
      const e = (await direct("fs.read", { path: rel || "" })) || await sealed("fs.read", { path: rel || "" });
      const r = e || await api.backApi("GET", `/api/daemon/fs/read?${q(rel)}`);
      if (r?.binary) throw "바이너리 파일은 열 수 없습니다.";
      if (r?.tooLarge) throw "파일이 너무 큽니다(2MB 초과).";
      return r?.content ?? "";
    },
    // 변형 계열도 같은 규율(봉투 우선 → 미지원이면 평문). 반환값은 쓰지 않으므로 then(()=>{}) 유지.
    async fsWrite(rel, content) { if (!(await direct("fs.write", { path: rel, content })) && !(await sealed("fs.write", { path: rel, content }))) await post("write", { path: rel, content }); },
    async fsMkdir(rel) { if (!(await sealed("fs.mkdir", { path: rel }))) await post("mkdir", { path: rel }); },
    async fsCreateFile(rel) { if (!(await sealed("fs.createFile", { path: rel }))) await post("create", { path: rel }); },
    async fsRename(rel, dest) { if (!(await sealed("fs.rename", { path: rel, dest }))) await post("rename", { path: rel, dest }); },
    async fsDelete(rel) { if (!(await sealed("fs.delete", { path: rel }))) await post("delete", { path: rel }); },
  };
}
