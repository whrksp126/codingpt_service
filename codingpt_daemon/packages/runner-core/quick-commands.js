// quick-commands.js — 사용자가 저장해 둔 명령(Quick Commands)의 **저장소**.
//
// 이 모듈이 하는 일은 저장·검증·스코프 필터뿐이다. 실행(터미널 생성·에이전트 기동·입력 전송)은
//  cpt-server 가 맡는다 — 여기서 tmux 를 만지지 않는다(agent-status.js 와 같은 층 분리).
//
// 저장 위치: <stateDir>/quick-commands.json — **머신 영속**.
//  왜 계정(back)이 아닌가(2026-08-04 사용자 확정): 저장한 명령은 `npm run dev` 처럼 **그 PC 에 실제로
//  있는 것**을 부르는 문장이다. 계정에 두고 전 기기에 뿌리면, A PC 에만 있는 도구를 부르는 명령이
//  B PC 에서도 보이고 눌러도 실패한다. 폰에서 편집한 내용은 폰이 지금 붙어 있는 그 PC 에 즉시
//  반영된다(폰은 자기 저장소를 갖지 않고 이 파일을 RPC 로 읽고 쓴다).
//  agents.json 과 같은 이유로 daemon.json 이 아니다 — 로그아웃/계정 전환이 daemon.json 을 지우는데,
//  저장한 명령은 자격증명이 아니라 머신 로컬 설정이라 같이 날아가면 안 된다.
//
// 스코프: 전역(어느 워크스페이스에서나) | 프로젝트별(그 워크스페이스에서만).
//  프로젝트 키 = **cwdRel**(홈-상대 워크스페이스 경로). 저장소가 이미 PC 로컬이라 서버의 projectId
//  를 끌어올 이유가 없다 — 이 PC 안에서 경로는 그 워크스페이스의 안정된 식별자다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const runtime = require('./runtime');

const SCHEMA_VERSION = 1;

// 상한 — 목록이 UI 에서 스크롤 지옥이 되지 않을 만큼, 그러나 실사용을 막지 않을 만큼.
const MAX_ITEMS = 100;
const MAX_LABEL = 40;
const MAX_SHELL_TEXT = 2000;
const MAX_AGENT_PROMPT = 4000;

const KINDS = new Set(['shell', 'agent']);
const TARGETS = new Set(['new', 'current']);

function file() { return path.join(runtime.stateDir(), 'quick-commands.json'); }

function newId() { return 'qc_' + crypto.randomBytes(6).toString('hex'); }

// 제어문자 소독 — 탭과 개행만 남긴다.
//  ⚠ 이 값은 결국 **터미널로 그대로 나간다**. ESC(\x1b)가 섞이면 사용자가 저장해 둔 "명령"이
//   화면을 지우거나 커서를 옮기는 이스케이프 시퀀스가 된다. \r 도 뺀다 — send-keys 로 들어가면
//   개행과 합쳐져 의도치 않은 두 번째 실행이 된다.
const CTRL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(CTRL_RE, '').slice(0, max);
}

/**
 * 저장 가능한 모양으로 정규화. 못 쓰는 항목이면 null.
 *  ⚠ 관대하게 받되 **모르는 필드는 버린다** — 파일이 앱 버전 사이를 오가므로 오염을 남기지 않는다.
 */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = KINDS.has(raw.kind) ? raw.kind : 'shell';
  const label = str(raw.label, MAX_LABEL).trim();
  const target = TARGETS.has(raw.target) ? raw.target : 'new';
  // ws 는 홈-상대 경로다. 빈 문자열은 **홈 루트 워크스페이스**라는 뜻이라 전역(null)과 다르다 →
  //  전역은 오직 null/undefined 로만 표현한다(빈 문자열로 뭉개면 루트 명령이 전역이 돼 버린다).
  const ws = typeof raw.ws === 'string' ? raw.ws : null;
  const base = {
    id: typeof raw.id === 'string' && /^qc_[a-f0-9]{12}$/.test(raw.id) ? raw.id : newId(),
    label,
    kind,
    target,
    ws,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
  if (kind === 'agent') {
    const agent = str(raw.agent, 32).trim();
    const prompt = str(raw.prompt, MAX_AGENT_PROMPT);
    if (!agent || !prompt.trim()) return null;
    return { ...base, agent, prompt, label: label || prompt.trim().split('\n')[0].slice(0, MAX_LABEL) };
  }
  const text = str(raw.text, MAX_SHELL_TEXT);
  if (!text.trim()) return null;
  return { ...base, text, label: label || text.trim().split('\n')[0].slice(0, MAX_LABEL) };
}

function load() {
  let v = null;
  try { v = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return { version: SCHEMA_VERSION, items: [] }; }
  const items = Array.isArray(v && v.items) ? v.items : [];
  // 손상된 항목은 조용히 버린다 — 하나가 깨졌다고 나머지를 못 쓰게 만들지 않는다.
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const n = normalize(it);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    if (out.length >= MAX_ITEMS) break;
  }
  return { version: SCHEMA_VERSION, items: out };
}

function save(state) {
  try {
    fs.mkdirSync(runtime.stateDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: SCHEMA_VERSION, items: state.items }, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch (_) {
    return false; // 저장 실패는 조회를 막지 않는다(다음 저장에서 재시도)
  }
}

/**
 * 이 워크스페이스에서 보여야 할 목록 = 전역 + 그 워크스페이스 것.
 *  순서는 사용자가 만든 순서를 그대로 유지한다(정렬하지 않는다 — 자기가 놓은 자리에 있어야 한다).
 *  ws 를 안 주면 **전역만** 돌려준다(어느 워크스페이스인지 모르는 화면에서 프로젝트 명령을 섞으면
 *  눌렀을 때 엉뚱한 곳에서 도는 사고가 난다).
 */
function listFor(ws) {
  const all = load().items;
  if (typeof ws !== 'string') return all.filter((it) => it.ws == null);
  return all.filter((it) => it.ws == null || it.ws === ws);
}

/** 설정 화면용 — 스코프 무시하고 전부. */
function listAll() { return load().items; }

function get(id) { return load().items.find((it) => it.id === id) || null; }

/**
 * 추가/수정. id 가 있으면 그 자리를 유지한 채 갈아끼운다(수정했다고 목록 맨 아래로 내려가지 않게).
 * 반환: { ok, item } | { ok:false, error }
 */
function upsert(raw) {
  const state = load();
  const incomingId = raw && typeof raw.id === 'string' ? raw.id : null;
  const at = state.items.findIndex((it) => it.id === incomingId);
  const n = normalize({ ...raw, ...(at >= 0 ? { createdAt: state.items[at].createdAt } : {}), updatedAt: Date.now() });
  if (!n) return { ok: false, error: '명령 내용이 비어 있습니다' };
  if (at >= 0) {
    n.id = state.items[at].id;
    state.items[at] = n;
  } else {
    if (state.items.length >= MAX_ITEMS) return { ok: false, error: `저장한 명령은 최대 ${MAX_ITEMS}개까지입니다` };
    state.items.push(n);
  }
  if (!save(state)) return { ok: false, error: '저장하지 못했습니다' };
  return { ok: true, item: n };
}

function remove(id) {
  const state = load();
  const at = state.items.findIndex((it) => it.id === id);
  if (at < 0) return { ok: true, removed: false }; // 멱등 — 이미 없으면 성공
  state.items.splice(at, 1);
  if (!save(state)) return { ok: false, error: '저장하지 못했습니다' };
  return { ok: true, removed: true };
}

/** 순서 바꾸기(설정 화면 드래그) — id 배열을 받아 그 순서로 재배치한다. 빠진 id 는 뒤에 남긴다. */
function reorder(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: '순서 목록이 필요합니다' };
  const state = load();
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const out = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (hit) { out.push(hit); byId.delete(id); }
  }
  for (const rest of byId.values()) out.push(rest);
  state.items = out;
  if (!save(state)) return { ok: false, error: '저장하지 못했습니다' };
  return { ok: true, items: out };
}

module.exports = {
  listFor, listAll, get, upsert, remove, reorder,
  _normalize: normalize, _file: file,
  MAX_ITEMS, MAX_LABEL, MAX_SHELL_TEXT, MAX_AGENT_PROMPT,
};
