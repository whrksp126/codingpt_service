#!/usr/bin/env node
// _signing-api.mjs — ios-signing.sh 의 ASC API 부분(인증서 발급 / 프로파일 발급·설치).
//  단독 실행용이 아니다. env: ASC_KEY_ID, ASC_ISSUER_ID, WORK, BUNDLE_ID, PROFILE_NAME
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER = process.env.ASC_ISSUER_ID;
const WORK = process.env.WORK;
const KEY_PATH = process.env.ASC_KEY_PATH
  || path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${KEY_ID}.p8`);

function token() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const p = b64({ iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const s = crypto.createSign('SHA256').update(`${h}.${p}`)
    .sign({ key: fs.readFileSync(KEY_PATH, 'utf8'), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${s}`;
}
async function api(p, init) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + p, {
    ...init, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { /* noop */ }
  if (!r.ok) {
    console.error(`ASC ${r.status} ${p}\n  ${(j?.errors || []).map((e) => `${e.title}: ${e.detail}`).join(' / ') || t.slice(0, 300)}`);
    process.exit(1);
  }
  return j;
}

// 최신 유효 배포 인증서(없으면 null).
async function newestDistCert() {
  const r = await api('/v1/certificates?limit=20');
  return (r.data || [])
    .filter((c) => c.attributes.certificateType === 'IOS_DISTRIBUTION')
    .sort((a, b) => String(b.attributes.expirationDate).localeCompare(String(a.attributes.expirationDate)))[0] || null;
}

if (process.argv[2] === 'cert') {
  // CSR 로 배포 인증서 발급 → DER 을 WORK/dist.cer 로 저장(셸이 p12 로 조립).
  const created = await api('/v1/certificates', {
    method: 'POST',
    body: JSON.stringify({ data: { type: 'certificates', attributes: { certificateType: 'IOS_DISTRIBUTION', csrContent: process.env.CSR } } }),
  });
  fs.writeFileSync(path.join(WORK, 'dist.cer'), Buffer.from(created.data.attributes.certificateContent, 'base64'));
  console.log(`인증서 발급: ${created.data.attributes.displayName} (만료 ${String(created.data.attributes.expirationDate).slice(0, 10)})`);
} else if (process.argv[2] === 'profile') {
  const name = process.env.PROFILE_NAME;
  const bundle = process.env.BUNDLE_ID;
  const cert = await newestDistCert();
  if (!cert) { console.error('배포 인증서를 찾을 수 없습니다.'); process.exit(1); }
  const bid = (await api(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundle)}&limit=1`)).data?.[0];
  if (!bid) { console.error(`bundleId 없음: ${bundle}`); process.exit(1); }

  const existing = (await api('/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=50')).data || [];
  let prof = existing.find((p) => p.attributes.name === name && p.attributes.profileState === 'ACTIVE');
  if (!prof) {
    // 같은 이름의 만료/무효 프로파일이 있으면 지워야 이름 충돌이 안 난다.
    const stale = existing.find((p) => p.attributes.name === name);
    if (stale) await api(`/v1/profiles/${stale.id}`, { method: 'DELETE' });
    prof = (await api('/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({ data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bid.id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } },
      } }),
    })).data;
    console.log(`프로파일 생성: ${name}`);
  } else {
    console.log(`기존 프로파일 재사용: ${name}`);
  }
  const dir = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${prof.attributes.uuid}.mobileprovision`), Buffer.from(prof.attributes.profileContent, 'base64'));
  console.log(`설치: ${prof.attributes.uuid}.mobileprovision`);
} else {
  console.error('사용: _signing-api.mjs cert|profile');
  process.exit(1);
}
