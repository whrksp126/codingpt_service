// notification-prefs.js — 온보딩과 설정이 공유하는 데스크톱 알림 소리 설정.
// 기기 로컬 성격(OS 소리 선택)이므로 계정/서버가 아니라 localStorage 에 둔다.
import { api } from "./api.js";
import { IS_WINDOWS } from "./path-utils.js";
import * as i18n from './i18n/index.js';

const KEY = "cpt.notificationSound.v1";
// Glass/Ping/Pop 은 macOS 시스템 사운드 이름이다 — win32 에는 존재하지 않아 목록에서 뺀다
//  (Windows 알림음은 OS 토스트 기본음 하나 = '시스템 기본값'/'소리 없음' 2택).
//  mac 값이 저장된 채 win32 로 오면 getNotificationSound 의 목록 검증이 'default' 로 떨어뜨린다.
export const NOTIFICATION_SOUNDS = IS_WINDOWS ? [
  { value: "default", label: "시스템 기본값" },
  { value: "none", label: "소리 없음" },
] : [
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
  await api.notify(i18n.t('CodingPT 테스트 알림'), i18n.t('에이전트가 작업을 마치면 이렇게 알려드려요.'), getNotificationSound());
  return true;
}

export async function refreshNotificationPermission() {
  return api.notifPermissionState().catch(() => "unknown");
}

// 시스템 설정으로 포커스가 넘어가기 전에 복귀 리스너를 먼저 건다. 사용자가 CodingPT로 돌아오면
// 바꾼 권한을 즉시 다시 읽어 경고/버튼을 갱신한다(재실행·수동 새로고침 불필요).
export async function openNotificationSettingsAndWatch(onState) {
  let active = true;
  let poll = null;
  let expiry = null;
  const cleanup = () => {
    if (!active) return;
    active = false;
    window.removeEventListener("focus", onFocus);
    if (poll) clearInterval(poll);
    if (expiry) clearTimeout(expiry);
  };
  const check = async () => {
    if (!active) return;
    const state = await refreshNotificationPermission();
    onState?.(state);
    if (state === "granted") cleanup();
  };
  const onFocus = () => {
    if (!active) return;
    setTimeout(check, 250);
  };
  window.addEventListener("focus", onFocus);
  try {
    await api.openNotificationSettings();
    // 시스템 설정이 전면에 있는 동안에도 실제 macOS 상태를 감시한다. ON 되는 순간 소리/테스트
    // 컨트롤을 열어 주며, 앱으로 돌아올 때까지 기다리지 않는다.
    poll = setInterval(check, 750);
    poll?.unref?.();
    expiry = setTimeout(cleanup, 5 * 60 * 1000);
    expiry?.unref?.(); // Node 계약 테스트의 event loop는 붙들지 않는다(브라우저에선 숫자라 no-op).
  } catch (e) {
    cleanup();
    throw e;
  }
}
