/**
 * 봇 웹훅 — 서비스가 보내는 원래 모양(GitHub·Linear·Sentry·Vercel)을 알아듣고 서명을 검증한다.
 *  모르는 모양은 지금까지처럼 범용 형식(normalizeInbound)으로 넘긴다.
 *  서명: 봇에 webhook_secret 이 있으면 그 서비스의 서명 헤더를 검증한다(없으면 URL 토큰만으로 받는다).
 *  돌려주는 값은 범용 형식 그대로(title·text·level·url·source·dedupeKey·fields) + provider.
 */
'use strict';
const crypto = require('crypto');

function coded(code, message, status) { return Object.assign(new Error(message), { code, statusCode: status }); }
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function hmac(alg, secret, raw, enc = 'hex') { return crypto.createHmac(alg, secret).update(raw).digest(enc); }

function detect(headers) {
  const h = (k) => headers[k] || headers[k.toLowerCase()];
  if (h('x-github-event')) return 'github';
  if (h('linear-signature') || h('linear-event') || h('linear-delivery')) return 'linear';
  if (h('sentry-hook-resource')) return 'sentry';
  if (h('x-vercel-signature')) return 'vercel';
  return null;
}

function verify(provider, headers, raw, secret) {
  if (!secret) return;
  if (!raw) throw coded('BAD_SIGNATURE', '서명을 확인할 본문이 없습니다', 401);
  let ok = false;
  if (provider === 'github') ok = safeEq(headers['x-hub-signature-256'], 'sha256=' + hmac('sha256', secret, raw));
  else if (provider === 'linear') ok = safeEq(headers['linear-signature'], hmac('sha256', secret, raw));
  else if (provider === 'sentry') ok = safeEq(headers['sentry-hook-signature'], hmac('sha256', secret, raw));
  else if (provider === 'vercel') ok = safeEq(headers['x-vercel-signature'], hmac('sha1', secret, raw));
  else ok = true;
  if (!ok) throw coded('BAD_SIGNATURE', '웹훅 서명이 맞지 않습니다', 401);
}

const s = (v) => (v == null ? '' : String(v));
const firstLines = (t, n = 30) => s(t).split('\n').slice(0, n).join('\n');

function github(ev, b) {
  const repo = (b.repository && b.repository.full_name) || '';
  const src = `github:${repo}`.slice(0, 60);
  const who = (b.sender && b.sender.login) || '';
  if (ev === 'ping') return { title: 'GitHub 웹훅 연결됨', text: s(b.zen), level: 'success', source: src };
  if (ev === 'workflow_run' && b.workflow_run) {
    const r = b.workflow_run;
    if (b.action !== 'completed') return null;
    const bad = ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion);
    return {
      title: `${bad ? 'CI 실패' : 'CI 통과'}: ${r.name} (${r.head_branch})`, level: bad ? 'error' : 'success', url: r.html_url, source: src,
      text: `${repo} · ${r.event} · ${s(r.head_commit && r.head_commit.message).split('\n')[0]}`,
      fields: { branch: r.head_branch, commit: s(r.head_sha).slice(0, 8), conclusion: r.conclusion },
      dedupeKey: `gh:ci:${repo}:${r.name}:${r.head_branch}${bad ? '' : ':ok'}`,
    };
  }
  if (ev === 'check_run' && b.check_run) {
    const c = b.check_run;
    if (b.action !== 'completed' || !['failure', 'timed_out'].includes(c.conclusion)) return null;
    return { title: `체크 실패: ${c.name}`, level: 'error', url: c.html_url, source: src, text: firstLines(c.output && (c.output.summary || c.output.text), 20), dedupeKey: `gh:check:${repo}:${c.name}:${s(c.head_sha).slice(0, 8)}` };
  }
  if (ev === 'issues' && b.issue) {
    if (!['opened', 'reopened', 'assigned', 'labeled'].includes(b.action)) return null;
    return { title: `이슈 ${b.action === 'opened' ? '열림' : b.action}: #${b.issue.number} ${b.issue.title}`, level: 'info', url: b.issue.html_url, source: src, text: firstLines(b.issue.body, 40), fields: { by: who }, dedupeKey: `gh:issue:${repo}:${b.issue.number}` };
  }
  if (ev === 'issue_comment' && b.issue && b.comment) {
    if (b.action !== 'created') return null;
    return { title: `댓글: #${b.issue.number} ${b.issue.title}`, level: 'info', url: b.comment.html_url, source: src, text: firstLines(b.comment.body, 40), fields: { by: who } };
  }
  if (ev === 'pull_request' && b.pull_request) {
    const p = b.pull_request;
    const act = b.action === 'closed' ? (p.merged ? '머지됨' : '닫힘') : ({ opened: '열림', review_requested: '리뷰 요청', ready_for_review: '리뷰 준비', reopened: '다시 열림' }[b.action]);
    if (!act) return null;
    return { title: `PR ${act}: #${p.number} ${p.title}`, level: b.action === 'closed' && p.merged ? 'success' : 'info', url: p.html_url, source: src, text: firstLines(p.body, 30), fields: { by: who, branch: p.head && p.head.ref }, dedupeKey: `gh:pr:${repo}:${p.number}:${b.action}` };
  }
  if (ev === 'pull_request_review' && b.review && b.pull_request) {
    if (b.action !== 'submitted') return null;
    return { title: `리뷰(${b.review.state}): #${b.pull_request.number} ${b.pull_request.title}`, level: b.review.state === 'changes_requested' ? 'warning' : 'info', url: b.review.html_url, source: src, text: firstLines(b.review.body, 30), fields: { by: who } };
  }
  if (ev === 'release' && b.release) {
    if (b.action !== 'published') return null;
    return { title: `릴리스: ${b.release.tag_name}`, level: 'success', url: b.release.html_url, source: src, text: firstLines(b.release.body, 30) };
  }
  if (ev === 'deployment_status' && b.deployment_status) {
    const st = b.deployment_status.state;
    if (!['failure', 'error', 'success'].includes(st)) return null;
    return { title: `배포 ${st === 'success' ? '성공' : '실패'}: ${b.deployment && b.deployment.environment}`, level: st === 'success' ? 'success' : 'error', url: b.deployment_status.target_url || b.deployment_status.log_url, source: src, dedupeKey: `gh:deploy:${repo}:${b.deployment && b.deployment.environment}` };
  }
  return { title: `GitHub ${ev}${b.action ? ` (${b.action})` : ''}`, level: 'info', source: src, url: (b.repository && b.repository.html_url) || null, text: repo };
}

function linear(b) {
  const d = b.data || {};
  const type = s(b.type); const action = s(b.action);
  if (type === 'Issue') {
    const verb = { create: '만들어짐', update: '바뀜', remove: '지워짐' }[action] || action;
    if (action === 'update' && b.updatedFrom && !('stateId' in b.updatedFrom) && !('assigneeId' in b.updatedFrom) && !('priority' in b.updatedFrom)) return null;
    const pr = Number(d.priority);
    return {
      title: `${d.identifier || 'Linear'} ${verb}: ${d.title || ''}`.trim(), level: pr === 1 ? 'critical' : pr === 2 ? 'error' : 'info',
      url: b.url || d.url, source: `linear:${(d.team && d.team.key) || ''}`.slice(0, 60), text: firstLines(d.description, 40),
      fields: { state: d.state && d.state.name, assignee: d.assignee && d.assignee.name, priority: d.priorityLabel },
      dedupeKey: d.identifier ? `linear:${d.identifier}` : null,
    };
  }
  if (type === 'Comment' && action === 'create') {
    return { title: `Linear 댓글: ${(d.issue && (d.issue.identifier + ' ' + d.issue.title)) || ''}`.trim(), level: 'info', url: b.url, source: 'linear', text: firstLines(d.body, 40) };
  }
  return { title: `Linear ${type} ${action}`.trim(), level: 'info', source: 'linear', url: b.url || null, text: s(d.title || d.name) };
}

function sentry(resource, b) {
  const d = b.data || {};
  const issue = d.issue || (d.event && { title: d.event.title, level: d.event.level, web_url: d.event.web_url, id: d.event.issue_id, culprit: d.event.culprit, project: d.event.project });
  if (resource === 'issue' || resource === 'event_alert' || resource === 'error') {
    if (!issue) return null;
    if (resource === 'issue' && !['created', 'unresolved', 'regressed'].includes(b.action)) {
      if (b.action === 'resolved') return { title: `해결됨: ${issue.title}`, level: 'success', url: issue.web_url, source: 'sentry', dedupeKey: `sentry:${issue.id}:resolved` };
      return null;
    }
    const lvl = s(issue.level).toLowerCase();
    return {
      title: s(issue.title).slice(0, 200), level: lvl === 'fatal' ? 'critical' : lvl === 'warning' ? 'warning' : 'error',
      url: issue.web_url || issue.permalink, source: `sentry:${s(issue.project && (issue.project.slug || issue.project))}`.slice(0, 60),
      text: [issue.culprit, d.event && d.event.message].filter(Boolean).join('\n'),
      fields: { count: issue.count, users: issue.userCount, action: b.action || resource },
      dedupeKey: issue.id ? `sentry:${issue.id}` : null,
    };
  }
  if (resource === 'metric_alert') {
    const a = d.metric_alert || {};
    return { title: s(d.description_title || a.title || 'Sentry 지표 경보'), level: b.action === 'resolved' ? 'success' : b.action === 'warning' ? 'warning' : 'critical', url: d.web_url, source: 'sentry', text: s(d.description_text), dedupeKey: `sentry:metric:${a.id || ''}:${b.action}` };
  }
  return { title: `Sentry ${resource}${b.action ? ` (${b.action})` : ''}`, level: 'info', source: 'sentry' };
}

function vercel(b) {
  const type = s(b.type); const p = b.payload || {};
  const dep = p.deployment || {};
  const name = dep.name || (p.project && p.project.name) || '';
  const url = (p.links && p.links.deployment) || (dep.url ? `https://${dep.url}` : null);
  const map = { 'deployment.error': ['배포 실패', 'error'], 'deployment.canceled': ['배포 취소', 'warning'], 'deployment.succeeded': ['배포 성공', 'success'], 'deployment.ready': ['배포 준비됨', 'success'], 'deployment.promoted': ['배포 승격', 'success'], 'deployment.created': ['배포 시작', 'info'] };
  const m = map[type];
  if (!m) return { title: `Vercel ${type}`, level: 'info', source: 'vercel', url };
  return { title: `${m[0]}: ${name}`, level: m[1], url, source: `vercel:${name}`.slice(0, 60), fields: { target: p.target || dep.target, branch: dep.meta && dep.meta.githubCommitRef }, dedupeKey: `vercel:${name}:${type.split('.')[1] === 'succeeded' || type.endsWith('ready') ? 'ok' : 'deploy'}` };
}

/** (headers, body, raw, secret) → { provider, input } | null(무시할 이벤트). provider 가 없으면 input = body 그대로. */
function parse(headers, body, raw, secret) {
  const hs = {};
  for (const [k, v] of Object.entries(headers || {})) hs[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const provider = detect(hs);
  if (!provider) return { provider: null, input: body };
  verify(provider, hs, raw, secret);
  const b = body && typeof body === 'object' ? body : {};
  let out = null;
  if (provider === 'github') out = github(hs['x-github-event'], b);
  else if (provider === 'linear') out = linear(b);
  else if (provider === 'sentry') out = sentry(hs['sentry-hook-resource'], b);
  else if (provider === 'vercel') out = vercel(b);
  if (!out) return null;
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  if (out.fields) { for (const k of Object.keys(out.fields)) if (out.fields[k] == null || out.fields[k] === '') delete out.fields[k]; }
  return { provider, input: out };
}

module.exports = { parse, detect, _internals: { github, linear, sentry, vercel, verify } };
