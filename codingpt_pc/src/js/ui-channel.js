// ui-channel.js — 백엔드 UI 실시간 채널(WS). 알림 이벤트(notif_event)를 수신해 상태에 반영한다.
//  · 접속 URL(티켓 포함)은 Rust(ui_stream_url)가 발급 — deviceToken 은 JS 로 노출하지 않는다.
//  · 끊기면 3~10s 백오프로 재접속(티켓 재발급). 재접속 성공 시 목록 재로드로 놓친 이벤트 보충.
//  · P3 에서 ui_command 원격 조작 디스패처가 여기 추가될 예정 → 메시지 타입 스위치 구조 유지.
import { api } from "./api.js";
import * as S from "./state.js";

let sock = null;
let retryMs = 3000;
let retryTimer = null;

export function startUiChannel() {
  connect();
}

async function connect() {
  clearTimeout(retryTimer);
  let url = null;
  try {
    url = await api.uiStreamUrl();
  } catch (_) {
    return scheduleRetry(); // 미페어링/서버 미가용 — 로컬 폴백으로 동작 유지
  }
  if (!url) return scheduleRetry();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (_) {
    return scheduleRetry();
  }
  sock = ws;
  ws.onopen = () => {
    retryMs = 3000;
    S.loadNotifications(); // 끊긴 사이 놓친 알림 보충(재접속 시에도)
  };
  ws.onmessage = (e) => {
    let msg = null;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "notif_event":
        if (msg.event) S.applyNotifEvent(msg.event);
        break;
      // case "ui_command": — P3 원격 UI 조작 디스패처 예정
      default:
        break;
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  ws.onclose = () => {
    if (sock === ws) {
      sock = null;
      scheduleRetry();
    }
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const wait = retryMs;
  retryMs = Math.min(10000, Math.round(retryMs * 1.6));
  retryTimer = setTimeout(connect, wait);
}
