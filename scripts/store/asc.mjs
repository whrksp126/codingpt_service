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
 *   node asc.mjs release [--yes]        승인 대기(PENDING_DEVELOPER_RELEASE) 버전을 출시
 *   node asc.mjs watch [--interval 600] 심사 상태를 주기 확인하며 전이를 출력(무인 폴링용)
 *
 * 안전 규율: 이 스크립트는 **심사 제출을 하지 않는다**(제출은 되돌리기 어렵고 리스팅·설문이
 * 갖춰졌는지 사람이 봐야 한다). 조회는 자유, 출시(release)는 --yes 를 요구한다.
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
const STATE_KO = {
  PREPARE_FOR_SUBMISSION: '제출 준비 중(아직 심사 안 보냄)',
  WAITING_FOR_REVIEW: '심사 대기열',
  IN_REVIEW: '심사 중',
  PENDING_DEVELOPER_RELEASE: '승인됨 — 출시 대기(내가 눌러야 나감)',
  PENDING_APPLE_RELEASE: '승인됨 — Apple 출시 대기',
  PROCESSING_FOR_APP_STORE: '스토어 반영 처리 중',
  READY_FOR_SALE: '게시됨',
  REJECTED: '거절됨',
  METADATA_REJECTED: '메타데이터 거절',
  DEVELOPER_REJECTED: '개발자가 철회',
  INVALID_BINARY: '바이너리 무효',
  REPLACED_WITH_NEW_VERSION: '새 버전으로 대체됨',
};
const ko = (s) => `${s}${STATE_KO[s] ? ` — ${STATE_KO[s]}` : ''}`;

async function versions(appid) {
  const r = await api(`/v1/apps/${appid}/appStoreVersions?filter[platform]=IOS&limit=5`);
  return (r?.data || []).map((v) => ({
    id: v.id,
    version: v.attributes?.versionString,
    state: v.attributes?.appStoreState || v.attributes?.appVersionState,
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
  const live = vs.find((v) => v.state === 'READY_FOR_SALE');
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
const run = { status: cmdStatus, builds: cmdBuilds, release: () => cmdRelease(argv), watch: () => cmdWatch(argv) }[cmd];
if (!run) die(`알 수 없는 명령: ${cmd}\n사용: status | builds | release [--yes] | watch [--interval 600]`);
run().catch((e) => die(String(e.message || e)));
