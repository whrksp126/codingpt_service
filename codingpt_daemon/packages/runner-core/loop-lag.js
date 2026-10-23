/**
 * 이벤트 루프 멈춤 기록 — 데몬이 붙들려 있던 순간을 <stateDir>/pc-ui.log 에 `[daemon] [stall]` 로 남긴다.
 *
 * 왜: PC 터미널 입력·출력은 데몬(로컬 터미널 리스너)을 지난다. 데몬 루프가 막히면 그동안 타이핑이
 *  밀렸다 몰아서 나온다. 2026-10-23 "1~5분마다 끊긴다" 재발 추적용 — 앱 쪽 기록(stall-monitor.js,
 *  lib.rs start_main_stall_watch)과 같은 파일·같은 형식이라 한 줄씩 시각으로 맞춰 볼 수 있다.
 * 비용: 200ms 타이머 하나(unref). 기록은 appendFile(비동기) — 기록이 루프를 다시 막지 않게.
 */
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const TICK_MS = 200;
const STALL_MS = 250;
const MAX_BYTES = 1_000_000; // 앱 applog 와 같은 상한(넘으면 앱이 리셋한다 — 여기선 넘을 때 쓰지 않는다)

let timer = null;
function start() {
  if (timer) return;
  let last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last - TICK_MS;
    last = now;
    if (gap < STALL_MS) return;
    const file = path.join(runtime.stateDir(), 'pc-ui.log');
    const d = new Date(now);
    const hh = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    fs.stat(file, (err, st) => {
      if (!err && st.size > MAX_BYTES) return;
      fs.appendFile(file, `${Math.floor(now / 1000)} ${hh} [daemon] [stall] loop ${gap}ms\n`, () => {});
    });
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start };
