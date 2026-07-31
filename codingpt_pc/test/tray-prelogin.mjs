import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const rust = read("src-tauri/src/lib.rs");
const main = read("src/js/main.js");
const gate = read("src/js/login-gate.js");
const settings = read("src/js/settings.js");
const api = read("src/js/api.js");
const html = read("src/index.html");

const checks = [
  ["트레이에 설정 메뉴가 있다", rust.includes('"settings", "설정…"')],
  ["트레이에 업데이트 확인 메뉴가 있다", rust.includes('"check_update", "업데이트 확인…"')],
  ["설정 메뉴가 프론트 이벤트를 보낸다", rust.includes('app.emit("cpt-open-settings"')],
  ["업데이트 메뉴가 프론트 이벤트를 보낸다", rust.includes('app.emit("cpt-check-update"')],
  ["프론트가 설정 이벤트를 구독한다", api.includes('listen("cpt-open-settings"') && main.includes('onOpenSettings(() => openSettingsSection("general"))')],
  ["프론트가 업데이트 이벤트를 앱 정보로 연결한다", api.includes('listen("cpt-check-update"') && main.includes('onCheckUpdate(() => openSettingsSection("about"))')],
  ["로그인 게이트가 설정 화면을 가리지 않는다", gate.includes('state.view === "settings"') && gate.includes('&& !utilitySettingsOpen')],
  ["앱 정보 화면에서 기존 업데이터를 그대로 쓴다", settings.includes('export function openSettingsSection') && /\.updateCheck\(\)/.test(settings) && settings.includes('api.updateInstall()')],
  ["로그인 여부와 무관하게 시작 시 자동 업데이트한다",
    main.includes("maybeInstallSetupUpdate")
      && main.includes("await api.updateInstall()")
      && !/async function maybeInstallSetupUpdate\(\)\s*\{\s*if \(state\.paired\) return;/.test(main)],
  ["자동 업데이트 실패는 온보딩을 막지 않는다", main.includes("hideSetupUpdate()") && gate.includes("최신 버전을 준비하고 있어요")],
  ["첫 페인트부터 부트스트랩 게이트가 화면을 가린다", html.includes('id="bootstrapGate"') && main.includes("finishBootstrap()")],
  ["초기 데이터와 권한을 모두 읽은 뒤 화면을 공개한다", main.includes("Promise.allSettled([S.loadWorkspaces(), S.loadMe()])") && main.includes("S.loadDevices()") && main.includes("api.notifPermissionState()")],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
if (failed) process.exit(1);
console.log("\nALL PASS");
