#!/usr/bin/env node
// compat-check — "PC 를 올렸는데 앱이 못 따라오는" 상태를 배포 때 자동으로 잡는다.
//
// 왜 이 파일이 있나(2026-09-06~07 실사고):
//   PC 0.1.325 가 터미널을 CPT3 전용으로 바꿨다. 앱은 0.4.1 에서 v3 뷰어가 됐으므로
//   0.4.0 이하 앱은 터미널이 열리지 않는다. 그런데 그 사실이 **아무 데도 적혀 있지 않았고**
//   prod 의 APP_MIN_* 도 비어 있어서, 구버전 앱 사용자는 안내 한 줄 없이 기능만 막혔다.
//   사람이 기억해야 하는 규율은 반드시 잊힌다 → 여기서 기계가 대조한다.
//
// 대조하는 것 두 가지:
//   1) prod 가 알려주는 minVersion == compat.json 의 minApp        (안 맞으면 강제 안내가 안 뜬다)
//   2) 스토어 게시 버전 >= compat.json 의 minApp                    (안 맞으면 **받을 게 없다** — 치명)
//
// 사용: node scripts/compat-check.mjs [prod|dev]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = ['android', 'ios'];

/** semver 비교 — a>b:1, a<b:-1, 같으면 0. 빈 문자열은 0.0.0 취급. */
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 순수 판정 — 네트워크 없이 테스트할 수 있게 분리한다.
 * @param manifest compat.json 내용
 * @param live { android: {version,minVersion?}, ios: {...} } — /api/app/version 응답
 * @returns { ok, problems: [{ level:'fatal'|'warn', platform, message, fix? }] }
 */
export function evaluate(manifest, live) {
  const problems = [];
  for (const p of PLATFORMS) {
    const required = String((manifest?.minApp || {})[p] || '');
    const got = live?.[p] || {};
    const storeVersion = String(got.version || '');
    const declaredMin = String(got.minVersion || '');

    if (!required) {
      problems.push({ level: 'warn', platform: p, message: `compat.json 에 minApp.${p} 가 없다 — 하한을 선언하지 않으면 검증이 무의미하다` });
      continue;
    }

    // (2) 먼저 본다 — 받을 게 없는 상태가 가장 나쁘다. 이때는 (1) 을 보지 않는다:
    //     게시도 안 된 버전을 APP_MIN_* 으로 강제하면 사용자는 끌 수 없는 안내를 받고도
    //     스토어에 그 버전이 없어 아무것도 못 한다 — 안내가 없는 것보다 나쁘다.
    if (!storeVersion) {
      problems.push({ level: 'warn', platform: p, message: '스토어 버전을 못 읽었다(조회 실패) — 하한 검증을 건너뛴다' });
      continue;
    }
    if (cmpVersion(storeVersion, required) < 0) {
      problems.push({
        level: 'fatal',
        platform: p,
        message: `PC 가 요구하는 하한(${required}) 보다 스토어 게시본(${storeVersion})이 낮다 — 이 플랫폼 사용자는 고칠 방법이 없다`,
        fix: `${p} ${required} 를 스토어에 출시한다. 그때까지 APP_MIN_${p.toUpperCase()} 는 비워 둔다(받을 수 없는 강제 안내 금지)`,
      });
      continue;
    }

    // (1) 강제 안내 스위치가 켜져 있는가 — 받을 수 있는 버전이 있을 때만 의미가 있다.
    if (cmpVersion(declaredMin, required) !== 0) {
      problems.push({
        level: 'fatal',
        platform: p,
        message: `prod 가 알려주는 minVersion(${declaredMin || '없음'})이 compat.json 의 ${required} 와 다르다 — 구버전 앱에 강제 안내가 안 뜬다`,
        fix: `docker-compose.prod.yml 의 APP_MIN_${p.toUpperCase()}=${required} 로 맞추고 back 을 재생성한다(restart 로는 env 가 안 바뀐다)`,
      });
    }
  }
  return { ok: problems.every((x) => x.level !== 'fatal'), problems };
}

const BASE = { prod: 'https://codingpt-back.ghmate.com', dev: 'https://dev-codingpt-back.ghmate.com' };

async function main() {
  const env = process.argv[2] || 'prod';
  const base = BASE[env];
  if (!base) { console.error('사용법: node scripts/compat-check.mjs [prod|dev]'); process.exit(1); }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'compat.json'), 'utf8'));
  const live = {};
  for (const p of PLATFORMS) {
    try {
      const res = await fetch(`${base}/api/app/version?platform=${p}`);
      const json = await res.json();
      live[p] = json?.data ?? json ?? {};
    } catch (_) { live[p] = {}; }
  }

  console.log(`── ${env} 호환 검증 (compat.json: PC ${manifest.pc} → 앱 하한 android ${manifest.minApp.android} / ios ${manifest.minApp.ios}) ──`);
  for (const p of PLATFORMS) {
    console.log(`  INFO  ${p}: 스토어 ${live[p].version || '?'} · 알려주는 하한 ${live[p].minVersion || '없음'}`);
  }

  const { ok, problems } = evaluate(manifest, live);
  for (const x of problems) {
    console.log(`  ${x.level === 'fatal' ? 'FAIL' : 'WARN'}  [${x.platform}] ${x.message}`);
    if (x.fix) console.log(`        → ${x.fix}`);
  }
  if (!ok) { console.log('\n❌ 호환 검증 실패 — 구버전 앱 사용자가 막힌 채 안내를 못 받는 상태다'); process.exit(1); }
  console.log('\n✅ 호환 검증 통과');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
