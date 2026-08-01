#!/usr/bin/env node
/**
 * asc.mjs — App Store Connect API CLI (의존성 0, node 내장 crypto 로 JWT 서명).
 *
 * 왜 만드나: 스토어에 올린 뒤 "심사 어떻게 됐지?" 를 사람이 웹에서 확인하고, 승인되면 또 사람이
 * 눌러서 출시하는 구간이 매번 남는다. 상태 조회와 출시는 공개 API 로 가능하므로 자동화한다.
 *
 * 필요한 자격(전부 env — 값은 절대 인자로 넘기지 말 것: 셸 히스토리·프로세스 목록에 남는다):
 *   ASC_KEY_ID      키 ID (예: 파일명 AuthKey_XXXXXXXX.p8 의 XXXXXXXX)
 *   ASC_ISSUER_ID   Issuer ID (UUID) — App Store Connect → 사용자 및 액세스 → 통합 → 상단
 *   ASC_KEY_PATH    .p8 경로 (기본: ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8)
 *
 * 사용:
 *   node asc.mjs status                 앱/버전/심사 상태 요약
 *   node asc.mjs builds                 최근 업로드된 빌드(처리 상태 포함)
 *   node asc.mjs prepare 0.3.0 --build 23 --notes "..."   버전 생성+빌드 연결+릴리스 노트
 *   node asc.mjs preflight              지금 제출해도 되는지 점검(무해 — 아무것도 안 바꿈)
 *   node asc.mjs submit [--yes]         심사 제출(preflight 통과해야 진행)
 *   node asc.mjs cancel [--yes]         제출 철회
 *   node asc.mjs release [--yes]        승인 대기(PENDING_DEVELOPER_RELEASE) 버전을 출시
 *   node asc.mjs watch [--interval 600] 심사 상태를 주기 확인하며 전이를 출력(무인 폴링용)
 *
 * 안전 규율: 조회는 자유. **바깥으로 나가는 행위(제출·출시)는 `--yes` 를 요구**하고, 제출 전에는
 * 사람이 눈으로 보던 것들을 preflight 로 대신 확인한다(빌드 연결·릴리스 노트·수출규정·심사 연락처).
 * 제출은 되돌릴 수 있다 — `cancel` 로 철회한다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUNDLE_ID = 'com.ghmate.codingpt.app';
const API = 'https://api.appstoreconnect.apple.com';

function die(msg, code = 1) { console.error(msg); process.exit(code); }

function creds() {
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER_ID;
  if (!keyId || !issuer) {
    die([
      '자격증명이 없습니다. 다음 env 가 필요합니다:',
      '  ASC_KEY_ID     (.p8 파일명의 키 ID)',
      '  ASC_ISSUER_ID  App Store Connect → 사용자 및 액세스 → 통합 → 상단의 Issuer ID(UUID)',
      '  ASC_KEY_PATH   (선택) .p8 경로',
      '',
      '값은 명령줄 인자가 아니라 env 로 넘기세요(히스토리·프로세스 목록에 남습니다).',
    ].join('\n'));
  }
  const keyPath = process.env.ASC_KEY_PATH
    || path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
  if (!fs.existsSync(keyPath)) die(`.p8 키를 찾을 수 없습니다: ${keyPath}`);
  return { keyId, issuer, keyPath };
}

// ES256 JWT — ASC 는 만료 20분 이내만 받는다.
function token() {
  const { keyId, issuer, keyPath } = creds();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const body = b64({ iss: issuer, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = crypto.createSign('SHA256')
    .update(`${head}.${body}`)
    .sign({ key: fs.readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* noop */ }
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.title}: ${e.detail}`).join(' / ') || text.slice(0, 300);
    throw new Error(`ASC ${res.status} ${pathname}\n  ${detail}`);
  }
  return json;
}

async function appId() {
  const r = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const app = r?.data?.[0];
  if (!app) die(`앱을 찾을 수 없습니다(bundleId=${BUNDLE_ID}). 키 권한(앱 관리자)을 확인하세요.`);
  return app;
}

// 심사 상태를 사람 말로. Apple 의 상태 문자열은 그대로 두면 뜻이 안 보인다.
//  ⚠ enum 이 바뀌었다(실측 2026-08-01): 같은 버전이 구 필드 appStoreState=READY_FOR_SALE,
//   신 필드 appVersionState=READY_FOR_DISTRIBUTION 으로 **동시에** 내려온다. 구 이름으로만
//   매칭하면 어느 날 조용히 안 걸린다 → 신 필드를 우선하고 양쪽 이름을 모두 해석한다.
const STATE_KO = {
  PREPARE_FOR_SUBMISSION: '제출 준비 중(아직 심사 안 보냄)',
  READY_FOR_REVIEW: '제출 준비 완료(아직 안 보냄)',
  WAITING_FOR_REVIEW: '심사 대기열',
  IN_REVIEW: '심사 중',
  ACCEPTED: '승인됨',
  PENDING_DEVELOPER_RELEASE: '승인됨 — 출시 대기(내가 눌러야 나감)',
  PENDING_APPLE_RELEASE: '승인됨 — Apple 출시 대기',
  WAITING_FOR_EXPORT_COMPLIANCE: '수출규정 답변 대기',
  PROCESSING_FOR_APP_STORE: '스토어 반영 처리 중(구 이름)',
  PROCESSING_FOR_DISTRIBUTION: '스토어 반영 처리 중',
  READY_FOR_SALE: '게시됨(구 이름)',
  READY_FOR_DISTRIBUTION: '게시됨',
  REJECTED: '거절됨',
  METADATA_REJECTED: '메타데이터 거절',
  DEVELOPER_REJECTED: '개발자가 철회',
  INVALID_BINARY: '바이너리 무효',
  REPLACED_WITH_NEW_VERSION: '새 버전으로 대체됨',
};
// 게시 완료로 볼 상태(구·신 이름 둘 다).
const PUBLISHED = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
const ko = (s) => `${s}${STATE_KO[s] ? ` — ${STATE_KO[s]}` : ''}`;

async function versions(appid) {
  const r = await api(`/v1/apps/${appid}/appStoreVersions?filter[platform]=IOS&limit=5`);
  return (r?.data || []).map((v) => ({
    id: v.id,
    version: v.attributes?.versionString,
    // appVersionState 가 정본(appStoreState 는 deprecated — 값 이름도 다르다).
    state: v.attributes?.appVersionState || v.attributes?.appStoreState,
    created: v.attributes?.createdDate,
    releaseType: v.attributes?.releaseType,
  }));
}

async function cmdStatus() {
  const app = await appId();
  console.log(`앱: ${app.attributes?.name} (${BUNDLE_ID}) id=${app.id}`);
  const vs = await versions(app.id);
  if (!vs.length) { console.log('버전 없음'); return; }
  for (const v of vs) console.log(`  ${v.version.padEnd(8)} ${ko(v.state)}`);
  const live = vs.find((v) => PUBLISHED.has(v.state));
  const pend = vs.find((v) => v.state === 'PENDING_DEVELOPER_RELEASE');
  console.log('');
  if (live) console.log(`게시 중: ${live.version}`);
  if (pend) console.log(`▶ ${pend.version} 은 승인 완료 — \`node asc.mjs release --yes\` 로 출시할 수 있습니다.`);
}

async function cmdBuilds() {
  const app = await appId();
  const r = await api(`/v1/builds?filter[app]=${app.id}&limit=5&sort=-uploadedDate`);
  for (const b of r?.data || []) {
    const a = b.attributes || {};
    console.log(`  build ${String(a.version).padEnd(5)} ${a.processingState}  업로드 ${a.uploadedDate}  만료=${a.expired}`);
  }
  if (!(r?.data || []).length) console.log('업로드된 빌드 없음');
}

// ── 제출 준비: 버전 만들기 + 빌드 연결 + 릴리스 노트 ──────────────────
// 이게 없으면 "제출 자동화" 가 반쪽이다(제출할 버전 자체를 사람이 웹에서 만들어야 하므로).
//  releaseType 은 MANUAL 로 둔다 — 승인 뒤 우리가 release 로 내보내는 루프의 전제다.
async function cmdPrepare(argv) {
  const version = argv.find((a) => /^\d+(\.\d+)*$/.test(a));
  if (!version) die('사용: prepare <버전> [--build <번호>] [--notes "릴리스 노트"]');
  const bi = argv.indexOf('--build');
  const wantBuild = bi >= 0 ? String(argv[bi + 1]) : null;
  const ni = argv.indexOf('--notes');
  const notes = ni >= 0 ? String(argv[ni + 1] || '') : '';

  const app = await appId();
  const vs = await versions(app.id);
  let target = vs.find((v) => v.version === version);

  // 연결할 빌드 — 지정이 없으면 처리 완료(VALID)된 최신 것.
  const br = await api(`/v1/builds?filter[app]=${app.id}&limit=10&sort=-uploadedDate`);
  const builds = (br?.data || []).filter((b) => b.attributes?.processingState === 'VALID');
  const build = wantBuild ? builds.find((b) => String(b.attributes?.version) === wantBuild) : builds[0];
  if (!build) die(wantBuild ? `처리 완료된 build ${wantBuild} 를 찾을 수 없습니다.` : '처리 완료(VALID)된 빌드가 없습니다 — 업로드/처리를 기다리세요.');

  if (!target) {
    const created = await api('/v1/appStoreVersions', {
      method: 'POST',
      body: JSON.stringify({ data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: version, releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: app.id } }, build: { data: { type: 'builds', id: build.id } } },
      } }),
    });
    target = { id: created.data.id, version, state: created.data.attributes?.appVersionState };
    console.log(`버전 ${version} 생성 + build ${build.attributes?.version} 연결`);
  } else {
    if (!SUBMITTABLE.has(target.state)) die(`${version} 은 지금 수정할 수 없는 상태입니다(${ko(target.state)}).`);
    // 빌드 연결은 POST 가 아니라 **PATCH relationships** 다(자주 틀리는 지점).
    await api(`/v1/appStoreVersions/${target.id}/relationships/build`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'builds', id: build.id } }),
    });
    console.log(`버전 ${version} 에 build ${build.attributes?.version} 연결`);
  }

  if (notes) {
    const locs = await api(`/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=20`);
    for (const l of locs?.data || []) {
      await api(`/v1/appStoreVersionLocalizations/${l.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: notes } } }),
      });
    }
    console.log(`릴리스 노트 ${(locs?.data || []).length}개 로케일에 기록`);
  }
  console.log('\n다음: node asc.mjs preflight → submit --yes');
}

// ── 수출규정(암호화) 신고 ─────────────────────────────────────────────
// **법적 신고다 — 절대 자동으로 값을 정하지 않는다.** 미답변이면 심사가 WAITING_FOR_EXPORT_COMPLIANCE
// 에 걸려 시작조차 안 하므로 매 빌드 필요하다. 그래서 "이전 빌드에 뭐라고 답했는지" 를 보여 주고,
// 사람이 같은 값을 명시적으로 지정하게 한다(--exempt / --non-exempt).
//  ※ 영구히 안 묻게 하려면 Info.plist 에 ITSAppUsesNonExemptEncryption 를 넣으면 된다 —
//    그건 리포에 신고를 박는 일이라 사용자가 직접 판단할 몫으로 남긴다.
async function cmdCompliance(argv) {
  const app = await appId();
  const r = await api(`/v1/builds?filter[app]=${app.id}&limit=6&sort=-uploadedDate`);
  const builds = r?.data || [];
  const target = builds.find((b) => b.attributes?.usesNonExemptEncryption === null || b.attributes?.usesNonExemptEncryption === undefined);
  console.log('최근 빌드의 수출규정 신고:');
  for (const b of builds) console.log(`  build ${String(b.attributes?.version).padEnd(4)} ${b.attributes?.usesNonExemptEncryption ?? '미답변'}`);
  if (!target) { console.log('\n미답변 빌드가 없습니다.'); return; }
  const exempt = argv.includes('--exempt');
  const nonExempt = argv.includes('--non-exempt');
  if (!exempt && !nonExempt) {
    console.log(`\nbuild ${target.attributes?.version} 이 미답변입니다. --exempt(면제) 또는 --non-exempt 를 지정하세요.`);
    console.log('  이전 빌드와 같은 값을 쓰는 것이 보통이지만, 암호화 사용이 바뀌었다면 달라질 수 있습니다.');
    process.exitCode = 1;
    return;
  }
  await api(`/v1/builds/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'builds', id: target.id, attributes: { usesNonExemptEncryption: !!nonExempt } } }),
  });
  console.log(`\n✅ build ${target.attributes?.version} → usesNonExemptEncryption=${!!nonExempt}`);
}

// ── 제출 preflight ────────────────────────────────────────────────────
// 사람이 "제출 버튼을 누르기 전에 눈으로 보던 것" 을 대신 확인한다. 이게 없으면 자동 제출은
//  빈 릴리스 노트·빌드 미연결·수출규정 미답변으로 **거절을 쌓는 기계**가 된다(거절 사유는 API 로
//  읽을 수도 없으니 원인 파악까지 사람 몫이 된다).
const SUBMITTABLE = new Set([
  'PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY',
]);

async function preflight() {
  const app = await appId();
  const vs = await versions(app.id);
  const problems = [];
  const notes = [];
  const target = vs.find((v) => SUBMITTABLE.has(v.state));
  if (!target) {
    const live = vs.find((v) => PUBLISHED.has(v.state));
    const inflight = vs.find((v) => ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE'].includes(v.state));
    problems.push(inflight
      ? `제출할 버전이 없습니다 — ${inflight.version} 이 이미 ${ko(inflight.state)}`
      : `제출 가능한 버전이 없습니다(현재 게시본 ${live?.version || '?'}). 먼저 새 버전을 만들어야 합니다.`);
    return { app, target: null, problems, notes };
  }

  // 1) 빌드가 붙어 있나 — 안 붙으면 Apple 이 제출 자체를 거부한다.
  let build = null;
  try {
    const r = await api(`/v1/appStoreVersions/${target.id}/build`);
    build = r?.data || null;
  } catch (_) { build = null; }
  if (!build) problems.push(`${target.version} 에 빌드가 연결되지 않았습니다(업로드/처리 완료 후 연결 필요)`);

  // 2) 수출규정 답변 — 미답변이면 WAITING_FOR_EXPORT_COMPLIANCE 에 걸려 심사가 안 시작된다.
  if (build) {
    const enc = build.attributes?.usesNonExemptEncryption;
    if (enc === null || enc === undefined) problems.push('빌드의 수출규정(usesNonExemptEncryption)이 미답변입니다');
  }

  // 3) 릴리스 노트 — 빈 채로 제출하면 "이번 버전 새로운 기능" 이 비어 나간다.
  try {
    const locs = await api(`/v1/appStoreVersions/${target.id}/appStoreVersionLocalizations?limit=20`);
    const rows = locs?.data || [];
    const empty = rows.filter((l) => !String(l.attributes?.whatsNew || '').trim()).map((l) => l.attributes?.locale);
    if (!rows.length) problems.push('릴리스 노트 로케일이 하나도 없습니다');
    else if (empty.length === rows.length) problems.push(`릴리스 노트가 전부 비어 있습니다(${empty.join(', ')})`);
    else if (empty.length) notes.push(`릴리스 노트 미작성 로케일: ${empty.join(', ')}`);
  } catch (e) { notes.push('릴리스 노트 조회 실패 — 수동 확인 필요'); }

  // 4) 심사 연락처·데모 계정 — 로그인이 필요한 앱에서 이게 없으면 거의 확실히 거절된다.
  try {
    const d = await api(`/v1/appStoreVersions/${target.id}/appStoreReviewDetail`);
    const a = d?.data?.attributes || {};
    if (!a.contactEmail || !a.contactPhone) notes.push('심사 연락처(이메일/전화)가 비어 있습니다');
    if (!a.demoAccountRequired) notes.push('데모 계정 "필요 없음" 으로 되어 있습니다 — 로그인 앱이면 거절 위험');
    else if (!a.demoAccountName || !a.demoAccountPassword) problems.push('데모 계정이 필요하다고 되어 있는데 계정/비번이 비어 있습니다');
  } catch (_) { notes.push('심사 상세(데모 계정) 조회 실패 — 수동 확인 필요'); }

  return { app, target, build, problems, notes };
}

async function cmdPreflight() {
  const { target, build, problems, notes } = await preflight();
  if (target) console.log(`대상: ${target.version} (${ko(target.state)})${build ? ` · build ${build.attributes?.version}` : ''}`);
  for (const n of notes) console.log(`  주의  ${n}`);
  for (const p of problems) console.log(`  막힘  ${p}`);
  console.log('');
  if (problems.length) { console.log('❌ 지금 제출하면 실패하거나 거절될 가능성이 큽니다.'); process.exitCode = 1; return false; }
  console.log('✅ 제출 가능 — `node asc.mjs submit --yes`');
  return true;
}

// 심사 제출. 되돌릴 수 있다(cancel) — 하지만 바깥으로 나가는 행위라 --yes 를 요구한다.
async function cmdSubmit(argv) {
  const { app, target, problems, notes } = await preflight();
  if (target) console.log(`대상: ${target.version} (${ko(target.state)})`);
  for (const n of notes) console.log(`  주의  ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`  막힘  ${p}`);
    console.log('\n❌ preflight 실패 — 제출하지 않았습니다.');
    process.exitCode = 1;
    return;
  }
  if (!argv.includes('--yes')) {
    console.log('\npreflight 통과. 실제로 심사에 보내려면 --yes 를 붙이세요(철회는 `cancel`).');
    return;
  }
  // 이미 열려 있는 제출이 있으면 재사용한다(중복 생성은 409 를 부른다).
  const open = await api(`/v1/apps/${app.id}/reviewSubmissions?filter[state]=READY_FOR_REVIEW&limit=1`);
  let sub = open?.data?.[0] || null;
  if (!sub) {
    const created = await api('/v1/reviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({ data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } }),
    });
    sub = created.data;
  }
  // 이 버전이 아직 항목으로 안 들어갔으면 추가한다.
  const items = await api(`/v1/reviewSubmissions/${sub.id}/items?limit=20`).catch(() => null);
  const has = (items?.data || []).some((it) => it.relationships?.appStoreVersion?.data?.id === target.id);
  if (!has) {
    await api('/v1/reviewSubmissionItems', {
      method: 'POST',
      body: JSON.stringify({ data: { type: 'reviewSubmissionItems', relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } },
      } } }),
    });
  }
  await api(`/v1/reviewSubmissions/${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } }),
  });
  console.log(`\n✅ ${target.version} 심사 제출 완료. \`watch\` 로 결과를 감시하세요(철회는 \`cancel --yes\`).`);
}

// 제출 철회 — 심사 대기/진행 중인 제출을 되돌린다.
async function cmdCancel(argv) {
  const app = await appId();
  const r = await api(`/v1/apps/${app.id}/reviewSubmissions?filter[state]=WAITING_FOR_REVIEW,IN_REVIEW,READY_FOR_REVIEW&limit=5`);
  const sub = (r?.data || [])[0];
  if (!sub) { console.log('철회할 제출이 없습니다.'); return; }
  console.log(`제출 ${sub.id} (state=${sub.attributes?.state})`);
  if (!argv.includes('--yes')) { console.log('철회하려면 --yes 를 붙이세요.'); return; }
  await api(`/v1/reviewSubmissions/${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'reviewSubmissions', id: sub.id, attributes: { canceled: true } } }),
  });
  console.log('✅ 철회 요청 완료.');
}

async function cmdRelease(argv) {
  const app = await appId();
  const vs = await versions(app.id);
  const pend = vs.find((v) => v.state === 'PENDING_DEVELOPER_RELEASE');
  if (!pend) { console.log('출시 대기 중인 버전이 없습니다(승인 전이거나 이미 게시됨).'); return; }
  if (!argv.includes('--yes')) {
    console.log(`${pend.version} 이 출시 대기 중입니다. 실제로 내보내려면 --yes 를 붙이세요.`);
    return;
  }
  await api('/v1/appStoreVersionReleaseRequests', {
    method: 'POST',
    body: JSON.stringify({ data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: pend.id } } } } }),
  });
  console.log(`✅ ${pend.version} 출시 요청 완료 — 스토어 반영까지 수십 분 걸립니다.`);
}

// 심사 상태를 주기 확인. 전이가 있을 때만 출력하므로 로그가 조용하다.
async function cmdWatch(argv) {
  const i = argv.indexOf('--interval');
  const sec = i >= 0 ? Math.max(60, Number(argv[i + 1]) || 600) : 600;
  const app = await appId();
  let last = '';
  console.log(`심사 상태 감시 시작(${sec}s 간격). Ctrl+C 로 종료.`);
  for (;;) {
    try {
      const vs = await versions(app.id);
      const cur = vs.map((v) => `${v.version}:${v.state}`).join(',');
      if (cur !== last) {
        console.log(`[${new Date().toISOString()}]`);
        for (const v of vs) console.log(`  ${v.version.padEnd(8)} ${ko(v.state)}`);
        last = cur;
      }
    } catch (e) { console.error('조회 실패(계속 재시도):', e.message.split('\n')[0]); }
    await new Promise((r) => setTimeout(r, sec * 1000));
  }
}

const [, , cmd = 'status', ...argv] = process.argv;
const run = {
  status: cmdStatus, builds: cmdBuilds, preflight: cmdPreflight, prepare: () => cmdPrepare(argv), compliance: () => cmdCompliance(argv),
  submit: () => cmdSubmit(argv), cancel: () => cmdCancel(argv),
  release: () => cmdRelease(argv), watch: () => cmdWatch(argv),
}[cmd];
if (!run) die(`알 수 없는 명령: ${cmd}\n사용: status | builds | prepare <버전> | compliance | preflight | submit [--yes] | cancel [--yes] | release [--yes] | watch [--interval 600]`);
run().catch((e) => die(String(e.message || e)));
