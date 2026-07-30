// 알림음 로컬 설정 + 테스트 알림 IPC 계약.
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

if (fail) process.exit(1);
console.log("\nALL PASS");
