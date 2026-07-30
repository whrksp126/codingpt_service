// notification-prefs.js — 온보딩과 설정이 공유하는 데스크톱 알림 소리 설정.
// 기기 로컬 성격(OS 소리 선택)이므로 계정/서버가 아니라 localStorage 에 둔다.
import { api } from "./api.js";

const KEY = "cpt.notificationSound.v1";
export const NOTIFICATION_SOUNDS = [
  { value: "default", label: "시스템 기본값" },
  { value: "Glass", label: "Glass" },
  { value: "Ping", label: "Ping" },
  { value: "Pop", label: "Pop" },
  { value: "none", label: "소리 없음" },
];

export function getNotificationSound() {
  try {
    const value = localStorage.getItem(KEY) || "default";
    return NOTIFICATION_SOUNDS.some((o) => o.value === value) ? value : "default";
  } catch (_) {
    return "default";
  }
}

export function setNotificationSound(value) {
  const next = NOTIFICATION_SOUNDS.some((o) => o.value === value) ? value : "default";
  try { localStorage.setItem(KEY, next); } catch (_) {}
  return next;
}

export function soundOptionsHtml() {
  const current = getNotificationSound();
  return NOTIFICATION_SOUNDS.map((o) =>
    `<option value="${o.value}"${o.value === current ? " selected" : ""}>${o.label}</option>`
  ).join("");
}

export function bindSoundSelect(select) {
  if (!select) return;
  select.value = getNotificationSound();
  select.addEventListener("change", () => setNotificationSound(select.value));
}

export async function sendTestNotification() {
  const granted = await api.notifPermission();
  if (!granted) return false;
  await api.notify("CodingPT 테스트 알림", "에이전트가 작업을 마치면 이렇게 알려드려요.", getNotificationSound());
  return true;
}
