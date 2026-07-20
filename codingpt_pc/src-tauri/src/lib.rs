// CodingPT for Mac/Windows — PC 데몬을 백그라운드로 구동하는 트레이(메뉴바) 앱.
//  · 번들된 Node 사이드카로 데몬(pair/run)을 돌린다(사용자 PC에 Node 불필요).
//  · 페어링 코드로 계정에 연결하고, 상시 실행하며, 트레이에서 상태/종료를 제공한다.
//  · 딥링크 codingpt-pc://pair?code=... 로 앱에서 원탭 연결한다.
//  이 앱은 어떤 AI 자격증명도 다루지 않는다 — 데몬(터미널/파일 릴레이) 부트스트랩 전용.

mod bridge;
mod fsapi;
mod preview;
mod pty;
mod tmux;

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

// 기본 서버 — 릴리스(배포)는 prod, dev(tauri dev = debug)는 로컬 백엔드. UI 서버 입력 없이도 dev 동작.
#[cfg(not(debug_assertions))]
const DEFAULT_SERVER: &str = "https://codingpt-back.ghmate.com";
#[cfg(debug_assertions)]
const DEFAULT_SERVER: &str = "http://localhost:5300";

// ── 데몬 생명주기 상태(Tauri managed state) ──────────────────────────
#[derive(Default)]
struct Daemon {
    child: Mutex<Option<Child>>, // run 프로세스 핸들
    should_run: Mutex<bool>,     // 감시 스레드 재시작 여부
}

// ── 앱 종료 가드 — IDE 미저장 변경 여부(JS 가 dirty 전이마다 set_ide_dirty 로 미러) ──
#[derive(Default)]
struct IdeDirty(std::sync::atomic::AtomicBool);

fn ide_dirty(app: &AppHandle) -> bool {
    app.try_state::<IdeDirty>()
        .map(|s| s.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

#[tauri::command]
fn set_ide_dirty(state: State<IdeDirty>, dirty: bool) {
    state.0.store(dirty, std::sync::atomic::Ordering::Relaxed);
}

// 실제 앱 버전(빌드 시 tauri.conf.json/Cargo 의 package version). 설정 정보 화면에 표시 —
//  과거 하드코딩 문자열이 업데이트돼도 안 바뀌던 버그(항상 0.1.4로 보임) 수정.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ── 자동 업데이트 — 순수 JS 프론트(번들러 없음)라 JS 플러그인 대신 Rust API 를 커맨드로 노출 ──
//  updater 는 번들된 앱(.app)에서만 동작(tauri dev 에선 항상 "미지원" 에러 → available:false 로 정규화).
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => Ok(serde_json::json!({
            "available": true,
            "version": u.version,
            "notes": u.body.clone().unwrap_or_default(),
        })),
        Ok(None) => Ok(serde_json::json!({ "available": false })),
        Err(e) => Ok(serde_json::json!({ "available": false, "error": e.to_string() })),
    }
}

// 다운로드+설치+재시작. 진행률은 cpt-update-progress 이벤트(받은 바이트/전체)로 프론트에 중계.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("이미 최신 버전입니다.")?;
    let handle = app.clone();
    // on_chunk 콜백의 chunk 는 "이번 조각의 바이트(델타)"라 그대로 total 로 나누면 언제나 ~0% 다
    //  (프론트가 chunk/total 로 계산 → 0 에서 안 올라가는 버그). 여기서 누적해 "받은 총 바이트"로 보낸다.
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let dl = downloaded.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let got = dl.fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed) + chunk as u64;
                let _ = handle.emit("cpt-update-progress", serde_json::json!({ "chunk": got, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // 데몬 자식 정리 후 재시작(고아 방지 — quit_app 과 동일 규율).
    if let Some(state) = app.try_state::<Daemon>() {
        *state.should_run.lock().unwrap() = false;
        if let Some(mut ch) = state.child.lock().unwrap().take() {
            let _ = ch.kill();
        }
    }
    app.restart();
}

// 가드 다이얼로그에서 "종료" 확정 — app.exit(0)=code Some 이라 ExitRequested 가드를 통과한다.
//  데몬 정리는 트레이 종료와 동일하게 인라인으로(RunEvent::Exit 정리만으로는 사이드카가 살아남는 것 실측).
#[tauri::command]
fn quit_app(app: AppHandle) {
    if let Some(state) = app.try_state::<Daemon>() {
        *state.should_run.lock().unwrap() = false;
        if let Some(mut ch) = state.child.lock().unwrap().take() {
            let _ = ch.kill();
        }
    }
    app.exit(0);
}

#[derive(Serialize, Clone)]
struct Status {
    paired: bool,
    running: bool,
    device_name: Option<String>,
    server: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: Option<i64>, // 내 호스트 판정(다른 PC 워크스페이스 구분)용
}

// ~/.codingpt/daemon.json (데몬이 pair 시 저장) 경로.
fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codingpt").join("daemon.json"))
}

fn read_config() -> Option<serde_json::Value> {
    let p = config_path()?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

// 페어링/웹로그인 서버 해석: 명시 인자 → daemon.json.serverUrl → DEFAULT_SERVER.
//  bridge::server_url(desktop_login_url 의 front 파생)과 같은 소스를 써야
//  "세션을 만든 서버"와 "브라우저로 여는 서버"가 반드시 일치한다(불일치=승인 코드 not found).
fn resolve_server(explicit: Option<String>) -> String {
    if let Some(s) = explicit.filter(|s| !s.trim().is_empty()) {
        return s;
    }
    read_config()
        .and_then(|c| c.get("serverUrl").and_then(|v| v.as_str().map(String::from)))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

fn is_paired() -> bool {
    read_config()
        .and_then(|c| c.get("deviceToken").and_then(|t| t.as_str().map(|s| !s.is_empty())))
        .unwrap_or(false)
}

// 번들된 사이드카 경로 해석: (node 바이너리, daemon 진입 스크립트).
//  bundle-sidecar.sh 가 resources/daemon/{node, app/node_modules/@codingpt/daemon/index.js} 로 배치.
//  Tauri resource_dir 아래 위치는 설정(bundle.resources)에 따라 daemon/ 또는 resources/daemon/ 이므로 후보를 탐색.
fn sidecar_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir 해석 실패: {e}"))?;
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let candidates = ["daemon", "resources/daemon", "_up_/daemon"];
    for c in candidates {
        let base = res.join(c);
        let node = base.join(node_name);
        let script = base
            .join("app")
            .join("node_modules")
            .join("@codingpt")
            .join("daemon")
            .join("index.js");
        if node.exists() && script.exists() {
            return Ok((node, script));
        }
    }
    Err(format!(
        "사이드카를 찾을 수 없습니다(resource_dir={}). bundle-sidecar.sh 실행 여부 확인.",
        res.display()
    ))
}

fn build_command(app: &AppHandle) -> Result<std::process::Command, String> {
    let (node, script) = sidecar_paths(app)?;
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(script);
    // 부모(Mac 화면)의 tmux 중첩 가드 회피 — 데몬은 전용 소켓(-L codingpt) 사용.
    cmd.env_remove("TMUX");
    // 번들 tmux(사이드카 base/tmux/bin/tmux)가 있으면 주입 → 데몬이 무설치 tmux 사용.
    if let Some(base) = node.parent() {
        let bundled_tmux = base.join("tmux").join("bin").join("tmux");
        if bundled_tmux.exists() {
            cmd.env("CODINGPT_TMUX", bundled_tmux);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(cmd)
}

// ── IPC 커맨드 ───────────────────────────────────────────────────────

// 현재 상태(페어링/실행/기기명/서버).
#[tauri::command]
fn daemon_status(state: State<Daemon>) -> Status {
    let running = {
        let mut guard = state.child.lock().unwrap();
        match guard.as_mut() {
            Some(ch) => match ch.try_wait() {
                Ok(Some(_)) => false, // 종료됨
                Ok(None) => true,     // 살아있음
                Err(_) => false,
            },
            None => false,
        }
    };
    let cfg = read_config();
    Status {
        paired: is_paired(),
        running,
        device_name: cfg
            .as_ref()
            .and_then(|c| c.get("deviceName").and_then(|v| v.as_str().map(String::from))),
        server: cfg
            .as_ref()
            .and_then(|c| c.get("serverUrl").and_then(|v| v.as_str().map(String::from))),
        device_id: cfg
            .as_ref()
            .and_then(|c| c.get("deviceId").and_then(|v| v.as_i64())),
    }
}

// 페어링 코드로 계정 연결(데몬 pair --code 비대화형 실행). 성공 시 run 시작.
#[tauri::command]
async fn daemon_pair(
    app: AppHandle,
    state: State<'_, Daemon>,
    code: String,
    server: Option<String>,
) -> Result<Status, String> {
    let server = resolve_server(server);
    let mut cmd = build_command(&app)?;
    cmd.arg("pair").arg("--code").arg(code.trim()).arg("--server").arg(&server);
    let out = cmd.output().map_err(|e| format!("데몬 실행 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = String::from_utf8_lossy(&out.stdout);
        return Err(format!("페어링 실패: {}", if !err.trim().is_empty() { err.trim() } else { msg.trim() }));
    }
    start_run(&app, &state)?;
    Ok(daemon_status(state))
}

// QR 페어링 1단계: 세션 생성 → { code, sessionSecret, deepLink, expiresAt } 반환(프론트가 QR 표시).
#[tauri::command]
async fn daemon_pair_session(
    app: AppHandle,
    server: Option<String>,
) -> Result<serde_json::Value, String> {
    let server = resolve_server(server);
    let mut cmd = build_command(&app)?;
    cmd.arg("pair-session").arg("--server").arg(&server);
    let out = cmd.output().map_err(|e| format!("데몬 실행 실패: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("세션 생성 실패: {}", stdout.trim()))?;
    if let Some(err) = v.get("error") {
        return Err(err.as_str().unwrap_or("세션 생성 실패").to_string());
    }
    Ok(v)
}

// QR 페어링 2단계(폴링 1회): claim. pending 이면 {pending:true}, 승인되면 config 저장 후 run 시작.
//  프론트가 이 커맨드를 주기적으로 호출(각 호출 one-shot).
#[tauri::command]
async fn daemon_pair_poll(
    app: AppHandle,
    state: State<'_, Daemon>,
    server: Option<String>,
    code: String,
    secret: String,
) -> Result<serde_json::Value, String> {
    let server = resolve_server(server);
    let mut cmd = build_command(&app)?;
    cmd.arg("pair-claim")
        .arg("--server").arg(&server)
        .arg("--code").arg(code.trim())
        .arg("--secret").arg(secret.trim());
    let out = cmd.output().map_err(|e| format!("데몬 실행 실패: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("연결 확인 실패: {}", stdout.trim()))?;
    if let Some(err) = v.get("error") {
        return Err(err.as_str().unwrap_or("연결 실패").to_string());
    }
    if v.get("paired").and_then(|b| b.as_bool()).unwrap_or(false) {
        // 재페어링 대응: 이미 떠 있는 데몬은 예전(무효) 토큰을 물고 있으므로, 반드시 죽였다가
        //  새로 띄워 갱신된 ~/.codingpt/daemon.json 토큰으로 릴레이에 재연결하게 한다.
        //  (기존엔 start_run 이 "이미 실행 중"이면 no-op → 새 토큰을 안 물고 계속 오프라인이던 버그)
        {
            let mut guard = state.child.lock().unwrap();
            if let Some(mut ch) = guard.take() {
                let _ = ch.kill();
                let _ = ch.wait();
            }
        }
        start_run(&app, &state)?;
    }
    Ok(v)
}

// run 데몬 시작(이미 실행 중이면 무시). 감시 스레드가 크래시 시 재시작.
fn start_run(app: &AppHandle, state: &State<Daemon>) -> Result<(), String> {
    if !is_paired() {
        return Err("페어링이 필요합니다.".into());
    }
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(ch) = guard.as_mut() {
            if matches!(ch.try_wait(), Ok(None)) {
                return Ok(()); // 이미 실행 중
            }
        }
        let mut cmd = build_command(app)?;
        cmd.arg("run");
        let child = cmd.spawn().map_err(|e| format!("데몬 run 실패: {e}"))?;
        *guard = Some(child);
    }
    *state.should_run.lock().unwrap() = true;
    let _ = app.emit("daemon-changed", ());
    Ok(())
}

#[tauri::command]
fn daemon_start(app: AppHandle, state: State<Daemon>) -> Result<Status, String> {
    start_run(&app, &state)?;
    Ok(daemon_status(state))
}

// run 중지(감시 재시작 끔 + 자식 kill).
#[tauri::command]
fn daemon_stop(app: AppHandle, state: State<Daemon>) -> Status {
    *state.should_run.lock().unwrap() = false;
    if let Some(mut ch) = state.child.lock().unwrap().take() {
        let _ = ch.kill();
        let _ = ch.wait();
    }
    let _ = app.emit("daemon-changed", ());
    daemon_status(state)
}

// 로컬 페어링 해제(데몬 unpair) + run 중지.
#[tauri::command]
fn daemon_unpair(app: AppHandle, state: State<Daemon>) -> Result<Status, String> {
    daemon_stop(app.clone(), state.clone());
    let mut cmd = build_command(&app)?;
    cmd.arg("unpair");
    let _ = cmd.output();
    Ok(daemon_status(state))
}

// 창 열기(트레이/딥링크/독 클릭에서) — 닫기가 NSApp hide 이므로 앱 unhide 부터.
fn show_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    { let _ = app.show(); }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// 딥링크 URL 처리: codingpt-pc://pair?code=XXXX[&server=YYY]
fn handle_deep_link(app: &AppHandle, url: &str) {
    let url = url.trim();
    if !url.starts_with("codingpt-pc://") {
        return;
    }
    // 매우 단순한 쿼리 파서(외부 crate 없이).
    let query = url.splitn(2, '?').nth(1).unwrap_or("");
    let mut code: Option<String> = None;
    let mut server: Option<String> = None;
    for kv in query.split('&') {
        let mut it = kv.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        let v = urldecode(v);
        match k {
            "code" => code = Some(v),
            "server" => server = Some(v),
            _ => {}
        }
    }
    show_window(app);
    if let Some(code) = code {
        // 프론트가 코드/서버를 받아 확인 후 daemon_pair 호출(사용자 가시 확인 유지).
        let _ = app.emit("deep-link-pair", serde_json::json!({ "code": code, "server": server }));
    }
}

// 최소 URL 디코드(%XX, + → space). 외부 crate 회피.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let h = |c: u8| -> Option<u8> {
                    match c {
                        b'0'..=b'9' => Some(c - b'0'),
                        b'a'..=b'f' => Some(c - b'a' + 10),
                        b'A'..=b'F' => Some(c - b'A' + 10),
                        _ => None,
                    }
                };
                if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                    out.push(a * 16 + b);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// 트레이 아이콘/메뉴 구성.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_i = MenuItem::with_id(app, "open", "CodingPT 열기", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &sep, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("CodingPT")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => {
                // 미저장 IDE 변경이 있으면 바로 끄지 않고 창을 띄워 확인(취소/종료) 받는다.
                if ide_dirty(app) {
                    show_window(app);
                    let _ = app.emit("cpt-quit-guard", "tray");
                    return;
                }
                // 종료 시 데몬도 함께 정리.
                if let Some(state) = app.try_state::<Daemon>() {
                    *state.should_run.lock().unwrap() = false;
                    if let Some(mut ch) = state.child.lock().unwrap().take() {
                        let _ = ch.kill();
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_window(tray.app_handle());
            }
        });
    // 메뉴바 트레이 아이콘: 흰 글리프(alpha=모양)를 템플릿 이미지로 지정 → macOS 라이트/다크
    //  메뉴바에 맞춰 자동 틴트. 앱/독 아이콘(초록)과 분리한다.
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => {
            builder = builder.icon(icon).icon_as_template(true);
        }
        Err(_) => {
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
        }
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 단일 인스턴스 + 딥링크(데스크톱): 두 번째 실행/URL 오픈을 기존 인스턴스로 라우팅.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_window(app);
            // 인자에 딥링크 URL 이 있으면 처리(Windows/Linux 경로).
            for a in args.iter() {
                if a.starts_with("codingpt-pc://") {
                    handle_deep_link(app, a);
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Daemon::default())
        .manage(IdeDirty::default())
        .manage(pty::PtyManager::default())
        .manage(preview::PreviewManager::default())
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            daemon_pair,
            daemon_pair_session,
            daemon_pair_poll,
            daemon_start,
            daemon_stop,
            daemon_unpair,
            // 터미널 pane (로컬 tmux)
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_claim,
            pty::pty_close,
            // tmux 제어(터미널=전용 세션/포트)
            tmux::tmux_list_windows,
            tmux::tmux_new_window,
            tmux::tmux_kill_window,
            tmux::tmux_listen_ports,
            // 브리지(워크스페이스/영속화/알림)
            bridge::fetch_workspaces,
            bridge::fetch_me,
            bridge::update_nickname,
            bridge::delete_account,
            bridge::revoke_device,
            bridge::fetch_devices,
            bridge::claim_workspace,
            bridge::remote_fs_list,
            bridge::remote_fs_mkdir,
            bridge::remote_ws_create,
            bridge::project_detach,
            bridge::devtools_window,
            bridge::project_attach,
            bridge::desktop_login_url,
            bridge::fetch_ws_session,
            bridge::save_ws_session,
            bridge::cloud_terminal_start,
            bridge::create_workspace,
            bridge::ui_state_load,
            bridge::ui_state_save,
            bridge::open_external,
            bridge::open_privacy_settings,
            bridge::notification_permission,
            bridge::probe_folder_access,
            bridge::open_files_privacy_settings,
            bridge::notify,
            // 앱 종료 가드(미저장 IDE 변경)
            set_ide_dirty,
            quit_app,
            // 자동 업데이트
            app_version,
            update_check,
            update_install,
            // 서버 동기화 알림 + UI 실시간 채널
            bridge::notif_list,
            bridge::notif_create,
            bridge::notif_read,
            bridge::notif_read_all,
            bridge::ui_stream_url,
            // 원격 PC fs/프리뷰(back 릴레이)
            bridge::back_api,
            bridge::back_base,
            // 프리뷰(네이티브 임베디드 webview)
            preview::preview_sync,
            preview::preview_navigate,
            preview::preview_control,
            preview::preview_info,
            preview::preview_eval,
            preview::preview_screenshot,
            preview::preview_close,
            // 내장 IDE 파일 접근
            fsapi::fs_tree,
            fsapi::path_exists,
            fsapi::fs_search,
            fsapi::fs_read,
            fsapi::fs_write,
            fsapi::fs_mkdir,
            fsapi::fs_create_file,
            fsapi::fs_rename,
            fsapi::fs_delete,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 풀 윈도우 앱: Dock 아이콘 표시(Regular). 메뉴바 트레이는 백그라운드 실행용으로 병행.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // tmux 컨텍스트(번들 tmux/conf) 해석 후 managed state 로. 고아 grouped view 세션 정리.
            let tmux_ctx = tmux::resolve_ctx(&handle);
            pty::sweep_views(&tmux_ctx);
            app.manage(tmux_ctx);

            setup_tray(&handle)?;

            // 런타임 딥링크(mac: 앱 실행 중 URL 오픈) 구독.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&h, url.as_str());
                    }
                });
            }

            // 이미 페어링돼 있으면 자동으로 run 시작.
            if is_paired() {
                if let Some(state) = app.try_state::<Daemon>() {
                    let _ = start_run(&handle, &state);
                }
            }

            // 자식 감시 스레드: should_run 인데 죽었으면 백오프 후 재시작.
            {
                let h = handle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let state = match h.try_state::<Daemon>() {
                        Some(s) => s,
                        None => continue,
                    };
                    let should = *state.should_run.lock().unwrap();
                    if !should {
                        continue;
                    }
                    let dead = {
                        let mut guard = state.child.lock().unwrap();
                        match guard.as_mut() {
                            Some(ch) => matches!(ch.try_wait(), Ok(Some(_))),
                            None => true,
                        }
                    };
                    if dead && is_paired() {
                        if let Ok(mut cmd) = build_command(&h) {
                            cmd.arg("run");
                            if let Ok(child) = cmd.spawn() {
                                *state.child.lock().unwrap() = Some(child);
                                let _ = h.emit("daemon-changed", ());
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 네이티브 창 포커스(NSWindow key 상태) → JS 로 emit. WKWebView 의 DOM blur/hasFocus 는 OS
            //  앱 전환(예: cmux)에 안 바뀌어 알림 present 판정이 틀어지므로, 신뢰 가능한 이 신호를 진실源으로 쓴다.
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    let _ = window.app_handle().emit("cpt-focus", *focused);
                }
            }
            // 창 닫기 = 숨김(앱은 트레이에 상주).
            //  macOS: windowShouldClose 콜백 안에서 window.hide()(orderOut)를 부르면 prevent_close 에도
            //  불구하고 창이 매니저에서 사라져(재표시 불가) 이후 트레이/독 '열기'가 무반응이 된다(실측).
            //  → 창 대신 앱 전체 숨김(NSApp hide)으로 대체 — 창은 살아 있고 show_window 가 복원한다.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    #[cfg(target_os = "macos")]
                    { let _ = window.app_handle().hide(); }
                    #[cfg(not(target_os = "macos"))]
                    { let _ = window.hide(); }
                } else {
                    // 보조 창(데브툴 dt-* 등)은 기존대로 창만 숨긴다.
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 독 아이콘 클릭(창 없음 상태) — macOS 표준 재열기. 이게 없으면 독 클릭이 무반응.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                show_window(app_handle);
            }
            // Cmd+Q 등 code 없는 종료 요청 — 미저장 IDE 변경이 있으면 막고 확인 다이얼로그로.
            //  (quit_app/트레이 확정 종료는 app.exit(0)=code Some 이라 여기 걸리지 않는다)
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() && ide_dirty(app_handle) {
                    api.prevent_exit();
                    show_window(app_handle);
                    let _ = app_handle.emit("cpt-quit-guard", "exit-request");
                    return;
                }
            }
            // 앱이 어떤 경로(Cmd+Q · 트레이 종료 · 시스템 종료)로 끝나도 데몬 자식을 정리(고아 방지).
            if let tauri::RunEvent::Exit = event {
                if let Some(pm) = app_handle.try_state::<preview::PreviewManager>() {
                    preview::close_all(&pm);
                }
                if let Some(state) = app_handle.try_state::<Daemon>() {
                    *state.should_run.lock().unwrap() = false;
                    if let Some(mut ch) = state.child.lock().unwrap().take() {
                        let _ = ch.kill();
                        let _ = ch.wait();
                    }
                }
                // grouped view 세션 정리(primary/window 는 폰과 공유하므로 보존).
                if let Some(ctx) = app_handle.try_state::<tmux::TmuxCtx>() {
                    pty::sweep_views(&ctx);
                }
            }
        });
}
