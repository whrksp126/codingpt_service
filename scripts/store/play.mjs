#!/usr/bin/env node
/**
 * play.mjs — Google Play 심사 상태 조회 CLI (의존성 0, node 내장 crypto 로 서비스계정 JWT 서명).
 *
 * ★ 2026 에 생긴 API 다: `applications.tracks.releases.list` 가 `releaseLifecycleState` 를 준다.
 *   (라이브 디스커버리 문서 rev 20260730 에서 실측 확인 — 오래된 자료·조사는 "Play 는 심사 상태를
 *   알 수 없다" 고 말하는데 더 이상 사실이 아니다.) 덕분에 Apple 처럼 "승인되면 출시" 가 가능하다.
 *
 * 필요한 자격(env — 값을 인자로 넘기지 말 것):
 *   PLAY_SA_JSON   서비스계정 JSON 경로 (기본: ~/other/secrets/play/service-account.json)
 *
 * 사용:
 *   node play.mjs status                 트랙별 릴리스와 심사 상태
 *   node play.mjs watch [--interval 900] 상태 전이를 주기 감시(무인 폴링)
 *
 * 안전 규율: 조회만 한다. 업로드·트랙 변경·게시는 되돌리기 어려우므로 여기 넣지 않았다.
 *  (넣게 되면 commit 에 반드시 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 를 명시할 것 —
 *   기본값 CANCEL_IN_REVIEW_AND_SUBMIT 은 **진행 중인 심사를 취소하고 대기열 순번을 잃는다.**)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = 'com.ghmate.codingpt.app';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TRACKS = ['production', 'beta', 'alpha', 'internal'];

function die(msg) { console.error(msg); process.exit(1); }

function saPath() {
  const p = process.env.PLAY_SA_JSON || path.join(os.homedir(), 'other', 'secrets', 'play', 'service-account.json');
  if (!fs.existsSync(p)) {
    die([
      `Play 서비스계정 JSON 이 없습니다: ${p}`,
      '',
      '발급(사용자 1회, 8단계):',
      '  GCP  ① 프로젝트 생성 → ② "Google Play Android Developer API" 활성화',
      '       → ③ IAM → 서비스 계정 생성 → ④ 키 추가(JSON) → ⑤ 다운로드',
      '  Play ⑥ Play Console → 사용자 및 권한 → 새 사용자 초대',
      '       → ⑦ 서비스계정 이메일(...iam.gserviceaccount.com) 입력',
      '       → ⑧ 앱 권한 부여 후 초대(수락 절차 없음, 저장 즉시 유효)',
      '',
      '⚠ 권한 전파에 최대 24~36시간 걸릴 수 있다(문서화되지 않은 지연). 급할 때 하지 말 것.',
      `그리고 JSON 을 ${p} 에 두면 이 스크립트가 바로 동작한다.`,
    ].join('\n'));
  }
  return p;
}

// 서비스계정 JWT(RS256) → OAuth2 access token 교환.
async function accessToken() {
  const sa = JSON.parse(fs.readFileSync(saPath(), 'utf8'));
  if (!sa.client_email || !sa.private_key) die('서비스계정 JSON 형식이 아닙니다(client_email/private_key 없음).');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) die(`토큰 발급 실패: ${j.error_description || j.error || res.status}`);
  return j.access_token;
}

const STATE_KO = {
  RELEASE_LIFECYCLE_STATE_DRAFT: '초안(아직 안 보냄)',
  RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: '심사 미제출 — Play Console 에서 보내야 함',
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: '심사 중',
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: '승인됨 — 게시 대기(내가 내보내야 함)',
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: '거절됨(사유는 Play Console — API 로는 안 온다)',
  RELEASE_LIFECYCLE_STATE_PUBLISHED: '게시됨',
};
const short = (s) => String(s || '').replace('RELEASE_LIFECYCLE_STATE_', '');
const ko = (s) => `${short(s)}${STATE_KO[s] ? ` — ${STATE_KO[s]}` : ''}`;

async function releases(token) {
  const out = [];
  for (const track of TRACKS) {
    const res = await fetch(`${API}/applications/${PKG}/tracks/${track}/releases`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) continue; // 그 트랙에 릴리스 없음
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) die(`권한 없음(${res.status}) — Play Console 에서 이 서비스계정에 앱 권한을 줬는지, 전파(최대 24~36h)가 끝났는지 확인.`);
      continue;
    }
    for (const r of j.releases || []) out.push({ track, name: r.releaseName, state: r.releaseLifecycleState, artifacts: r.activeArtifacts });
  }
  return out;
}

async function cmdStatus() {
  const rs = await releases(await accessToken());
  if (!rs.length) { console.log('릴리스 없음(또는 권한 부족).'); return; }
  for (const r of rs) console.log(`  ${r.track.padEnd(11)} ${String(r.name || '-').padEnd(14)} ${ko(r.state)}`);
  const appr = rs.find((r) => r.state === 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED');
  if (appr) console.log(`\n▶ ${appr.track} 의 ${appr.name} 이 승인됨 — Play Console 또는 edits API 로 게시하면 됩니다.`);
}

async function cmdWatch(argv) {
  const i = argv.indexOf('--interval');
  const sec = i >= 0 ? Math.max(60, Number(argv[i + 1]) || 900) : 900;
  console.log(`Play 심사 상태 감시 시작(${sec}s 간격). Ctrl+C 로 종료.`);
  let last = '';
  for (;;) {
    try {
      const rs = await releases(await accessToken());
      const cur = rs.map((r) => `${r.track}:${r.name}:${r.state}`).join(',');
      if (cur !== last) {
        console.log(`[${new Date().toISOString()}]`);
        for (const r of rs) console.log(`  ${r.track.padEnd(11)} ${String(r.name || '-').padEnd(14)} ${ko(r.state)}`);
        last = cur;
      }
    } catch (e) { console.error('조회 실패(계속 재시도):', String(e.message || e).split('\n')[0]); }
    await new Promise((r) => setTimeout(r, sec * 1000));
  }
}

const [, , cmd = 'status', ...argv] = process.argv;
const run = { status: cmdStatus, watch: () => cmdWatch(argv) }[cmd];
if (!run) die(`알 수 없는 명령: ${cmd}\n사용: status | watch [--interval 900]`);
run().catch((e) => die(String(e.message || e)));
