/**
 * 원격 승인 인박스(기능1) — back 측 **인덱스**.
 *
 * 흐름: claude PermissionRequest 훅 → cpt.sock → 데몬 → (REST) 이 서비스 → 알림 행 + approval_event
 *       팬아웃 + FCM → 사용자가 어느 기기에서 응답 → control WS rpc(approval.resolve) → 데몬이 훅 재개.
 *
 * ★ 정본은 데몬이다. 이 서비스의 pending Map 은 "지금 대기 중인 승인" 인덱스/캐시일 뿐이며,
 *   back 재시작으로 전량 소실돼도 데몬이 control WS 재접속 시 같은 id 로 재등록(resync)하면 복구된다.
 *   따라서 여기서는 DB 테이블을 만들지 않는다(MVP — 마이그레이션 0, 설계 §7-E1).
 *
 * 안전 원칙(위반 시 사용자 작업이 멈춘다):
 *  · 이 서비스가 실패해도 claude 는 절대 자동 허용되지 않는다 — 훅은 무응답 시 defer(TUI 폴백)다.
 *  · 이중 응답 금지: claimedBy CAS(단일 이벤트 루프 원자) + 데몬 pending.delete 2단 방어.
 *  · 대기 중 승인의 알림 행은 prune(유저당 500건)에서 보호한다(notificationService.pruneOld).
 */
const { Notification } = require('../models');
const notificationService = require('./notificationService');
const pushService = require('./pushService');

function relay() { return require('./daemonRelayService'); } // lazy — 순환 require 회피

// ── 설정(env) ─────────────────────────────────────────────────────────
const TTL_MS = intEnv('APPROVAL_TTL_MS', 600 * 1000);              // back pending 백스톱 TTL(데몬 마감 560s 뒤)
const MAX_PENDING_PER_USER = intEnv('APPROVAL_MAX_PENDING_PER_USER', 20); // 폭주 가드
// 무응답 시 폰 에스컬레이션 지연. 데몬 하드 타임아웃(기본 180s) 안에서 "폰이 알림을 받은 뒤 남는 시간"이
//  충분해야 한다 — 60s 로 두면 잠금화면 확인→앱 진입→선택에 남는 시간이 촉박했다(120s 예산 기준 절반).
//  25s = "PC 앞에서 잠깐 딴 일 하는 중"과 "자리에 없다"를 가르는 현실적 경계.
const ESCALATE_MS = intEnv('APPROVAL_ESCALATE_MS', 25 * 1000);
// 승인 푸시가 present 라우팅(PC 포커스 → 폰 무음)을 어떻게 대할지.
//  · escalate(기본) — 처음엔 기존 게이트를 그대로 지키고, ESCALATE_MS 무응답이면 같은 태그로 폰에 1회 재발송
//  · present        — 기존 게이트 완전 준수(에스컬레이션 없음)
//  · always         — 승인은 항상 폰 푸시(pcActive 무시)
const PUSH_POLICY = ['escalate', 'present', 'always'].includes(String(process.env.APPROVAL_PUSH_POLICY || '').trim())
  ? String(process.env.APPROVAL_PUSH_POLICY).trim() : 'escalate';
// Android 알림 채널 — 앱이 'codingpt_approval' 채널을 만들기 전에는 기본 채널을 쓴다(존재하지 않는
//  채널을 지정하면 표시가 제조사 구현에 좌우되므로, 앱 릴리스가 나간 뒤 env 로 전환한다).
const ANDROID_CHANNEL = String(process.env.APPROVAL_ANDROID_CHANNEL || 'codingpt_default');
// 서버 킬스위치 — 0/false 면 승인 요청을 만들지 않고 즉시 defer 지시(데몬은 TUI 폴백 = 기존 동작).
//  config/caps.js 가 같은 env 로 approval.v1 선언 자체도 끄므로, 신버전 데몬도 기능을 켜지 않는다.
const APPROVAL_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.APPROVAL_ENABLED || '').trim());
const RESOLVE_RPC_TIMEOUT_MS = 10 * 1000;
const SWEEP_MS = 30 * 1000;
// 응답 레이트 리밋(유저당) — 카드 연타/자동화 오용 방지. 승인은 사람이 누르는 것이라 넉넉하다.
const RESPOND_MAX_PER_MIN = 30;

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── 인메모리 인덱스 ───────────────────────────────────────────────────
// id → rec { id, userId, hostDeviceId, notifId, approval, deadlineAt, createdAt,
//            claimedBy, finalized, gated, escalatedAt, push }
const pending = new Map();
const byUser = new Map();   // userId(str) → Set<id>
const coldSwept = new Set(); // userId(str) — 부팅 후 고아 승인 알림을 1회 회수했는가
const respondRate = new Map(); // userId(str) → { windowStart, count }
// 최근 해소 기억(2분) — 늦게 누른 기기에 "누가 이겼는지"를 알려주기 위한 짧은 무덤.
//  이게 없으면 늦은 응답이 404 로만 떨어져 클라이언트가 "만료"와 "다른 기기가 먼저"를 구분할 수 없다.
const resolvedRecent = new Map(); // id → { userId, by, decision, reason, at }
const RESOLVED_MEMORY_MS = 2 * 60 * 1000;
const RESOLVED_MEMORY_MAX = 500;

// 상한/형식
const ID_RE = /^apr_[A-Za-z0-9_-]{1,64}$/;
const INPUT_PREVIEW_MAX = 4 * 1024;    // 민감정보 유출면 축소(전문은 PC 로컬 로그만)
const DIFF_SIDE_MAX = 32 * 1024;
const PROMPT_MAX = 8 * 1024;

// 에러 = { statusCode, code } + publicDetail(응답 본문 detail 로 나갈 구조화 정보).
//  클라이언트는 detail.code 로 분기한다(ALREADY_RESOLVED 면 카드 즉시 철수 등).
function err(message, statusCode, code, extra) {
  return Object.assign(new Error(message), {
    statusCode, code, publicDetail: { code, ...(extra || {}) },
  });
}
function str(v, max) { return v == null ? null : String(v).slice(0, max); }

// ── 생성 payload 정규화(순수) ─────────────────────────────────────────
// 데몬이 보낸 값만 신뢰 경계 안으로 들인다. 크기 캡은 "서버 DB/로그/푸시로 새는 양"의 상한이다.
function normalizeCreate(payload, now) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const id = typeof p.id === 'string' ? p.id.trim() : '';
  if (!ID_RE.test(id)) throw err('id 형식이 잘못되었습니다(apr_…).', 400, 'BAD_ID');
  const winRaw = p.win;
  const win = Number.isInteger(winRaw) ? winRaw
    : (typeof winRaw === 'string' && /^\d+$/.test(winRaw) ? parseInt(winRaw, 10) : null);
  // 마감: 데몬이 준 waitMs 를 존중하되 back TTL 안으로 클램프(back 이 먼저 만료시켜 유령 카드가 남지 않게).
  const waitMs = Number(p.waitMs);
  const wait = Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 5000), TTL_MS) : TTL_MS;
  const requestedAt = Number.isFinite(Number(p.requestedAt)) ? Number(p.requestedAt) : now;
  return {
    id,
    agent: str(p.agent, 32) || 'claude',
    tool: str(p.tool, 64) || 'Tool',
    summary: str(p.summary, 200) || '',
    inputPreview: capJson(p.inputPreview, INPUT_PREVIEW_MAX),
    // 선택형 도구(AskUserQuestion/ExitPlanMode)용 정규화 프롬프트 — 데몬이 채우면 클라가 그대로 그린다.
    //  부재 시 클라이언트는 inputPreview 로 폴백한다(구 데몬 호환).
    prompt: capJson(p.prompt, PROMPT_MAX),
    diff: normalizeDiff(p.diff),
    relPath: str(p.relPath, 512),
    cwd: str(p.cwd, 512),          // ★ notification.cwd 와 동일 값이어야 한다(pane 단위 읽음 계약)
    wsName: str(p.wsName, 120),
    workspaceId: str(p.workspaceId, 80),
    win,                           // ★ notification.win == 터미널 tid
    sessionId: str(p.sessionId, 120),
    toolUseId: str(p.toolUseId, 120),
    permissionMode: str(p.permissionMode, 32),
    requestedAt,
    deadlineAt: now + wait,
  };
}

// JSON 직렬화 크기로 캡. 초과 시 통째로 버리고 truncated 마커만 남긴다(부분 절단 JSON 금지).
function capJson(v, max) {
  if (v == null || typeof v !== 'object') return null;
  let s;
  try { s = JSON.stringify(v); } catch (_) { return null; }
  if (s.length > max) return { truncated: true, bytes: s.length };
  return v;
}

function normalizeDiff(d) {
  if (!d || typeof d !== 'object') return null;
  const out = { kind: str(d.kind, 16) || 'write' };
  for (const k of ['oldContent', 'newContent']) {
    if (typeof d[k] !== 'string') continue;
    out[k] = d[k].length > DIFF_SIDE_MAX ? d[k].slice(0, DIFF_SIDE_MAX) : d[k];
    if (d[k].length > DIFF_SIDE_MAX) out.truncated = true;
  }
  return out;
}

// ── 응답 payload 검증(순수) ───────────────────────────────────────────
// decision:
//  · allow / deny — 진짜 권한 요청(Bash/Write…). 훅이 behavior 를 그대로 낸다.
//  · answer       — 선택형 도구(AskUserQuestion/ExitPlanMode). 데몬이 deny+message 로 번역해
//                   claude 에 전달한다(실측 계약). 클라이언트는 훅 내부 규약을 몰라도 된다.
function normalizeDecision(body) {
  const b = body && typeof body === 'object' ? body : {};
  const decision = String(b.decision || '').trim();
  if (!['allow', 'deny', 'answer'].includes(decision)) {
    throw err("decision 은 'allow'|'deny'|'answer' 여야 합니다.", 400, 'BAD_DECISION');
  }
  const out = { decision, message: str(b.message, 500), always: !!b.always };
  if (decision === 'answer') {
    const a = b.answer && typeof b.answer === 'object' ? b.answer : null;
    const labels = a && Array.isArray(a.labels)
      ? a.labels.filter((x) => typeof x === 'string').slice(0, 8).map((x) => x.slice(0, 200)) : [];
    const text = a ? str(a.text, 2000) : null;
    if (!labels.length && !text) throw err('answer.labels 또는 answer.text 가 필요합니다.', 400, 'BAD_ANSWER');
    out.answer = {
      questionIndex: a && Number.isInteger(a.questionIndex) ? a.questionIndex : 0,
      labels, text,
    };
  }
  return out;
}

// ── 유저별 인덱스 보조 ────────────────────────────────────────────────
function idsOf(userId) {
  const s = byUser.get(String(userId));
  return s ? [...s] : [];
}
function register(rec) {
  pending.set(rec.id, rec);
  const key = String(rec.userId);
  let s = byUser.get(key);
  if (!s) { s = new Set(); byUser.set(key, s); }
  s.add(rec.id);
}
function unregister(rec) {
  pending.delete(rec.id);
  const key = String(rec.userId);
  const s = byUser.get(key);
  if (s) { s.delete(rec.id); if (!s.size) byUser.delete(key); }
}

// prune 보호 대상 — 대기 중 승인의 알림 행 id(해소되면 즉시 보호 해제).
function protectedNotifIds(userId) {
  const out = [];
  for (const id of idsOf(userId)) {
    const rec = pending.get(id);
    if (rec && rec.notifId) out.push(rec.notifId);
  }
  return out;
}

// ── 팬아웃 ────────────────────────────────────────────────────────────
function fanout(userId, event) {
  try { relay().fanoutApprovalEvent(userId, event); } catch (_) { /* 팬아웃 실패는 승인 자체를 막지 않는다 */ }
}

// 푸시 표시/액션 힌트 — Android 는 혼합(notification+data), iOS 는 aps.category + data 액션 식별자.
function buildPush(rec) {
  const a = rec.approval;
  return {
    channelId: ANDROID_CHANNEL,
    category: 'CPT_APPROVAL',
    data: {
      approvalId: a.id,
      deadlineAt: String(a.deadlineAt),
      tool: a.tool,
      actions: 'CPT_ALLOW,CPT_DENY', // 알림 액션 버튼 식별자(2단계 네이티브에서 사용)
    },
  };
}

// 푸시 본문 — 민감정보 정책: 툴명 + 파일명/요약 1줄까지. 명령 문자열 전문은 인앱에서만 본다.
function pushBody(a) {
  const head = a.tool || 'Tool';
  const tail = a.relPath || a.summary || '';
  return tail ? `${head} · ${String(tail).slice(0, 80)}` : head;
}

// ── 생성(데몬 → back) ─────────────────────────────────────────────────
// hostDeviceId 는 반드시 실 deviceToken 의 기기(위조 방지는 컨트롤러에서 403).
async function create(userId, hostDeviceId, hostName, payload) {
  const now = Date.now();
  const a = normalizeCreate(payload, now);
  if (!APPROVAL_ENABLED) return { id: a.id, defer: true, reason: 'disabled' };

  // 멱등 재등록(데몬 resync / 재시도) — 같은 id 면 알림을 또 만들지 않고 마감만 갱신, pending 재팬아웃.
  const existing = pending.get(a.id);
  if (existing) {
    if (String(existing.userId) !== String(userId)) throw err('승인 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');
    existing.approval.deadlineAt = a.deadlineAt;
    existing.deadlineAt = a.deadlineAt;
    fanout(userId, { kind: 'pending', approval: existing.approval, alertClientKey: existing.alertClientKey || null });
    return { id: existing.id, deadlineAt: existing.deadlineAt, notifId: existing.notifId, idempotent: true, defer: false };
  }

  // 폭주 가드 — 초과분은 에러가 아니라 "defer 지시"(데몬이 TUI 로 넘긴다).
  if (idsOf(userId).length >= MAX_PENDING_PER_USER) {
    console.log(`[approval] pending 상한 초과 user=${userId} max=${MAX_PENDING_PER_USER} → defer`);
    return { id: a.id, defer: true, reason: 'too_many_pending' };
  }

  // 부팅 후 첫 승인 — 이전 프로세스가 들고 있던(=이제 아무도 회수할 수 없는) 미읽음 승인 알림을 회수한다.
  //  back 재시작 시 데몬이 같은 승인을 새 알림 행으로 재등록하므로, 옛 행을 그대로 두면 폰에 유령 배너가 남는다.
  await retractOrphanApprovals(userId).catch(() => { /* best-effort */ });

  // present 기기 판정을 알림 생성과 동일한 규칙으로 미리 계산(에스컬레이션 필요 여부 + alertClientKey).
  let present = null;
  try { present = relay().presentClient(userId); } catch (_) { /* noop */ }
  const route = notificationService._computeRoute(present);
  const gated = route.suppressAll || route.pcActive;

  const rec = {
    id: a.id, userId: Number(userId), hostDeviceId: hostDeviceId != null ? Number(hostDeviceId) : null,
    notifId: null, approval: null, deadlineAt: a.deadlineAt, createdAt: now,
    claimedBy: null, finalized: false, gated, escalatedAt: 0, push: null,
    alertClientKey: present ? present.clientKey : null,
  };
  rec.approval = {
    ...a,
    hostDeviceId: rec.hostDeviceId,
    hostName: str(hostName, 128) || '',
    notifId: null,
  };

  // 알림 행 — 기존 인박스/크로스기기 dismiss 배관을 그대로 타기 위해 반드시 만든다(kind='approval_request').
  const title = a.agent === 'claude' ? '승인 필요 — Claude Code' : `승인 필요 — ${a.agent}`;
  const push = buildPush(rec);
  rec.push = push;
  let notification = null;
  try {
    notification = await notificationService.createNotification(Number(userId), {
      source: 'hook',
      kind: 'approval_request',
      title,
      body: pushBody(a),
      workspaceId: a.workspaceId,
      wsName: a.wsName,
      cwd: a.cwd,
      win: a.win,
      sessionId: a.sessionId,
      // 비영속 오버라이드(DB 컬럼 무추가) — 딥링크는 승인 카드로 직행, push 는 액션/채널 힌트.
      deeplink: buildDeeplink(a),
      push,
      pushGate: PUSH_POLICY === 'always' ? 'ignore-pc-active' : 'default',
    });
  } catch (e) {
    // 알림 실패가 승인 왕복을 막아선 안 된다(WS 카드만으로도 응답 가능).
    console.warn('[approval] 알림 생성 실패:', e && e.message);
  }
  rec.notifId = notification ? notification.id : null;
  rec.approval.notifId = rec.notifId;

  register(rec);
  fanout(userId, { kind: 'pending', approval: rec.approval, alertClientKey: rec.alertClientKey });

  // 응답 가능한 화면 수(caps 교집합) — 데몬이 "요청을 만들어도 되는가/통보만 할까"를 판단하는 근거.
  const responders = countResponders(userId);
  console.log(`[approval] 생성 user=${userId} id=${a.id} tool=${a.tool} host=#${rec.hostDeviceId} notif=${rec.notifId} responders=${responders} gated=${gated} policy=${PUSH_POLICY}`);
  return { id: rec.id, deadlineAt: rec.deadlineAt, notifId: rec.notifId, responders, defer: false };
}

// 딥링크 — 앱이 배너 탭 시 승인 카드로 직행(codingpt://approval/<id>?ws=&cwd=&win=).
function buildDeeplink(a) {
  const q = new URLSearchParams();
  if (a.workspaceId) q.set('ws', a.workspaceId);
  if (a.cwd) q.set('cwd', a.cwd);
  if (a.win != null) q.set('win', String(a.win));
  const qs = q.toString();
  return `codingpt://approval/${a.id}${qs ? '?' + qs : ''}`;
}

// 승인 카드를 그릴 수 있다고 신고한(caps approval.v1) 접속 화면 수. 구 클라이언트는 caps 가 없어 0.
function countResponders(userId) {
  try {
    return relay().listUiClients(userId).filter((c) => (c.caps || []).includes('approval.v1')).length;
  } catch (_) { return 0; }
}

// 부팅 후 1회 — 인덱스가 모르는 미읽음 승인 알림(=이전 프로세스의 고아)을 읽음 처리해 배너까지 회수.
async function retractOrphanApprovals(userId) {
  const key = String(userId);
  if (coldSwept.has(key)) return;
  coldSwept.add(key);
  const keep = protectedNotifIds(userId);
  const rows = await Notification.findAll({
    where: { user_id: Number(userId), kind: 'approval_request', read_at: null }, attributes: ['id'],
  });
  const ids = rows.map((r) => Number(r.id)).filter((id) => !keep.includes(id));
  if (!ids.length) return;
  console.log(`[approval] 고아 승인 알림 회수 user=${userId} ids=${ids.join(',')}`);
  await notificationService.markRead(Number(userId), { ids });
}

// ── 응답(클라이언트 → back → 데몬) ───────────────────────────────────
async function respond(userId, id, body, by) {
  if (!allowRespond(userId, Date.now())) {
    throw err('응답이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', 429, 'RATE_LIMITED');
  }
  const d = normalizeDecision(body);
  const rec = pending.get(String(id));
  if (!rec || String(rec.userId) !== String(userId)) {
    // 방금 해소된 것이면 "다른 기기/터미널이 먼저 답했다"를 명시해 카드를 즉시 철수하게 한다.
    const gone = resolvedRecent.get(String(id));
    if (gone && String(gone.userId) === String(userId)) {
      throw err('이미 응답이 처리되었습니다.', 409, 'ALREADY_RESOLVED',
        { resolvedBy: gone.by, decision: gone.decision, reason: gone.reason });
    }
    throw err('승인 요청이 이미 종료되었습니다.', 404, 'NOT_FOUND');
  }
  if (Date.now() >= rec.deadlineAt) throw err('승인 요청이 만료되었습니다.', 410, 'EXPIRED');
  // ★ 단일 응답 CAS — get 과 set 사이에 await 가 없으므로 단일 이벤트 루프에서 원자적이다.
  //   두 번째 요청은 여기서 즉시 409 로 떨어진다(데몬까지 가지 않는다).
  if (rec.claimedBy) {
    throw err('다른 기기에서 이미 응답했습니다.', 409, 'ALREADY_RESOLVED',
      { resolvedBy: rec.claimedBy, decision: rec.claimedDecision || null });
  }
  rec.claimedBy = by;
  rec.claimedDecision = d.decision;

  try {
    // ★ runnerId 필수 — 미지정이면 활성 러너로 가서 멀티 PC 에서 오배달된다.
    await relay().callRpc(userId, 'approval.resolve', {
      id: rec.id,
      decision: d.decision,
      message: d.message,
      answer: d.answer || null,
      always: d.always,
      by,
    }, RESOLVE_RPC_TIMEOUT_MS, rec.hostDeviceId != null ? { runnerId: rec.hostDeviceId } : undefined);
  } catch (e) {
    const m = (e && e.message) || '';
    // code 가 정본(데몬이 rpc_result.code 로 전파). 문구 정규식은 구버전 데몬 폴백으로만 남긴다 —
    //  한글 메시지에 의존하면 문구가 바뀌는 순간 409 가 조용히 502 로 떨어지고 카드가 안 걷힌다.
    if ((e && e.code === 'ALREADY_RESOLVED') || /ALREADY_RESOLVED|NOT_PENDING/i.test(m)) {
      // 데몬이 정본 — 이미 로컬(TUI)에서 답했거나 훅이 사라졌다. 카드는 전 기기에서 회수한다.
      finalize(rec, { decision: 'canceled', reason: 'resolved_elsewhere', by: null });
      throw err('이미 PC 터미널에서 응답되었습니다.', 409, 'ALREADY_RESOLVED');
    }
    // 실패 → 클레임 롤백(다른 기기/재시도가 다시 답할 수 있어야 한다).
    rec.claimedBy = null;
    rec.claimedDecision = null;
    if (m === 'DAEMON_OFFLINE') throw err('PC 데몬이 연결되어 있지 않습니다.', 409, 'HOST_OFFLINE');
    throw err('PC 에 응답을 전달하지 못했습니다: ' + m, 502, 'RELAY_FAILED');
  }

  finalize(rec, { decision: d.decision, reason: null, by });
  return { id: rec.id, decision: d.decision, by };
}

// ── 취소(데몬 → back) ─────────────────────────────────────────────────
// reason: timeout | hook_gone | session_gone | terminal_answer
async function cancel(userId, id, reason) {
  const rec = pending.get(String(id));
  if (!rec || String(rec.userId) !== String(userId)) {
    // 멱등 — 데몬 마감과 사용자 응답이 겹치면 cancel 이 뒤늦게 도착한다. 에러로 만들면 데몬 로그만 시끄럽다.
    const gone = resolvedRecent.get(String(id));
    if (gone && String(gone.userId) === String(userId)) return { id: String(id), canceled: false, already: true };
    throw err('승인 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');
  }
  const r = str(reason, 32) || 'canceled';
  finalize(rec, { decision: r === 'timeout' ? 'defer' : 'canceled', reason: r, by: null });
  return { id: rec.id, canceled: true };
}

// 해소 공통 — 인덱스 제거 → resolved 팬아웃 → 알림 읽음(=크로스기기 dismiss 푸시 재사용).
function finalize(rec, { decision, reason, by }) {
  if (rec.finalized) return;
  rec.finalized = true;
  unregister(rec);
  const at = Date.now();
  if (resolvedRecent.size > RESOLVED_MEMORY_MAX) resolvedRecent.clear(); // 무한 성장 방지
  resolvedRecent.set(rec.id, { userId: rec.userId, by: by || null, decision, reason: reason || null, at });
  fanout(rec.userId, {
    kind: 'resolved', id: rec.id, decision, reason: reason || null, by: by || null,
    notifId: rec.notifId, at,
  });
  if (rec.notifId) {
    // markRead 가 read 팬아웃 + dismiss 데이터푸시를 함께 처리한다(기존 배관 재사용 — 새 푸시 경로 없음).
    notificationService.markRead(rec.userId, { ids: [rec.notifId] })
      .catch((e) => console.warn('[approval] markRead 실패:', e && e.message));
  }
  console.log(`[approval] 해소 user=${rec.userId} id=${rec.id} decision=${decision} reason=${reason || '-'} by=${by ? (by.deviceName || by.kind) : '-'} waitedMs=${at - rec.createdAt}`);
}

// ── 목록(클라이언트 캐치업 — 딥링크 콜드스타트/앱 복귀) ──────────────
function list(userId) {
  const now = Date.now();
  const approvals = idsOf(userId)
    .map((id) => pending.get(id))
    .filter((rec) => rec && !rec.finalized && rec.deadlineAt > now)
    .map((rec) => ({ ...rec.approval, claimed: !!rec.claimedBy }))
    .sort((x, y) => x.requestedAt - y.requestedAt);
  return { approvals };
}

// ── 레이트 리밋(순수 판정) ────────────────────────────────────────────
function allowRespond(userId, now) {
  const key = String(userId);
  let r = respondRate.get(key);
  if (!r || now - r.windowStart >= 60 * 1000) { r = { windowStart: now, count: 0 }; respondRate.set(key, r); }
  r.count += 1;
  return r.count <= RESPOND_MAX_PER_MIN;
}

// ── 스위퍼(30s) — 만료 정리 + 폰 에스컬레이션 ─────────────────────────
function sweep(now = Date.now()) {
  for (const rec of [...pending.values()]) {
    if (now >= rec.deadlineAt) {
      // 데몬 마감(560s)이 먼저 터져 cancel 이 오는 것이 정상 경로. 여기 걸리는 건 데몬/네트워크 이상.
      finalize(rec, { decision: 'defer', reason: 'expired', by: null });
      continue;
    }
    if (PUSH_POLICY !== 'escalate' || !rec.gated || rec.escalatedAt || rec.claimedBy) continue;
    if (now - rec.createdAt < ESCALATE_MS) continue;
    rec.escalatedAt = now;
    escalate(rec);
  }
  for (const [key, r] of respondRate) { if (now - r.windowStart >= 60 * 1000) respondRate.delete(key); }
  for (const [key, r] of resolvedRecent) { if (now - r.at >= RESOLVED_MEMORY_MS) resolvedRecent.delete(key); }
}

// 무응답 에스컬레이션 — 같은 notifId 태그(cptnotif-<id>)로 재발송하므로 배너가 중복되지 않고 교체된다.
//  pcActive:false 로 보내 "PC 사용 중 폰 무음" 토글을 이 1회만 우회한다(기존 3케이스 로직 무변경).
function escalate(rec) {
  const a = rec.approval;
  const push = rec.push || buildPush(rec); // 방어 — 스위퍼 루프가 여기서 죽으면 나머지 승인이 방치된다
  rec.push = push;
  console.log(`[approval] 폰 에스컬레이션 user=${rec.userId} id=${rec.id} afterMs=${Date.now() - rec.createdAt}`);
  pushService.sendToUser(rec.userId, {
    kind: 'approval_request',
    sessionId: a.sessionId || '',
    workspaceId: a.workspaceId || undefined,
    notifId: rec.notifId,
    title: a.wsName ? `승인 대기 중 — 「${a.wsName}」` : '승인 대기 중',
    body: pushBody(a),
    deeplink: buildDeeplink(a),
    channelId: push.channelId,
    category: push.category,
    data: push.data,
  }, { pcActive: false }).catch(() => { /* fire-and-forget */ });
}

const _sweeper = setInterval(() => { try { sweep(); } catch (e) { console.warn('[approval] 스위퍼 오류:', e && e.message); } }, SWEEP_MS);
if (_sweeper.unref) _sweeper.unref(); // 테스트/종료를 붙잡지 않는다

module.exports = {
  create, respond, cancel, list, protectedNotifIds,
  // 테스트 노출(순수 함수) — 데몬 리포 `_states` 컨벤션 미러.
  _normalizeCreate: normalizeCreate,
  _normalizeDecision: normalizeDecision,
  _buildPush: buildPush,
  _buildDeeplink: buildDeeplink,
  _pushBody: pushBody,
  _allowRespond: allowRespond,
  _sweep: sweep,
  _pending: pending,
  _byUser: byUser,
  _resolvedRecent: resolvedRecent,
  _config: { TTL_MS, MAX_PENDING_PER_USER, ESCALATE_MS, PUSH_POLICY, ANDROID_CHANNEL, RESPOND_MAX_PER_MIN },
};
