// 알림음 로컬 설정 + 테스트 알림 IPC 계약.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const calls = [];
const store = new Map();
const windowListeners = new Map();
let notificationState = null;
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "notification_permission") return true;
        if (cmd === "notification_permission_state") return notificationState;
        return null;
      },
    },
    event: { listen: async () => () => {} },
  },
  addEventListener: (name, fn) => windowListeners.set(name, fn),
  removeEventListener: (name, fn) => {
    if (windowListeners.get(name) === fn) windowListeners.delete(name);
  },
};

const prefs = await import("../src/js/notification-prefs.js");
let fail = 0;
const ok = (name, value) => {
  if (!value) fail += 1;
  console.log(`${value ? "PASS" : "FAIL"} ${name}`);
};

ok("기본 알림음 = system default", prefs.getNotificationSound() === "default");
prefs.setNotificationSound("Ping");
ok("선택한 알림음 영속", prefs.getNotificationSound() === "Ping");
prefs.setNotificationSound("unknown");
ok("모르는 알림음은 기본값으로", prefs.getNotificationSound() === "default");
prefs.setNotificationSound("none");
await prefs.sendTestNotification();
ok("테스트 전에 OS 권한 확인", calls[0]?.[0] === "notification_permission");
ok("테스트 알림에 현재 소리 설정 전달", calls[1]?.[0] === "notify" && calls[1]?.[1]?.sound === "none");
let returnedState = null;
await prefs.openNotificationSettingsAndWatch((value) => { returnedState = value; });
ok("시스템 설정 열기 IPC 호출", calls.some(([cmd]) => cmd === "open_notification_settings"));
windowListeners.get("focus")?.();
await new Promise((resolve) => setTimeout(resolve, 300));
ok("앱 복귀 시 OS 권한 다시 확인", calls.at(-1)?.[0] === "notification_permission_state");
ok("복귀 후 새 권한 상태를 화면에 전달", returnedState === null);
notificationState = "granted";
await new Promise((resolve) => setTimeout(resolve, 800));
ok("시스템 설정에서 ON 되면 앱 복귀 전에도 감지", returnedState === "granted");

// ── 알림 패널 본문 미리보기 스트립(notifications.js — api.js 를 import 해 node 에서 못 연다 → 함수만 오려 실행) ──
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ns = readFileSync(path.join(here, "../src/js/notifications.js"), "utf8");
  const cut = (a, b) => ns.slice(ns.indexOf(a), b ? ns.indexOf(b) : undefined);
  const src = cut("export function stripMarkdownPreview").replace(/export function/g, "function");
  const { stripMarkdownPreview } = new Function(`${src}; return { stripMarkdownPreview };`)();
  ok("코드펜스·백틱·링크 문법을 걷어낸다",
    stripMarkdownPreview("앞 `code` [링크](https://x.com) ```\nfence\n``` 뒤") === "앞 code 링크 뒤");
  ok("줄 중간의 `## ` 헤딩·인용·목록 기호도 걷어낸다(서버가 한 줄로 뭉갠다)",
    stripMarkdownPreview("완료 ## 제목 > 인용 - 항목 * 항목2") === "완료 제목 인용 항목 항목2");
  ok("볼드/이탤릭/취소선 기호를 걷어낸다",
    stripMarkdownPreview("**굵게** *기울임* ~~취소~~") === "굵게 기울임 취소");
}

if (fail) process.exit(1);
console.log("\nALL PASS");
