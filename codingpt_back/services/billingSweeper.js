const subscriptionService = require('./subscriptionService');

// cron 라이브러리 없이 setInterval 스위퍼(기존 sandboxManager/previewService 패턴).
// 단일 컨테이너(replica=1) 가정. 갱신은 멱등 paymentId 라 중복 실행에도 안전.
// (크레딧 만료 스윕은 월 구독 전환으로 제거됨)

const RENEWAL_INTERVAL_MS = Number(process.env.BILLING_RENEWAL_SWEEP_MS) || 60 * 60 * 1000; // 1h

let renewalTimer = null;

async function runRenewalSweep() {
  try {
    const due = await subscriptionService.findDueRenewals(50);
    if (due.length) console.log(`[billingSweeper] 갱신 대상 ${due.length}건 처리`);
    for (const sub of due) {
      try {
        const r = await subscriptionService.chargeRenewal(sub);
        console.log(`[billingSweeper] 구독 #${sub.id} 갱신:`, r.status);
      } catch (e) {
        console.error(`[billingSweeper] 구독 #${sub.id} 갱신 실패:`, e.message);
      }
    }
  } catch (e) {
    console.error('[billingSweeper] 갱신 스윕 오류:', e.message);
  }
}

function start() {
  if (renewalTimer) return;
  renewalTimer = setInterval(runRenewalSweep, RENEWAL_INTERVAL_MS);
  renewalTimer.unref?.();
  console.log('[billingSweeper] 시작 (구독 갱신 1h)');
}

function stop() {
  if (renewalTimer) clearInterval(renewalTimer);
  renewalTimer = null;
}

module.exports = { start, stop, runRenewalSweep };
