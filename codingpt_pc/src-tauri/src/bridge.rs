// 브리지 — 백엔드 워크스페이스 목록·클라우드 터미널 토큰(deviceToken 인증)과 UI 상태 영속화.
//  deviceToken 은 ~/.codingpt/daemon.json 에서만 읽고 JS 로 노출하지 않는다(HTTP 는 여기 Rust 에서).
//  프론트에는 워크스페이스 목록·임시 터미널 토큰 같은 결과만 넘긴다.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

// 릴리스=prod, dev(debug)=로컬 백엔드. lib.rs 와 동일 규칙.
#[cfg(not(debug_assertions))]
const DEFAULT_SERVER: &str = "https://codingpt-back.ghmate.com";
#[cfg(debug_assertions)]
const DEFAULT_SERVER: &str = "http://localhost:5300";

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

// 프로필(닉네임) 수정 — deviceToken.
#[tauri::command]
pub fn update_nickname(nickname: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!("{}/api/daemon/me", server_url().trim_end_matches('/'));
    let resp = ureq::request("PATCH", &url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(serde_json::json!({ "nickname": nickname }))
        .map_err(|e| format!("프로필 수정 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 회원 탈퇴(본인 계정 삭제) — deviceToken.
#[tauri::command]
pub fn delete_account() -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!("{}/api/daemon/account", server_url().trim_end_matches('/'));
    let resp = ureq::request("DELETE", &url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("회원 탈퇴 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 기기 삭제(revoke) — deviceToken.
#[tauri::command]
pub fn revoke_device(device_id: i64) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/devices/{}/revoke",
        server_url().trim_end_matches('/'),
        device_id
    );
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("기기 삭제 실패: {e}"))?;
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

// ── 서버 동기화 알림(deviceToken 인증 — HTTP 는 여기 Rust 에서, 토큰 JS 노출 금지) ──

// 알림 목록 조회 — data = { notifications:[...], unreadCount }.
#[tauri::command]
pub fn notif_list(limit: Option<u32>, before_id: Option<i64>) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let mut url = format!(
        "{}/api/notifications?limit={}",
        server_url().trim_end_matches('/'),
        limit.unwrap_or(50)
    );
    if let Some(b) = before_id {
        url.push_str(&format!("&beforeId={b}"));
    }
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("알림 목록 조회 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 알림 생성(OSC/벨 → 서버 기록) — data = 생성된 행.
#[tauri::command]
pub fn notif_create(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!("{}/api/notifications", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(payload)
        .map_err(|e| format!("알림 생성 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 알림 읽음 처리 — payload = {ids} | {scope:{cwd,win}} | {scope:{cwd,win:null}}.
#[tauri::command]
pub fn notif_read(payload: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!("{}/api/notifications/read", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(payload)
        .map_err(|e| format!("알림 읽음 처리 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 전체 읽음 처리 — data = {ids}.
#[tauri::command]
pub fn notif_read_all() -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let url = format!("{}/api/notifications/read-all", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(serde_json::json!({}))
        .map_err(|e| format!("전체 읽음 처리 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// UI 실시간 채널 접속 URL 발급 — 티켓(POST /api/daemon/ui/ticket)을 받아 완성된 ws URL 반환.
//  wsUrl 이 없으면 serverUrl 에서 조립: ws(s)://…/api/daemon/agent/stream?ticket=<t>&client=pc.
#[tauri::command]
pub fn ui_stream_url() -> Result<String, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let server = server_url();
    let url = format!("{}/api/daemon/ui/ticket", server.trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(serde_json::json!({}))
        .map_err(|e| format!("UI 채널 티켓 발급 실패: {e}"))?;
    let v = resp
        .into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))?;
    // 성공 규약(data 직접 반환)이지만 {data:{…}} 래핑도 방어적으로 허용.
    let obj = v.get("data").filter(|d| d.get("ticket").is_some()).unwrap_or(&v);
    let ticket = obj
        .get("ticket")
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("티켓 없음")?;
    let base = obj
        .get("wsUrl")
        .and_then(|u| u.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            format!(
                "{}/api/daemon/agent/stream",
                server
                    .trim_end_matches('/')
                    .replacen("https://", "wss://", 1)
                    .replacen("http://", "ws://", 1)
            )
        });
    // wsUrl 에 이미 ticket 쿼리가 있으면 그대로, 없으면 부착.
    if base.contains("ticket=") {
        return Ok(base);
    }
    let sep = if base.contains('?') { '&' } else { '?' };
    Ok(format!("{base}{sep}ticket={}&client=pc", urlencoding_min(ticket)))
}

#[derive(Serialize)]
pub struct CloudTerminal {
    pub token: String,
    #[serde(rename = "wsBase")]
    pub ws_base: String,
}

// 원격 터미널 토큰 발급(deviceToken 인증) — 프론트는 이 토큰으로 back 릴레이 WS 연결.
//  이 PC 의 로컬 워크스페이스는 이 경로를 안 탄다(로컬 tmux 직결). 사용처: 클라우드 +
//  **다른 PC(host_device_id 지정)의 워크스페이스**(멀티 PC — 활성 러너 무변경 직결).
#[tauri::command]
pub fn cloud_terminal_start(
    cwd: String,
    host_device_id: Option<i64>,
    pane_id: Option<String>,
) -> Result<CloudTerminal, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let server = server_url();
    let url = format!("{}/api/daemon/terminal/device-start", server.trim_end_matches('/'));
    // client — 기기 안정 키(pane 세션을 기기별 분리, tmux 크기 공유 방지). 내 deviceId 기반.
    let client = read_config()
        .and_then(|c| c.get("deviceId").and_then(|v| v.as_i64()))
        .map(|id| format!("pc-{id}"))
        .unwrap_or_else(|| "pc".into());
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({
            "cwd": cwd,
            "hostDeviceId": host_device_id,
            "paneId": pane_id.unwrap_or_default(),
            "client": client,
        }))
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
    // git remote(origin) — 프로젝트 자동 연결(다른 PC의 같은 저장소 사본 묶기) 보조 신호. 실패=빈 값.
    let remote_url = std::process::Command::new("git")
        .args(["-C", &abs.to_string_lossy(), "remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let url = format!("{}/api/daemon/workspaces", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "name": name, "compute": "local", "localPath": local_path, "remoteUrl": remote_url }))
        .map_err(|e| format!("워크스페이스 생성 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

// 프로젝트 그룹 수동 교정 — 분리(단독 프로젝트로) / 합치기(대상 워크스페이스의 프로젝트로).
#[tauri::command]
pub fn project_detach(ws_id: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}/project/detach",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("프로젝트 분리 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

#[tauri::command]
pub fn project_attach(ws_id: String, target_ws_id: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}/project/attach",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(ureq::json!({ "targetWorkspaceId": target_ws_id }))
        .map_err(|e| format!("프로젝트 합치기 실패: {e}"))?;
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
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let notif = app.notification();
    // 권한 미허용이면 1회 요청 — tauri dev(비번들 바이너리)에선 배너가 안 뜰 수 있고,
    //  빌드된 .app 에선 이 요청으로 System Settings 알림 항목이 생성돼 배너가 표시된다.
    if !matches!(notif.permission_state(), Ok(PermissionState::Granted)) {
        let _ = notif.request_permission();
    }
    let _ = notif
        .builder()
        .title(if title.is_empty() { "CodingPT".into() } else { title })
        .body(body)
        .show();
}

// ── 크롬 데브툴 별도 창(Undock) — devtools-frame.html?win=1 을 독립 WebviewWindow 로 ──
//  통신은 Tauri 이벤트(cpt-dt-out / cpt-dt-in-<pv>), 창 파괴 시 cpt-dt-closed 로 메인에 통지.
#[tauri::command]
pub fn devtools_window(app: AppHandle, pv: String, open: bool) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    // 라벨 안전화(허용: 영숫자/-/_)
    let safe: String = pv.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let label = format!("dt-{safe}");
    if !open {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
        return Ok(());
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = format!(
        "devtools-frame.html?ws=cpt&can_dock=true&win=1&pv={}",
        urlencoding_min(&pv)
    );
    let w = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("개발자 도구")
        .inner_size(1100.0, 720.0)
        .build()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    let pv2 = pv.clone();
    w.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            let _ = app2.emit("cpt-dt-closed", pv2.clone());
        }
    });
    Ok(())
}

// ── 범용 back REST(deviceToken) — 원격 PC 워크스페이스의 fs/프리뷰 릴레이 호출용 ──
//  /api/daemon/ 경로만 허용(최소 울타리). 성공 응답은 data 직접 반환 규약이라 JSON 그대로 넘긴다.
//  에러는 back 의 { message } 를 살려 "HTTP <code>: <message>" 로 전달(409=대상 데몬 오프라인 등).
#[tauri::command]
pub fn back_api(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    if !path.starts_with("/api/daemon/") {
        return Err("허용되지 않은 경로입니다.".into());
    }
    let url = format!("{}{}", server_url().trim_end_matches('/'), path);
    let req = match method.as_str() {
        "GET" => ureq::get(&url),
        "POST" => ureq::post(&url),
        _ => return Err("허용되지 않은 메서드입니다.".into()),
    }
    .set("Authorization", &format!("Bearer {token}"))
    .timeout(std::time::Duration::from_secs(25));
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => r
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("응답 파싱 실패: {e}")),
        Err(ureq::Error::Status(code, r)) => {
            let msg = r
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str().map(String::from)))
                .unwrap_or_default();
            if msg.is_empty() {
                Err(format!("HTTP {code}"))
            } else {
                Err(format!("HTTP {code}: {msg}"))
            }
        }
        Err(e) => Err(format!("요청 실패: {e}")),
    }
}

// back 베이스 URL — 원격 프리뷰 프록시 절대 URL 조립용(JS 에는 토큰 없이 주소만).
#[tauri::command]
pub fn back_base() -> String {
    server_url().trim_end_matches('/').to_string()
}
