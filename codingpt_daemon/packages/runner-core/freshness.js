/**
 * 신선도 보고 — 이 호스트 사본들의 git 상태(브랜치·미커밋·미푸시)를 back 에 주기 보고한다.
 *
 * 목적: 멀티 PC 에서 "어느 사본이 최신인지"를 모든 기기 사이드바가 배지로 보게 하는 것.
 * 흐름: 60s 마다 GET /api/daemon/workspaces → 내 hostDeviceId 사본만 → git 로컬 조회 →
 *       달라진 것만 POST /api/daemon/workspaces/:wsId/git (back 도 무변화 쓰기 생략 — 이중 방어).
 * git 은 execFile(셸 인젝션 없음), 저장소 아님/업스트림 없음은 조용히 건너뜀/표시.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const runtime = require('./runtime');
const configLib = require('./config');
// backFetch 는 지연 require — cpt-server 가 pty(node-pty 네이티브)를 끌고 와서, statusFor 만 쓰는
// 테스트/CI(prebuild 없음)에서 모듈 로드가 깨지지 않게 한다.
const backFetch = (...a) => require('./cpt-server').backFetch(...a);

const INTERVAL_MS = 60 * 1000;
const MISSING_KEY = 'missing'; // 유령(폴더 소실) 상태의 비교 키 — 전이 시에만 1회 보고
const lastReported = new Map(); // wsId → 비교 키(JSON)

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

// 한 사본의 git 상태 — { branch, dirty, ahead, behind, upstream } | null(저장소 아님)
async function statusFor(absPath) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], absPath);
  if (!inside || inside.trim() !== 'true') return null;
  const branch = ((await git(['rev-parse', '--abbrev-ref', 'HEAD'], absPath)) || '').trim();
  const porcelain = await git(['status', '--porcelain'], absPath);
  const dirty = !!(porcelain && porcelain.trim());
  // 업스트림 대비 미푸시/미풀 커밋 수 — 업스트림 없으면(로컬 전용 브랜치) upstream:false.
  const lr = await git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], absPath);
  let ahead = 0; let behind = 0; let upstream = false;
  if (lr) {
    const m = lr.trim().split(/\s+/);
    behind = parseInt(m[0], 10) || 0;
    ahead = parseInt(m[1], 10) || 0;
    upstream = true;
  }
  return { branch, dirty, ahead, behind, upstream };
}

async function tick() {
  const cfg = configLib.load();
  if (!cfg || !cfg.deviceToken || cfg.deviceId == null) return;
  let list;
  try { list = await backFetch('GET', '/api/daemon/workspaces'); } catch (_) { return; }
  if (!Array.isArray(list)) return;
  const mine = list.filter((w) => w && w.compute === 'local' && w.hostDeviceId === cfg.deviceId && typeof w.localPath === 'string' && w.localPath);
  for (const w of mine) {
    try {
      const abs = path.join(runtime.root(), w.localPath);
      // 유령 감지 — 폴더 자체가 사라졌으면(이동/삭제) git 조회 생략하고 missing 만 보고.
      if (!fs.existsSync(abs)) {
        if (lastReported.get(w.id) === MISSING_KEY) continue;
        await backFetch('POST', `/api/daemon/workspaces/${w.id}/git`, { missing: true });
        lastReported.set(w.id, MISSING_KEY);
        continue;
      }
      const st = await statusFor(abs);
      if (!st) {
        // git 저장소 아님 — 배지 없음(보고 생략). 단, 직전이 missing 이었다면 복구 1회 보고(플래그 해제).
        if (lastReported.get(w.id) === MISSING_KEY) {
          await backFetch('POST', `/api/daemon/workspaces/${w.id}/git`, { missing: false });
          lastReported.delete(w.id);
        }
        continue;
      }
      const key = JSON.stringify([st.branch, st.dirty, st.ahead, st.behind, st.upstream]);
      if (lastReported.get(w.id) === key) continue;
      await backFetch('POST', `/api/daemon/workspaces/${w.id}/git`, st);
      lastReported.set(w.id, key);
    } catch (_) { /* 개별 실패는 다음 주기에 재시도 */ }
  }
}

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => { tick().catch(() => {}); }, 5000); // 부팅 직후 1회(연결 안정 대기)
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, statusFor, tick }; // tick 은 테스트용(단위 전이 검증)
