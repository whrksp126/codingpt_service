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
 *   node play.mjs upload --aab <경로> [--track production] [--notes "..."] [--yes]
 *                                        AAB 업로드 + 트랙 릴리스 + 커밋(=심사 제출)
 *   ... --pkg com.ghmate.heyvoca          다른 앱 대상(같은 서비스계정에 권한이 있으면)
 *
 * 안전 규율: 조회는 자유. **바깥으로 나가는 행위(업로드·트랙 변경·제출)는 `--yes` 를 요구**한다.
 *  ⚠ commit 에 반드시 `changesInReviewBehavior=ERROR_IF_IN_REVIEW` 를 붙인다 — 기본값
 *   `CANCEL_IN_REVIEW_AND_SUBMIT` 은 **진행 중인 심사를 취소하고 대기열 순번을 잃는다.**
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 대상 앱 — 기본은 CodingPT. 같은 서비스계정에 다른 앱 권한도 줬다면 --pkg 로 바꿔 쓴다
//  (예: heyvoca `--pkg com.ghmate.heyvoca`). 권한이 없는 앱을 물으면 403 이 난다.
const PKG = (() => {
  const i = process.argv.indexOf('--pkg');
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : (process.env.PLAY_PKG || 'com.ghmate.codingpt.app');
})();
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
// ⚠ `tracks/{track}/releases` 는 **쿼터가 빡빡하다** — 몇 번만 훑어도 403
//  "Listing releases quota exceeded"(status: PERMISSION_DENIED) 가 난다. 권한 오류처럼 보이지만
//  아니다(2026-08-01 실측: 초대 직후엔 200 이던 것이 몇 십 분 뒤 403). 그래서 기본은 production
//  한 트랙만 본다. 전부 보려면 --all-tracks.
const ALL_TRACKS = ['production', 'beta', 'alpha', 'internal'];
const TRACKS = process.argv.includes('--all-tracks') ? ALL_TRACKS : ['production'];

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
      const msg = j?.error?.message || '';
      // 쿼터 초과도 403/PERMISSION_DENIED 로 온다 — 권한 문제로 오진하면 엉뚱한 곳을 고치게 된다.
      if (/quota/i.test(msg)) { const e = new Error(`Play 조회 쿼터 초과 — 잠시 뒤 다시 시도하세요(권한 문제 아님).\n  ${msg}`); e.quota = true; throw e; }
      if (res.status === 401 || res.status === 403) die(`권한 없음(${res.status}) — Play Console 에서 이 서비스계정에 앱 권한을 줬는지 확인.\n  ${msg}`);
      continue;
    }
    for (const r of j.releases || []) out.push({ track, name: r.releaseName, state: r.releaseLifecycleState, artifacts: r.activeArtifacts });
  }
  return out;
}

async function cmdStatus() {
  console.log(`앱: ${PKG}`);
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
  let wait = sec;
  for (;;) {
    try {
      const rs = await releases(await accessToken());
      const cur = rs.map((r) => `${r.track}:${r.name}:${r.state}`).join(',');
      if (cur !== last) {
        console.log(`[${new Date().toISOString()}]`);
        for (const r of rs) console.log(`  ${r.track.padEnd(11)} ${String(r.name || '-').padEnd(14)} ${ko(r.state)}`);
        last = cur;
      }
      wait = sec;
    } catch (e) {
      console.error('조회 실패(계속 재시도):', String(e.message || e).split('\n')[0]);
      if (e.quota) { wait = Math.min(wait * 2, 3600); console.error(`  쿼터 백오프 → ${wait}s`); }
    }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// ── 업로드 + 트랙 릴리스 + 커밋(=심사 제출) ───────────────────────────
async function papi(token, pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (_) { /* noop */ }
  if (!res.ok) throw new Error(`Play ${res.status} ${pathname}\n  ${j?.error?.message || text.slice(0, 300)}`);
  return j;
}

async function cmdUpload(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const aab = arg('--aab');
  const track = arg('--track') || 'production';
  const notes = arg('--notes') || '';
  if (!aab || !fs.existsSync(aab)) die('사용: upload --aab <파일경로> [--track production] [--notes "..."] [--yes]');
  const size = fs.statSync(aab).size;
  console.log(`앱: ${PKG}\n파일: ${aab} (${(size / 1048576).toFixed(1)}MB)\n트랙: ${track}`);
  if (!argv.includes('--yes')) {
    console.log('\n실제로 업로드·제출하려면 --yes 를 붙이세요. (심사 대기열에 들어갑니다)');
    return;
  }
  const token = await accessToken();

  // 1) edit 열기 — 사용자당 동시에 1개. 누가 Play Console 에서 손대면 무효화된다.
  const edit = await papi(token, `/applications/${PKG}/edits`, { method: 'POST', body: '{}' });
  const editId = edit.id;
  console.log(`edit ${editId} 열림`);

  try {
    // 2) AAB 업로드 — 별도 upload 엔드포인트(uploadType=media).
    const up = await fetch(
      `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}/edits/${editId}/bundles?uploadType=media`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(aab) },
    );
    const upText = await up.text();
    if (!up.ok) throw new Error(`업로드 실패 ${up.status}: ${upText.slice(0, 300)}`);
    const versionCode = JSON.parse(upText).versionCode;
    console.log(`업로드 완료 — versionCode ${versionCode}`);

    // 3) 트랙 릴리스 — status:'completed' = 승인되면 100% 게시.
    await papi(token, `/applications/${PKG}/edits/${editId}/tracks/${track}`, {
      method: 'PUT',
      body: JSON.stringify({ track, releases: [{
        versionCodes: [String(versionCode)],
        status: 'completed',
        ...(notes ? { releaseNotes: [{ language: 'ko-KR', text: notes }] } : {}),
      }] }),
    });
    console.log(`트랙 ${track} 에 릴리스 구성`);

    // 4) 커밋 = 심사 제출. ERROR_IF_IN_REVIEW 필수(기본값은 진행 중 심사를 취소한다).
    await papi(token, `/applications/${PKG}/edits/${editId}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`, { method: 'POST' });
    console.log(`\n✅ 제출 완료 — \`play.mjs watch\` 로 심사 상태를 감시하세요.`);
  } catch (e) {
    // 실패하면 edit 을 버린다 — 열린 채 두면 다음 시도가 "이미 edit 이 있다" 로 막힌다.
    try { await papi(token, `/applications/${PKG}/edits/${editId}`, { method: 'DELETE' }); console.log('edit 정리됨'); } catch (_) { /* noop */ }
    throw e;
  }
}

const [, , cmd = 'status', ...argv] = process.argv;
const run = { status: cmdStatus, watch: () => cmdWatch(argv), upload: () => cmdUpload(argv) }[cmd];
if (!run) die(`알 수 없는 명령: ${cmd}\n사용: status | watch [--interval 900] | upload --aab <경로> [--yes]`);
run().catch((e) => die(String(e.message || e)));
