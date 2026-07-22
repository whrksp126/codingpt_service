// preview-history.js — 프리뷰 주소창 방문 기록 + 검색어 추천(크롬식 드롭다운의 데이터 계층).
//
//  기록 정본 = 워크스페이스 "호스트 PC" 의 ~/.codingpt/preview-history/u<계정id>--<ws슬러그>.json
//   · 백엔드 DB 무사용 — 모든 기기가 어차피 그 워크스페이스의 호스트 데몬에 붙으므로,
//     기존 fs.read/fs.write 릴레이(remote-fs)만으로 전 기기가 같은 기록을 공유한다.
//   · 파일명이 계정 id 로 키잉 → 계정 전환 시 이전 계정 기록이 보이지 않는다.
//   · 이 PC 가 호스트면 Rust fsapi 직접(오프라인/지연 무관), 원격 워크스페이스면 back fs 릴레이.
//  검색어 추천 = Google Suggest(공개 자동완성 엔드포인트, Rust ureq 경유 — CORS 무관).
import { api } from "./api.js";
import { state } from "./state.js";
import { makeRemoteFs } from "./remote-fs.js";

const CAP = 300; // 워크스페이스당 보관 상한(마지막 방문 오래된 것부터 소거)
const CACHE_TTL = 15000; // 타이핑 중 재읽기 억제(기록 파일은 방문 시에만 변함)
const cache = new Map(); // file → { at, entries }

const slugOf = (p) => String(p || "").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "") || "root";
function fileOf(ctx) {
  const uid = state.me?.id ?? "anon";
  return `.codingpt/preview-history/u${uid}--${slugOf(ctx?.localPath)}.json`;
}
function fsOf(ctx) {
  if (!ctx || ctx.isLocal !== false || ctx.hostDeviceId == null) {
    return { read: api.fsRead, write: api.fsWrite, mkdir: api.fsMkdir };
  }
  const r = makeRemoteFs(ctx.hostDeviceId);
  return { read: r.fsRead, write: r.fsWrite, mkdir: r.fsMkdir };
}

async function load(ctx) {
  const file = fileOf(ctx);
  const c = cache.get(file);
  if (c && Date.now() - c.at < CACHE_TTL) return c.entries;
  let entries = [];
  try {
    const j = JSON.parse(String((await fsOf(ctx).read(file)) || "{}"));
    if (Array.isArray(j.entries)) entries = j.entries;
  } catch (_) { /* 파일 없음 = 첫 사용 */ }
  cache.set(file, { at: Date.now(), entries });
  return entries;
}

async function save(ctx, entries) {
  const file = fileOf(ctx);
  cache.set(file, { at: Date.now(), entries });
  const io = fsOf(ctx);
  const body = JSON.stringify({ v: 1, entries });
  try {
    await io.write(file, body);
  } catch (_) {
    // 디렉토리 미존재(첫 사용) — 만들고 재시도. "이미 존재" 류 실패는 무시.
    try { await io.mkdir(".codingpt/preview-history"); } catch (_) { /* noop */ }
    try { await io.write(file, body); } catch (_) { /* noop */ }
  }
}

// 방문 기록 — 페이지 로드 성공 시(제목/파비콘 확보 시점) 호출. url 별 방문수·최근시각 upsert.
export async function recordVisit(ctx, { url, title, favicon }) {
  try {
    const u = String(url || "");
    if (!/^https?:\/\//i.test(u)) return;
    if (/^https?:\/\/(www\.)?google\.[^/]+\/search/i.test(u)) return; // 검색결과 페이지는 소음
    const entries = (await load(ctx)).slice();
    const i = entries.findIndex((e) => e && e.u === u);
    const prev = i >= 0 ? entries.splice(i, 1)[0] : null;
    entries.unshift({
      u,
      t: title || (prev && prev.t) || "",
      f: favicon || (prev && prev.f) || "",
      n: ((prev && prev.n) || 0) + 1,
      ts: Date.now(),
    });
    await save(ctx, entries.slice(0, CAP));
  } catch (_) { /* 기록 실패는 조용히(기능 부가물) */ }
}

// 기록 매칭 — 호스트 접두 일치 > url/제목 포함, 동점이면 방문수·최근성. q 없으면 최근 방문 순.
export async function queryHistory(ctx, q, limit = 5) {
  try {
    const entries = await load(ctx);
    const s = String(q || "").trim().toLowerCase();
    const scored = [];
    for (const e of entries) {
      if (!e || !e.u) continue;
      let score = 1;
      if (s) {
        const url = e.u.toLowerCase();
        const host = url.replace(/^https?:\/\/(www\.)?/, "");
        if (host.startsWith(s)) score = 3;
        else if (url.includes(s) || (e.t || "").toLowerCase().includes(s)) score = 2;
        else continue;
      }
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.e.n || 0) - (a.e.n || 0) || (b.e.ts || 0) - (a.e.ts || 0));
    return scored.slice(0, limit).map((x) => x.e);
  } catch (_) { return []; }
}

// Google Suggest — 입력어 기반 검색어 추천(무키·무료 공개 엔드포인트).
export async function googleSuggest(q, limit = 5) {
  const s = String(q || "").trim();
  if (!s || /^https?:\/\//i.test(s)) return [];
  try {
    const arr = await api.previewSuggest(s);
    return (Array.isArray(arr) ? arr : []).filter((t) => t && t !== s).slice(0, limit);
  } catch (_) { return []; }
}
