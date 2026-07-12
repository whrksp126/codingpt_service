// 브리지 — 백엔드 워크스페이스 목록·클라우드 터미널 토큰(deviceToken 인증)과 UI 상태 영속화.
//  deviceToken 은 ~/.codingpt/daemon.json 에서만 읽고 JS 로 노출하지 않는다(HTTP 는 여기 Rust 에서).
//  프론트에는 워크스페이스 목록·임시 터미널 토큰 같은 결과만 넘긴다.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

const DEFAULT_SERVER: &str = "https://codingpt-back.ghmate.com";

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codingpt").join("daemon.json"))
}

fn read_config() -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&s).ok()
}

fn device_token() -> Option<String> {
    read_config()?
        .get("deviceToken")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn server_url() -> String {
    read_config()
        .and_then(|c| c.get("serverUrl").and_then(|v| v.as_str().map(String::from)))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

// 백엔드 워크스페이스(클라우드+로컬) 목록 — deviceToken 인증. 응답은 data 직접 반환(성공 규약).
#[tauri::command]
pub fn fetch_workspaces() -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!("{}/api/daemon/workspaces", server_url().trim_end_matches('/'));
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("워크스페이스 조회 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 로그인된 계정 프로필(deviceToken 인증) — 설정 모달 "계정" 표시용. 미페어링이면 Ok(null).
#[tauri::command]
pub fn fetch_me() -> Result<Option<serde_json::Value>, String> {
    let token = match device_token() {
        Some(t) => t,
        None => return Ok(None),
    };
    let url = format!("{}/api/daemon/me", server_url().trim_end_matches('/'));
    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
    {
        Ok(resp) => resp
            .into_json::<serde_json::Value>()
            .map(Some)
            .map_err(|e| format!("응답 파싱 실패: {e}")),
        Err(ureq::Error::Status(401, _)) => Ok(None), // 토큰 폐기/무효 → 미로그인 취급
        Err(e) => Err(format!("계정 조회 실패: {e}")),
    }
}

// 계정의 모든 기기 목록(deviceToken) — 멀티기기 "내 기기". 미페어링이면 Ok(null).
#[tauri::command]
pub fn fetch_devices() -> Result<Option<serde_json::Value>, String> {
    let token = match device_token() {
        Some(t) => t,
        None => return Ok(None),
    };
    let url = format!("{}/api/daemon/devices", server_url().trim_end_matches('/'));
    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
    {
        Ok(resp) => resp
            .into_json::<serde_json::Value>()
            .map(Some)
            .map_err(|e| format!("응답 파싱 실패: {e}")),
        Err(ureq::Error::Status(401, _)) => Ok(None),
        Err(e) => Err(format!("기기 목록 조회 실패: {e}")),
    }
}

// 로컬 워크스페이스를 이 기기(호스트)에 귀속(백필/클레임).
#[tauri::command]
pub fn claim_workspace(ws_id: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}/claim",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("워크스페이스 귀속 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 데스크톱 웹 로그인 URL — 백엔드 서버 주소에서 프론트(codingpt.ghmate.com) 로 유도해 코드 부착.
//  prod: codingpt-back.ghmate.com → codingpt.ghmate.com / local: :5300 → :3400.
#[tauri::command]
pub fn desktop_login_url(code: String) -> String {
    let front = front_base();
    format!(
        "{}/desktop-login?code={}",
        front.trim_end_matches('/'),
        urlencoding_min(&code)
    )
}

fn front_base() -> String {
    // 명시적 override 우선(daemon.json.frontUrl), 없으면 서버 주소에서 파생.
    if let Some(f) = read_config()
        .and_then(|c| c.get("frontUrl").and_then(|v| v.as_str().map(String::from)))
        .filter(|s| !s.trim().is_empty())
    {
        return f;
    }
    let s = server_url();
    s.replace("-back.", ".")
        .replace(":5300", ":3400")
        .replace(":5100", ":3400")
}

// 최소 URL 인코딩(코드는 [A-Z0-9-] 뿐이라 사실상 그대로) — 의존성 없이 안전 처리.
fn urlencoding_min(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

// 워크스페이스 세션 상태 조회(deviceToken) — 이어받기. 없으면 { session: null }.
#[tauri::command]
pub fn fetch_ws_session(ws_id: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}/session",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("세션 조회 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 워크스페이스 세션 상태 저장(deviceToken) — 디바운스 푸시. updatedBy='pc'.
#[tauri::command]
pub fn save_ws_session(ws_id: String, session: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}/session",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::request("PUT", &url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "session": session, "updatedBy": "pc" }))
        .map_err(|e| format!("세션 저장 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

#[derive(Serialize)]
pub struct CloudTerminal {
    pub token: String,
    #[serde(rename = "wsBase")]
    pub ws_base: String,
}

// 클라우드 워크스페이스 터미널 토큰 발급(deviceToken 인증) — 프론트는 이 토큰으로 WS 연결.
//  로컬 워크스페이스는 이 경로를 안 탄다(로컬 tmux 직결).
#[tauri::command]
pub fn cloud_terminal_start(cwd: String) -> Result<CloudTerminal, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let server = server_url();
    let url = format!("{}/api/daemon/terminal/device-start", server.trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "cwd": cwd }))
        .map_err(|e| format!("터미널 시작 실패: {e}"))?;
    let v = resp
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))?;
    let tok = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or("토큰 없음")?
        .to_string();
    let ws_base = server
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    Ok(CloudTerminal { token: tok, ws_base })
}

// 새 로컬 워크스페이스 생성 — 폴더 절대경로 → 홈-상대 localPath 로 변환 후 백엔드에 등록(deviceToken).
//  홈 밖 경로는 거부(데몬 홈 jail 규율). 반환=생성된 워크스페이스 meta.
#[tauri::command]
pub fn create_workspace(abs_path: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let home = dirs::home_dir().ok_or("홈 디렉토리 해석 실패")?;
    let abs = std::path::PathBuf::from(abs_path.trim());
    let rel = abs
        .strip_prefix(&home)
        .map_err(|_| "홈 디렉토리 안의 폴더만 워크스페이스로 열 수 있어요.".to_string())?;
    let local_path = rel.to_string_lossy().trim_matches('/').to_string();
    if local_path.is_empty() {
        return Err("홈 루트는 워크스페이스로 열 수 없어요.".into());
    }
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| local_path.clone());
    let url = format!("{}/api/daemon/workspaces", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "name": name, "compute": "local", "localPath": local_path }))
        .map_err(|e| format!("워크스페이스 생성 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// ── UI 레이아웃 영속화 (~/.codingpt/pc-ui.json) ──

fn ui_state_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codingpt").join("pc-ui.json"))
}

#[tauri::command]
pub fn ui_state_load() -> Option<serde_json::Value> {
    let p = ui_state_path()?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

#[tauri::command]
pub fn ui_state_save(state: serde_json::Value) -> Result<(), String> {
    let p = ui_state_path().ok_or("경로 해석 실패")?;
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let s = serde_json::to_string_pretty(&state).map_err(|e| format!("{e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("저장 실패: {e}"))
}

// 외부 브라우저로 URL 열기(프리뷰의 프레임 차단 사이트·웹검색용). http/https 만 허용.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("http/https URL 만 열 수 있습니다.".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(u).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", u]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(u).spawn();
    r.map(|_| ()).map_err(|e| format!("열기 실패: {e}"))
}

// 네이티브 알림(OSC/벨 → macOS 알림). 프론트 notifications.js 에서 호출.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(if title.is_empty() { "CodingPT".into() } else { title })
        .body(body)
        .show();
}
