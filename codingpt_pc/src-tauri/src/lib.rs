// CodingPT for Mac/Windows — PC 데몬을 백그라운드로 구동하는 트레이(메뉴바) 앱.
//  · 번들된 Node 사이드카로 데몬(pair/run)을 돌린다(사용자 PC에 Node 불필요).
//  · 페어링 코드로 계정에 연결하고, 상시 실행하며, 트레이에서 상태/종료를 제공한다.
//  · 딥링크 codingpt-pc://pair?code=... 로 앱에서 원탭 연결한다.
//  이 앱은 어떤 AI 자격증명도 다루지 않는다 — 데몬(터미널/파일 릴레이) 부트스트랩 전용.

mod bridge;
mod cptsock;
mod fsapi;
mod preview;
mod pty;
// term-host 파이프 클라이언트(포팅 계약 1) — 프레이밍은 플랫폼 중립(유닛테스트), 커넥션만 win32.
//  mac 빌드에선 테스트 전용이라 dead_code 를 허용한다(런타임 사용처는 win32 pty/tmux 분기).
#[cfg_attr(not(windows), allow(dead_code))]
mod termhost;
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

// ── win32 Job Object — Child::kill() 은 직계 프로세스만 죽여 데몬의 자식(손자)이 고아로 남는다
//  (유닉스 프로세스 그룹 등가물이 없다). 스폰 직후 데몬을 KILL_ON_JOB_CLOSE Job 에 넣으면 앱이
//  어떤 경로로 죽어도(크래시 포함 — 핸들 소멸=Job 소멸) 트리가 함께 정리된다.
//  BREAKAWAY_OK 를 함께 켜는 이유: term-host(윈도우 세션 호스트, 포팅 계약 1)는 데몬이 죽어도
//  터미널이 살아야 하므로, 데몬이 CREATE_BREAKAWAY_FROM_JOB 으로 탈출시킬 길을 열어 둔다.
#[cfg(windows)]
mod winjob {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // Job 핸들 조작은 스레드 무관(커널 오브젝트) — raw pointer 필드 때문에 자동 유도만 막혀 있다.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(None, PCWSTR::null()).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                if SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .is_err()
                {
                    let _ = CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, child: &std::process::Child) {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                let _ = AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle() as _));
            }
        }

        // 잔여 트리 즉시 종료. TerminateJobObject 이후에도 Job 오브젝트는 유효 — 재스폰 자식을
        //  같은 Job 에 다시 assign 할 수 있다(재시작 감시 스레드가 이 성질에 의존).
        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

// ── 데몬 생명주기 상태(Tauri managed state) ──────────────────────────
#[derive(Default)]
struct Daemon {
    child: Mutex<Option<Child>>, // run 프로세스 핸들
    should_run: Mutex<bool>,     // 감시 스레드 재시작 여부
    #[cfg(windows)]
    job: Mutex<Option<winjob::Job>>, // win32 프로세스 트리 묶음(손자 고아 방지)
}

// 스폰 직후 데몬 자식을 Job 에 편입(win32). 비-win 은 no-op — 유닉스는 kill 이 충분하다
//  (데몬의 실작업 자식인 tmux 서버는 애초에 독립 생존이 계약이라 트리 정리 대상이 아니다).
fn attach_daemon_job(state: &Daemon, child: &Child) {
    #[cfg(windows)]
    {
        let mut g = state.job.lock().unwrap();
        if g.is_none() {
            *g = winjob::Job::new();
        }
        if let Some(job) = g.as_ref() {
            job.assign(child);
        }
    }
    #[cfg(not(windows))]
    let _ = (state, child);
}

// 데몬 kill 지점 공통 후처리 — win32 는 Job 을 종료해 손자까지 정리한다. 비-win no-op.
fn kill_daemon_tree(state: &Daemon) {
    #[cfg(windows)]
    if let Some(job) = state.job.lock().unwrap().as_ref() {
        job.terminate();
    }
    #[cfg(not(windows))]
    let _ = state;
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

// 프론트 진단 로그 → stderr + 파일. 터미널 탭 소거/편입 같은 상태 변화를 사후 추적할 수 있게 남긴다.
#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[ui] {msg}");
    applog(&format!("[ui] {msg}"));
}

// 진단 로그 파일 영속 — Finder 실행 앱은 stderr 가 유실돼 재발 시 부검이 불가하다(실사고).
//  ~/.codingpt/pc-ui.log 에 append, 1MB 초과 시 리셋. 실패는 조용히 무시(로깅이 앱을 방해 금지).
pub fn applog(msg: &str) {
    use std::io::Write;
    let Some(path) = dirs::home_dir().map(|h| h.join(".codingpt").join("pc-ui.log")) else { return };
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // KST(+9, DST 없음) 시:분:초 병기 — epoch 원값으로 정밀 대조.
    let (h, m, s) = (((ts + 9 * 3600) / 3600) % 24, (ts / 60) % 60, ts % 60);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{ts} {h:02}:{m:02}:{s:02} {msg}");
    }
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

// 다운로드가 끝나 **설치만 남은** 업데이트. 서명 검증까지 통과한 바이트를 메모리에 들고 있는다.
//
// 왜 분리하나: 우리 사용자는 원격 접속을 위해 PC 를 며칠씩 켜 둔다. 그래서 "발견→다운로드→설치→
// 재시작" 이 한 덩어리면 적용을 누르는 순간 몇 분이 통째로 묶이고, 그 시간이 무서워 아무도 안 누른다.
// 다운로드를 미리 끝내 두면 실제로 끊기는 구간이 십몇 초로 줄어 "조용한 순간에 조용히" 적용할 수 있다.
// 디스크가 아니라 메모리에 두는 이유 = 검증된 바이트를 그대로 설치하기 위함(파일로 내리면 검증 이후
// 교체 여지가 생긴다). 아티팩트는 ~51MB.
struct StagedUpdate {
    version: String,
    bytes: Vec<u8>,
    update: tauri_plugin_updater::Update,
}
#[derive(Default)]
struct PendingUpdate(std::sync::Mutex<Option<StagedUpdate>>);

fn staged_version(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<PendingUpdate>()?;
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|s| s.version.clone())
}

// 준비된 업데이트가 있으면 그 버전을 알려준다(없으면 null). 프론트의 적용 배너 판단용.
#[tauri::command]
fn update_staged(app: AppHandle) -> Option<String> {
    staged_version(&app)
}

// 다운로드만 수행하고 **설치는 하지 않는다**. 진행률은 cpt-update-progress 로 중계.
//  같은 버전이 이미 준비돼 있으면 즉시 반환(재다운로드 금지 — 주기 확인이 반복 호출한다).
#[tauri::command]
async fn update_download(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    if let Some(v) = staged_version(&app) {
        return Ok(serde_json::json!({ "version": v, "staged": true }));
    }
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
    let bytes = update
        .download(
            move |chunk, total| {
                let got = dl.fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed) + chunk as u64;
                let _ = handle.emit("cpt-update-progress", serde_json::json!({ "chunk": got, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.to_string();
    let size = bytes.len();
    if let Some(state) = app.try_state::<PendingUpdate>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(StagedUpdate { version: version.clone(), bytes, update });
        }
    }
    let _ = app.emit("cpt-update-staged", serde_json::json!({ "version": version, "bytes": size }));
    Ok(serde_json::json!({ "version": version, "staged": true, "bytes": size }))
}

// 설치+재시작. 준비된 바이트가 있으면 즉시(다운로드 없이), 없으면 지금 받아서 적용한다.
//  ※ 호출 전에 프론트가 "지금 끊어도 되는가" 를 판정한다(update-scheduler.js).
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let staged = app
        .try_state::<PendingUpdate>()
        .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
    let (version, bytes, update) = match staged {
        Some(s) => (s.version, s.bytes, s.update),
        None => {
            let updater = app.updater().map_err(|e| e.to_string())?;
            let update = updater
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or("이미 최신 버전입니다.")?;
            let handle = app.clone();
            let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let dl = downloaded.clone();
            let bytes = update
                .download(
                    move |chunk, total| {
                        let got = dl.fetch_add(chunk as u64, std::sync::atomic::Ordering::Relaxed) + chunk as u64;
                        let _ = handle.emit("cpt-update-progress", serde_json::json!({ "chunk": got, "total": total }));
                    },
                    || {},
                )
                .await
                .map_err(|e| e.to_string())?;
            let v = update.version.to_string();
            (v, bytes, update)
        }
    };
    authorize_app_update(&version);
    update.install(bytes).map_err(|e| {
        if let Some(fingerprint) = current_install_fingerprint() {
            write_install_state(&fingerprint, &app.package_info().version.to_string(), None);
        }
        e.to_string()
    })?;
    // 데몬 자식 정리 후 재시작(고아 방지 — quit_app 과 동일 규율).
    if let Some(state) = app.try_state::<Daemon>() {
        *state.should_run.lock().unwrap() = false;
        if let Some(mut ch) = state.child.lock().unwrap().take() {
            let _ = ch.kill();
        }
        kill_daemon_tree(&state);
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
        kill_daemon_tree(&state);
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

fn install_state_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codingpt").join("pc-install.json"))
}

// 앱 번들 삭제 후 DMG 재설치를 macOS가 알려주는 제거 훅은 없다. 대신 실행 파일 inode를 설치 지문으로
// 기록한다. 같은 앱의 재실행에서는 유지되고 Finder가 DMG에서 앱을 다시 복사하면 바뀐다.
// 자동 업데이트도 inode를 바꾸므로 update_install이 목표 버전을 먼저 승인해 두고 재시작한다.
#[cfg(unix)]
fn current_install_fingerprint() -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let exe = std::env::current_exe().ok()?;
    let m = std::fs::metadata(exe).ok()?;
    Some(format!("{}:{}:{}:{}", m.dev(), m.ino(), m.len(), m.mtime()))
}

#[cfg(not(unix))]
fn current_install_fingerprint() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let m = std::fs::metadata(exe).ok()?;
    let modified = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{modified}", m.len()))
}

fn write_install_state(fingerprint: &str, version: &str, authorized_version: Option<&str>) {
    let Some(path) = install_state_path() else { return };
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() { return }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::json!({
        "fingerprint": fingerprint,
        "version": version,
        "authorizedVersion": authorized_version,
    });
    if std::fs::write(&tmp, body.to_string()).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

fn authorize_app_update(version: &str) {
    let Some(fingerprint) = current_install_fingerprint() else { return };
    let current_version = install_state_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    write_install_state(&fingerprint, &current_version, Some(version));
}

#[cfg(not(debug_assertions))]
fn clear_local_account_credentials() {
    let Some(path) = config_path() else { return };
    let current = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let Some(current) = current else { return };
    let mut keep = serde_json::Map::new();
    for key in ["serverUrl", "workspaceRoot"] {
        if let Some(value) = current.get(key) {
            keep.insert(key.to_string(), value.clone());
        }
    }
    if keep.is_empty() {
        let _ = std::fs::remove_file(path);
    } else {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::Value::Object(keep).to_string()).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            // TODO(win32): %USERPROFILE%\.codingpt 하위라 기본 ACL 로 타 사용자 접근이 이미 막힌다.
            //  0600 등가의 명시 DACL(icacls /inheritance:r 상당)은 후속 하드닝으로.
            let _ = std::fs::rename(tmp, path);
        }
    }
    if let Some(home) = dirs::home_dir() {
        let _ = std::fs::remove_file(home.join(".codingpt").join("e2ee.json"));
        let _ = std::fs::remove_dir_all(home.join(".codingpt").join("e2ee-accounts"));
    }
}

#[cfg(not(debug_assertions))]
fn clear_install_onboarding_state() {
    // WebKit 저장 경로는 OS 버전에 따라 WebsiteData/Default/<origin>/...처럼 달라진다.
    // 네이티브에서 DB 경로를 추측해 지우지 않고, 다음 웹뷰가 자기 localStorage 키를 직접 정리하게 한다.
    if let Some(path) = dirs::home_dir().map(|h| h.join(".codingpt").join("reset-onboarding")) {
        let _ = std::fs::write(path, b"1");
    }
}

#[tauri::command]
fn consume_install_onboarding_reset() -> bool {
    let Some(path) = dirs::home_dir().map(|h| h.join(".codingpt").join("reset-onboarding")) else { return false };
    if !path.exists() { return false }
    std::fs::remove_file(path).is_ok()
}

#[allow(dead_code)] // debug 빌드에서는 실제 재설치 판정을 비활성화하지만 단위 테스트는 이 순수 규칙을 검증한다.
fn is_manual_reinstall(old_fingerprint: &str, fingerprint: &str, authorized_version: Option<&str>, version: &str) -> bool {
    old_fingerprint != fingerprint && authorized_version != Some(version)
}

// 최초 도입 실행은 기존 사용자를 로그아웃시키지 않고 지문만 등록한다. 이후 앱 번들이 바뀌었는데
// update_install이 그 버전을 승인하지 않았다면 수동 재설치이므로 계정 연결을 해제한다.
fn reconcile_app_install(_version: &str) {
    #[cfg(debug_assertions)]
    return;

    #[cfg(not(debug_assertions))]
    {
        let Some(fingerprint) = current_install_fingerprint() else { return };
        let previous = install_state_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let Some(previous) = previous else {
            // 설치 지문이 없는데 계정 자격은 남아 있다면 앱 번들만 삭제한 뒤 DMG로 다시 설치한 경우다.
            // 기능 도입 전 버전에서 넘어온 사용자도 한 번 로그아웃되지만, "앱 삭제 = 계정 연결 해제"라는
            // 명시적 제품 계약을 지키는 편이 이전 자격을 새 설치에 조용히 승계하는 것보다 안전하다.
            if is_paired() {
                clear_local_account_credentials();
                applog("신규 설치에서 잔존 계정 자격 감지 — 로컬 계정 연결 해제");
            }
            clear_install_onboarding_state();
            write_install_state(&fingerprint, _version, None);
            return;
        };
        let old_fingerprint = previous.get("fingerprint").and_then(|v| v.as_str()).unwrap_or("");
        let authorized_version = previous.get("authorizedVersion").and_then(|v| v.as_str());
        if is_manual_reinstall(old_fingerprint, &fingerprint, authorized_version, _version) {
            clear_local_account_credentials();
            clear_install_onboarding_state();
            applog("수동 앱 재설치 감지 — 로컬 계정 연결 해제");
        }
        write_install_state(&fingerprint, _version, None);
    }
}

#[cfg(test)]
mod install_tests {
    use super::is_manual_reinstall;

    #[test]
    fn same_bundle_keeps_account() {
        assert!(!is_manual_reinstall("fp-a", "fp-a", None, "0.1.193"));
    }

    #[test]
    fn updater_replacement_keeps_account() {
        assert!(!is_manual_reinstall("fp-a", "fp-b", Some("0.1.193"), "0.1.193"));
    }

    #[test]
    fn dmg_reinstall_clears_account() {
        assert!(is_manual_reinstall("fp-a", "fp-b", None, "0.1.193"));
        assert!(is_manual_reinstall("fp-a", "fp-b", Some("0.1.192"), "0.1.193"));
    }
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
    // 데몬이 서버에 신고할 버전 = **이 PC 앱의 버전**. 데몬은 사이드카로만 배포되어 앱 버전에
    // 종속인데, 자기 package.json(영구 0.1.0)을 보고해 왔다 — 전 사용자가 같은 값이라 "누가 어떤
    // 조합을 쓰는지"를 서버가 알 수 없었다(버전 스큐 진단 불가).
    cmd.env("CPT_APP_VERSION", app.package_info().version.to_string());
    // 번들 tmux(사이드카 base/tmux/bin/tmux)가 있으면 주입 → 데몬이 무설치 tmux 사용.
    //  win32 는 tmux 부재(세션 호스트 = term-host, 포팅 계약 1) — 주입하지 않는다.
    #[cfg(not(windows))]
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
        kill_daemon_tree(&state);
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
        attach_daemon_job(state, &child);
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
    kill_daemon_tree(&state);
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
    let settings_i = MenuItem::with_id(app, "settings", "설정…", true, None::<&str>)?;
    let update_i = MenuItem::with_id(app, "check_update", "업데이트 확인…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &settings_i, &update_i, &sep, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("CodingPT")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "settings" => {
                show_window(app);
                let _ = app.emit("cpt-open-settings", ());
            }
            "check_update" => {
                show_window(app);
                let _ = app.emit("cpt-check-update", ());
            }
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
                    kill_daemon_tree(&state);
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
    // 메뉴바 트레이 아이콘: macOS 는 흰 글리프(alpha=모양)를 템플릿 이미지로 지정 → 라이트/다크
    //  메뉴바에 맞춰 자동 틴트. 앱/독 아이콘(초록)과 분리한다.
    //  win32 는 템플릿 개념이 없어 흰 글리프가 라이트 작업표시줄에서 안 보인다 — 다크 원형 배지 위
    //  글리프(무채색, tray.png 에서 생성한 tray-win.png)를 쓴다.
    #[cfg(target_os = "macos")]
    let tray_bytes: &[u8] = include_bytes!("../icons/tray.png");
    #[cfg(not(target_os = "macos"))]
    let tray_bytes: &[u8] = include_bytes!("../icons/tray-win.png");
    match tauri::image::Image::from_bytes(tray_bytes) {
        Ok(icon) => {
            builder = builder.icon(icon);
            #[cfg(target_os = "macos")]
            {
                builder = builder.icon_as_template(true);
            }
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
        .manage(PendingUpdate::default())
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
            pty::pty_alive,
            pty::pty_close,
            debug_log,
            // tmux 제어(터미널=전용 세션/포트)
            tmux::tmux_list_windows,
            tmux::tmux_new_window,
            tmux::tmux_kill_window,
            // 브리지(워크스페이스/영속화/알림)
            bridge::fetch_workspaces,
            bridge::fetch_me,
            bridge::preview_suggest,
            bridge::update_nickname,
            bridge::update_appearance,
            bridge::delete_account,
            bridge::revoke_device,
            bridge::fetch_devices,
            bridge::fetch_ui_clients,
            bridge::claim_workspace,
            bridge::ws_delete,
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
            bridge::open_path,
            bridge::clipboard_paths,
            bridge::clipboard_image_png,
            bridge::open_privacy_settings,
            bridge::notification_permission,
            bridge::notification_permission_state,
            bridge::open_notification_settings,
            bridge::probe_folder_access,
            bridge::open_files_privacy_settings,
            bridge::notify,
            // 앱 종료 가드(미저장 IDE 변경)
            set_ide_dirty,
            quit_app,
            // 자동 업데이트
            app_version,
            update_check,
            update_download,
            update_staged,
            update_install,
            consume_install_onboarding_reset,
            // 서버 동기화 알림 + UI 실시간 채널
            bridge::notif_list,
            bridge::notif_create,
            bridge::notif_read,
            bridge::notif_read_all,
            bridge::ui_stream_url,
            // 원격 PC fs/프리뷰(back 릴레이)
            bridge::back_api,
            bridge::back_base,
            // 원격 프리뷰 로컬 포트 포워더(사이드카 데몬 cpt.sock 지시)
            cptsock::forward_start,
            cptsock::forward_stop,
            cptsock::e2ee_local,
            cptsock::agents_local,
            cptsock::ports_local,
            cptsock::review_local,
            cptsock::emulator_local,
            cptsock::mode_poke,
            cptsock::chat_local,
            // LAN 직결(기능4) — 데몬 위임(grant 는 데몬이 back 에서 직접 받는다)
            cptsock::lan_probe,
            cptsock::lan_status,
            cptsock::lan_rpc,
            cptsock::sync_checkpoint,
            cptsock::ui_local_start,
            cptsock::ui_local_send,
            // 프리뷰(네이티브 임베디드 webview)
            preview::preview_sync,
            preview::preview_navigate,
            preview::preview_control,
            preview::preview_info,
            preview::preview_eval,
            preview::preview_screenshot,
            preview::preview_cookies,
            preview::preview_set_cookies,
            preview::preview_close,
            preview::preview_shield,
            preview::preview_zoom,
            preview::window_set_bg,
            // 내장 IDE 파일 접근
            fsapi::fs_tree,
            fsapi::path_exists,
            fsapi::fs_search,
            fsapi::fs_read,
            fsapi::fs_abs,
            fsapi::fs_write,
            fsapi::fs_write_b64,
            fsapi::fs_read_b64,
            fsapi::file_preview_b64,
            fsapi::fs_mkdir,
            fsapi::fs_create_file,
            fsapi::fs_rename,
            fsapi::fs_delete,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            reconcile_app_install(&app.package_info().version.to_string());

            // 풀 윈도우 앱: Dock 아이콘 표시(Regular). 메뉴바 트레이는 백그라운드 실행용으로 병행.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // tmux 컨텍스트(번들 tmux/conf) 해석 후 managed state 로. 고아 grouped view 세션 정리.
            let tmux_ctx = tmux::resolve_ctx(&handle);
            pty::sweep_views(&tmux_ctx);
            app.manage(tmux_ctx);

            setup_tray(&handle)?;

            // 앱 메뉴 — Tauri 기본 메뉴의 Edit>실행취소/다시실행(⌘Z/⌘⇧Z)이 웹뷰 도달 전에
            //  가로채(performKeyEquivalent) IDE(CodeMirror)·터미널의 ⌘Z 처리를 막는다. Undo/Redo 를
            //  뺀 커스텀 메뉴로 교체 → ⌘Z 가 웹뷰로 전달돼 각 표면이 자체 실행취소를 처리한다.
            //  복사/붙여넣기/잘라내기/전체선택은 유지(웹뷰가 네이티브 항목에 의존).
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
                let app_m = Submenu::with_items(&handle, "CodingPT", true, &[
                    &P::about(&handle, None, None)?,
                    &P::separator(&handle)?,
                    &P::hide(&handle, None)?,
                    &P::hide_others(&handle, None)?,
                    &P::show_all(&handle, None)?,
                    &P::separator(&handle)?,
                    &P::quit(&handle, None)?,
                ])?;
                let edit_m = Submenu::with_items(&handle, "편집", true, &[
                    &P::cut(&handle, None)?,
                    &P::copy(&handle, None)?,
                    &P::paste(&handle, None)?,
                    &P::select_all(&handle, None)?,
                ])?;
                let win_m = Submenu::with_items(&handle, "윈도우", true, &[
                    &P::minimize(&handle, None)?,
                    &P::close_window(&handle, None)?,
                ])?;
                let menu = Menu::with_items(&handle, &[&app_m, &edit_m, &win_m])?;
                app.set_menu(menu)?;
            }

            // punch-through 설치 — 프리뷰(네이티브 웹뷰)를 앱 UI 아래에 깔고, 앱 웹뷰 투명 슬롯으로
            //  비추며 hitTest 로 이벤트를 라우팅(DOM 모달/메뉴가 자연히 프리뷰 위에 그려진다).
            preview::install_punch_through(&handle);

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
                                attach_daemon_job(&state, &child);
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
            // OS 파일 드래그앤드랍 → JS 포워딩("cpt-drag"). tauri://drag-* 는 창/웹뷰 타겟 한정
            //  emit 이라 프론트의 평범한 listen(target Any)이 못 받는다 — 여기서 전역 emit 으로 중계.
            //  position 은 물리 픽셀(웹뷰 좌상단 기준) — JS 가 devicePixelRatio 로 CSS px 환산.
            if let tauri::WindowEvent::DragDrop(evt) = event {
                if window.label() == "main" {
                    use tauri::DragDropEvent as D;
                    let payload = match evt {
                        D::Enter { paths, position } => {
                            serde_json::json!({ "kind": "enter", "paths": paths, "x": position.x, "y": position.y })
                        }
                        D::Over { position } => {
                            serde_json::json!({ "kind": "over", "x": position.x, "y": position.y })
                        }
                        D::Drop { paths, position } => {
                            serde_json::json!({ "kind": "drop", "paths": paths, "x": position.x, "y": position.y })
                        }
                        _ => serde_json::json!({ "kind": "leave" }), // Leave + non_exhaustive 미래 변형
                    };
                    let _ = window.app_handle().emit("cpt-drag", payload);
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
                    kill_daemon_tree(&state);
                }
                // grouped view 세션 정리(primary/window 는 폰과 공유하므로 보존).
                if let Some(ctx) = app_handle.try_state::<tmux::TmuxCtx>() {
                    pty::sweep_views(&ctx);
                }
            }
        });
}
