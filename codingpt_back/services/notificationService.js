/**
 * 알림 동기화 서비스 — 모바일/PC 공유 알림 인박스.
 *
 * 생성(createNotification) 한 곳에서: DB 영속화 → subtitle 조합 → 500건 상한 정리(저빈도) →
 * notif_event(new) 라이브 팬아웃 → 모바일 미접속 시 FCM. 읽음 처리(markRead/markAllRead)는
 * 처리된 ids 를 반환하고 notif_event(read) 를 팬아웃해 모든 기기의 배지를 동기화한다.
 *
 * 순환 require 주의: daemonRelayService 가 이 서비스를(agent_event → 알림 생성), 이 서비스가
 * daemonRelayService 를(팬아웃/접속 판정) 부른다 → daemonRelayService 는 함수 내부 lazy require.
 */
const { Notification, Sequelize } = require('../models');
const { Op } = Sequelize;
const pushService = require('./pushService');

const MAX_PER_USER = 500;      // 유저당 보관 상한(초과분은 오래된 것부터 삭제)
const PRUNE_EVERY = 100;       // 생성 N건마다 정리(+1% 확률 보조) — 매 생성마다 훑지 않는다(저빈도)
let createCounter = 0;

function relay() { return require('./daemonRelayService'); } // lazy — 순환 require 회피

// DB 행(snake_case) → API JSON(camelCase). BIGINT id 는 pg 가 문자열로 주므로 숫자화.
function toJson(row) {
  const r = row.get ? row.get({ plain: true }) : row;
  return {
    id: Number(r.id),
    source: r.source,
    kind: r.kind,
    title: r.title,
    subtitle: r.subtitle,
    body: r.body,
    workspaceId: r.workspace_id,
    wsName: r.ws_name,
    cwd: r.cwd,
    win: r.win,
    sessionId: r.session_id,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

// subtitle 이 비어있고 kind + wsName 이 있으면 서버가 조합(클라이언트 공통 계약).
const SUBTITLE_SUFFIX = { done: '에서 완료', permission_request: '에서 승인 대기', error: '에서 오류' };
function composeSubtitle(kind, wsName) {
  const suffix = SUBTITLE_SUFFIX[kind];
  if (!suffix || !wsName) return null;
  return `「${wsName}」${suffix}`;
}

// FCM 딥링크 — 앱이 알림 탭 시 해당 워크스페이스/터미널 탭으로 이동.
function buildDeeplink(n) {
  const params = new URLSearchParams();
  if (n.workspaceId) params.set('ws', n.workspaceId);
  if (n.cwd) params.set('cwd', n.cwd);
  if (n.win != null) params.set('win', String(n.win));
  const qs = params.toString();
  return `codingpt://notif/${n.id}${qs ? '?' + qs : ''}`;
}

// 알림 생성 — payload: { source, kind?, title, subtitle?, body?, workspaceId?, wsName?, cwd?, win?, sessionId? }
async function createNotification(userId, payload) {
  const p = payload || {};
  const source = String(p.source || '').trim().slice(0, 16);
  const title = String(p.title || '').trim().slice(0, 200);
  if (!source) throw Object.assign(new Error('source 가 필요합니다.'), { statusCode: 400 });
  if (!title) throw Object.assign(new Error('title 이 필요합니다.'), { statusCode: 400 });
  const kind = p.kind ? String(p.kind).slice(0, 32) : null;
  const wsName = p.wsName ? String(p.wsName).slice(0, 120) : null;
  let subtitle = p.subtitle ? String(p.subtitle).slice(0, 300) : null;
  if (!subtitle && kind && wsName) subtitle = composeSubtitle(kind, wsName); // 서버 조합
  const winRaw = p.win;
  const win = Number.isInteger(winRaw) ? winRaw
    : (typeof winRaw === 'string' && /^\d+$/.test(winRaw) ? parseInt(winRaw, 10) : null);

  const row = await Notification.create({
    user_id: userId,
    source,
    kind,
    title,
    subtitle,
    body: p.body != null ? String(p.body) : null,
    workspace_id: p.workspaceId ? String(p.workspaceId).slice(0, 80) : null,
    ws_name: wsName,
    cwd: p.cwd != null ? String(p.cwd) : null,
    win,
    session_id: p.sessionId ? String(p.sessionId).slice(0, 120) : null,
  });
  const notification = toJson(row);

  // 유저당 상한 정리 — 매번 하지 않고 100건마다(+1% 확률) 오래된 초과분 삭제(fire-and-forget).
  createCounter += 1;
  if (createCounter % PRUNE_EVERY === 0 || Math.random() < 0.01) {
    pruneOld(userId).catch(() => { /* noop */ });
  }

  // present 기기 = 지금 사용자가 "실제로 보고 있는" 화면 하나(PC=창 포커스, 모바일=AppState active).
  //  주의 알림(사운드/햅틱/OS배너)은 그 기기에서만 울리고, 나머지 기기는 뱃지/목록만 조용히 갱신한다.
  let present = null;
  try { present = relay().presentClient(userId); } catch (_) { /* noop */ }
  const alertClientKey = present ? present.clientKey : null;

  // 라이브 팬아웃(모든 접속 기기, 뱃지/목록 동기화) — alertClientKey 로 소리낼 기기만 표시. 실패해도 생성 성공.
  try { relay().fanoutNotifEvent(userId, { kind: 'new', notification, alertClientKey }); } catch (_) { /* noop */ }

  // 폰 FCM 푸시 라우팅 — "지금 실제로 쓰는 기기가 이미 알림을 보여주면" 만 억제(이중 알림 방지),
  //  아무 기기도 안 쓰면 폰으로 넘긴다(자리비움 안전망).
  //   · present=모바일 + 최근활성(fresh) → 활성 폰이 인앱으로 봄     → FCM 전량 억제
  //   · present=PC     + 최근활성(fresh) → 사용자가 PC 를 쓰는 중   → 폰별 토글(alert_when_pc_active)로 결정
  //   · present=PC 인데 오래 자리비움(!fresh) / present 없음        → 폰으로 푸시(PC 는 인앱 배너 유지)
  //  이전엔 "모바일 WS 접속 여부(hasActiveMobileClient)"로만 억제해, 백그라운드로 접속만 살아 있는
  //  폰이 자기 자신의 푸시를 막고 PC 는 present 판정이 느슨(가시성)해 폰을 가로채는 문제가 있었다.
  let suppressAll = false;   // 활성 폰이 이미 인앱으로 봄
  let pcActive = false;      // PC 사용 중 → sendToUser 가 기기별 토글로 스킵
  if (present && present.fresh) {
    if (present.kind === 'mobile') suppressAll = true;
    else if (present.kind === 'pc') pcActive = true;
  }
  // 라우팅 관측 로그(성공 FCM 은 provider 가 로그를 안 남기므로 결정 지점에서 남긴다).
  console.log(`[notif-route] user=${userId} present=${present ? present.kind : 'none'} fresh=${present ? present.fresh : '-'} suppressAll=${suppressAll} pcActive=${pcActive} title="${title}"`);
  if (!suppressAll) {
    pushService.sendToUser(userId, {
      kind: kind || 'notification',
      sessionId: notification.sessionId || '',
      workspaceId: notification.workspaceId || undefined,
      title,
      body: subtitle || (notification.body ? String(notification.body).slice(0, 120) : ''),
      deeplink: buildDeeplink(notification),
    }, { pcActive }).catch(() => { /* fire-and-forget */ });
  }

  return notification;
}

// 유저당 500건 초과분(오래된 것) 삭제 — 최신 500번째 id 미만을 지운다.
async function pruneOld(userId) {
  const edge = await Notification.findOne({
    where: { user_id: userId },
    order: [['id', 'DESC']],
    offset: MAX_PER_USER - 1,
    attributes: ['id'],
  });
  if (!edge) return 0;
  return Notification.destroy({ where: { user_id: userId, id: { [Op.lt]: edge.id } } });
}

// 목록(최신순) + 미읽음 카운트. beforeId 미만 id 로 커서 페이지네이션.
async function list(userId, { limit, beforeId } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const where = { user_id: userId };
  const before = Number(beforeId);
  if (Number.isFinite(before) && before > 0) where.id = { [Op.lt]: before };
  const [rows, unreadCount] = await Promise.all([
    Notification.findAll({ where, order: [['id', 'DESC']], limit: lim }),
    Notification.count({ where: { user_id: userId, read_at: null } }),
  ]);
  return { notifications: rows.map(toJson), unreadCount };
}

// 읽음 처리 — { ids:[...] } 또는 { scope:{cwd, win} }.
//  scope.win 숫자 = 그 (cwd,win) 미읽음 / scope.win === null = win IS NULL 인 ws-수준 알림만.
//  반환: 실제로 읽음 처리된 id 배열(+ notif_event(read) 팬아웃).
async function markRead(userId, { ids, scope } = {}) {
  const where = { user_id: userId, read_at: null };
  if (Array.isArray(ids) && ids.length) {
    const numIds = ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!numIds.length) return { ids: [] };
    where.id = { [Op.in]: numIds };
  } else if (scope && typeof scope === 'object' && typeof scope.cwd === 'string') {
    where.cwd = scope.cwd;
    if (scope.win === null) where.win = null; // ws-수준 알림만
    else {
      const win = Number(scope.win);
      if (!Number.isInteger(win)) throw Object.assign(new Error('scope.win 은 정수 또는 null 이어야 합니다.'), { statusCode: 400 });
      where.win = win;
    }
  } else {
    throw Object.assign(new Error('ids 또는 scope{cwd,win} 가 필요합니다.'), { statusCode: 400 });
  }
  return applyRead(userId, where);
}

// 전체 읽음 처리.
async function markAllRead(userId) {
  return applyRead(userId, { user_id: userId, read_at: null });
}

// 대상 선별 → read_at 스탬프 → 처리된 ids 반환 + notif_event(read) 팬아웃(공용).
async function applyRead(userId, where) {
  const rows = await Notification.findAll({ where, attributes: ['id'] });
  const targetIds = rows.map((r) => Number(r.id));
  if (!targetIds.length) return { ids: [] };
  await Notification.update(
    { read_at: new Date(), updated_at: new Date() },
    { where: { user_id: userId, id: { [Op.in]: targetIds } } },
  );
  try { relay().fanoutNotifEvent(userId, { kind: 'read', ids: targetIds }); } catch (_) { /* noop */ }
  return { ids: targetIds };
}

module.exports = { createNotification, list, markRead, markAllRead };
