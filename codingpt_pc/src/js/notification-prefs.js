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

export async function refreshNotificationPermission() {
  return api.notifPermissionState().catch(() => "unknown");
}

// 시스템 설정으로 포커스가 넘어가기 전에 복귀 리스너를 먼저 건다. 사용자가 CodingPT로 돌아오면
// 바꾼 권한을 즉시 다시 읽어 경고/버튼을 갱신한다(재실행·수동 새로고침 불필요).
export async function openNotificationSettingsAndWatch(onState) {
  let active = true;
  const onFocus = () => {
    if (!active) return;
    active = false;
    window.removeEventListener("focus", onFocus);
    setTimeout(async () => onState?.(await refreshNotificationPermission()), 250);
  };
  window.addEventListener("focus", onFocus);
  try {
    await api.openNotificationSettings();
    // 돌아오지 않는 경우 리스너가 영구히 남지 않게 제한한다.
    const expiry = setTimeout(() => {
      if (!active) return;
      active = false;
      window.removeEventListener("focus", onFocus);
    }, 5 * 60 * 1000);
    expiry?.unref?.(); // Node 계약 테스트의 event loop는 붙들지 않는다(브라우저에선 숫자라 no-op).
  } catch (e) {
    active = false;
    window.removeEventListener("focus", onFocus);
    throw e;
  }
}
