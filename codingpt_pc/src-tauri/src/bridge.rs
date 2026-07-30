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

// ── 워크스페이스 목록 로컬 캐시(오프라인 부팅) ──────────────────────────────────
//  내 디스크의 폴더인데 목록이 서버에만 있어서, 서버가 죽으면 **로컬 폴더에 진입조차 못 했다**
//  (로컬 터미널/IDE 는 서버와 무관하게 멀쩡한데 사이드바가 비었다). 성공 응답을 파일로 남겨
//  실패 시 `stale:true` 를 실어 그대로 돌려준다 — UI 가 "오프라인(캐시)" 표시 + 서버 필수 조작 차단.
//
//  · 나이 상한 없음: 목적이 "서버 없이도 부팅"이므로 오래된 캐시도 목록으로는 유효하다.
//  · 무효화 = 지문(fp) 불일치. fp = (serverUrl, deviceToken) 해시 → 계정 전환·서버 전환·언페어 후
//    재페어링이면 옛 계정 목록이 절대 보이지 않는다. 암호 용도가 아니라 캐시 키 판별용이므로
//    의존성 없는 FNV-1a 로 충분(토큰 원문은 파일에 쓰지 않는다).
//  · 401/403(토큰 폐기·권한 박탈)은 캐시 폴백 금지 — 그건 "오프라인"이 아니라 "자격 상실"이다.
fn ws_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codingpt").join("pc-ws-cache.json"))
}

fn cache_fp(token: &str, server: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in server
        .as_bytes()
        .iter()
        .chain(b"|".iter())
        .chain(token.as_bytes().iter())
    {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ws_cache_save(token: &str, server: &str, data: &serde_json::Value) {
    let Some(p) = ws_cache_path() else { return };
    ws_cache_save_at(&p, token, server, data);
}

fn ws_cache_load(token: &str, server: &str) -> Option<serde_json::Value> {
    ws_cache_load_at(&ws_cache_path()?, token, server)
}

// 경로 주입형(단위 테스트가 홈을 건드리지 않고 검증할 수 있게).
fn ws_cache_save_at(p: &std::path::Path, token: &str, server: &str, data: &serde_json::Value) {
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "v": 1, "fp": cache_fp(token, server), "at": now_ms(), "data": data });
    if std::fs::write(p, body.to_string()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
        }
    }
}

// 캐시 → 원 응답 형태 + { stale:true, cachedAt }. 없거나 지문 불일치면 None.
fn ws_cache_load_at(p: &std::path::Path, token: &str, server: &str) -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    if v.get("fp").and_then(|x| x.as_str())? != cache_fp(token, server) {
        return None;
    }
    let at = v.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
    // back 응답은 배열일 수도, {workspaces:[…]} 일 수도 있다(JS 추출기가 둘 다 수용) — stale 플래그를
    //  실으려면 객체여야 하므로 배열은 { workspaces } 로 감싼다.
    let mut out = match v.get("data")?.clone() {
        serde_json::Value::Object(m) => serde_json::Value::Object(m),
        other => serde_json::json!({ "workspaces": other }),
    };
    if let Some(m) = out.as_object_mut() {
        m.insert("stale".into(), serde_json::Value::Bool(true));
        m.insert("cachedAt".into(), serde_json::json!(at));
    }
    Some(out)
}

// 백엔드 워크스페이스(클라우드+로컬) 목록 — deviceToken 인증. 응답은 data 직접 반환(성공 규약).
//  실패 시 last-known 캐시를 `stale:true` 로 반환(오프라인 부팅). 캐시도 없으면 기존대로 Err.
#[tauri::command]
pub fn fetch_workspaces() -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("페어링이 필요합니다.")?;
    let server = server_url();
    let url = format!("{}/api/daemon/workspaces", server.trim_end_matches('/'));
    let call = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .call();
    let err = match call {
        Ok(resp) => match resp.into_json::<serde_json::Value>() {
            Ok(v) => {
                ws_cache_save(&token, &server, &v);
                return Ok(v);
            }
            Err(e) => format!("응답 파싱 실패: {e}"),
        },
        // 자격 상실은 오프라인이 아니다 — 캐시로 옛 목록을 되살리지 않는다(로그인 게이트로 가야 함).
        Err(ureq::Error::Status(code, _)) if code == 401 || code == 403 => {
            return Err(format!("워크스페이스 조회 실패: HTTP {code}"));
        }
        Err(e) => format!("워크스페이스 조회 실패: {e}"),
    };
    match ws_cache_load(&token, &server) {
        Some(cached) => Ok(cached),
        None => Err(err),
    }
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

// 프리뷰 주소창 검색어 추천 — Google Suggest 공개 엔드포인트(무키·무인증).
//  브라우저가 아닌 네이티브 호출이라 CORS 무관. 반환 = 추천 검색어 문자열 배열.
#[tauri::command]
pub fn preview_suggest(q: String) -> Result<Vec<String>, String> {
    let s = q.trim();
    if s.is_empty() {
        return Ok(vec![]);
    }
    match ureq::get("https://suggestqueries.google.com/complete/search")
        .query("client", "firefox")
        .query("ie", "utf-8")
        .query("oe", "utf-8")
        .query("q", s)
        .timeout(std::time::Duration::from_secs(4))
        .call()
    {
        Ok(resp) => {
            let v: serde_json::Value = resp
                .into_json()
                .map_err(|e| format!("응답 파싱 실패: {e}"))?;
            Ok(v.get(1)
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default())
        }
        Err(e) => Err(format!("추천 조회 실패: {e}")),
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

// ── 외부 PC(다른 기기) 폴더 브라우징/워크스페이스 생성 — back 릴레이 fs API 를 hostDeviceId 로 라우팅 ──
//  (이 PC 로컬은 네이티브 폴더 다이얼로그를 쓰고, 원격 PC 만 이 경로로 컬럼 브라우저를 띄운다)
#[tauri::command]
pub fn remote_fs_list(path: String, host_device_id: Option<i64>) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let host_qs = match host_device_id {
        Some(h) => format!("&hostDeviceId={h}"),
        None => String::new(),
    };
    let url = format!(
        "{}/api/daemon/fs/list?path={}{}",
        server_url().trim_end_matches('/'),
        urlencoding_min(&path),
        host_qs
    );
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("폴더 조회 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

#[tauri::command]
pub fn remote_fs_mkdir(path: String, host_device_id: Option<i64>) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!("{}/api/daemon/fs/mkdir", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .send_json(ureq::json!({ "path": path, "hostDeviceId": host_device_id }))
        .map_err(|e| format!("폴더 생성 실패: {e}"))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("응답 파싱 실패: {e}"))
}

#[tauri::command]
pub fn remote_ws_create(path: String, host_device_id: Option<i64>) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    // 폴더명 = 워크스페이스명(홈-기준 상대경로의 마지막 구간). 빈 경로(홈)는 지정 불가.
    let clean = path.trim().trim_matches('/');
    if clean.is_empty() {
        return Err("홈 루트는 워크스페이스로 지정할 수 없어요.".into());
    }
    let name = clean.rsplit('/').next().unwrap_or(clean).to_string();
    // 로컬 워크스페이스 메타 등록 — hostDeviceId 로 그 외부 PC 에 귀속(폴더는 이미 존재).
    let url = format!("{}/api/daemon/workspaces", server_url().trim_end_matches('/'));
    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(20))
        .send_json(ureq::json!({ "name": name, "compute": "local", "localPath": clean, "hostDeviceId": host_device_id }))
        .map_err(|e| format!("워크스페이스 지정 실패: {e}"))?;
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

// 모양 설정(계정 전체 동기화) 저장 — deviceToken. 서버가 appearance_event 로 전 기기 팬아웃.
#[tauri::command]
pub fn update_appearance(appearance: serde_json::Value) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!("{}/api/daemon/me", server_url().trim_end_matches('/'));
    let resp = ureq::request("PATCH", &url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(10))
        .send_json(serde_json::json!({ "appearance": appearance }))
        .map_err(|e| format!("모양 설정 저장 실패: {e}"))?;
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

// 워크스페이스 삭제 — 서버 목록 메타만 삭제(로컬 폴더/파일은 절대 건드리지 않음). deviceToken.
#[tauri::command]
pub fn ws_delete(ws_id: String) -> Result<serde_json::Value, String> {
    let token = device_token().ok_or("로그인이 필요합니다.")?;
    let url = format!(
        "{}/api/daemon/workspaces/{}",
        server_url().trim_end_matches('/'),
        ws_id
    );
    let resp = ureq::request("DELETE", &url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("워크스페이스 삭제 실패: {e}"))?;
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

// macOS 개인정보 보호 설정(전체 디스크 접근) 열기 — 온보딩 폴더 권한 안내용.
//  open_external 은 http/https 만 허용하므로 시스템 설정 URL 은 전용 커맨드로.
#[tauri::command]
pub fn open_privacy_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // FDA 목록 등록 유도 — 보호 경로 접근을 시도해 두면 설정 목록에 앱이 나타나는 경우가
        //  많다(거부돼도 무해). 안 나타나면 사용자가 + 로 추가(셋업 힌트 안내).
        if let Some(h) = dirs::home_dir() {
            let _ = std::fs::read_dir(h.join("Library").join("Mail"));
            let _ = std::fs::metadata(h.join("Library").join("Application Support").join("com.apple.TCC").join("TCC.db"));
        }
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("설정 열기 실패: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

// 보호 폴더(다운로드/데스크탑/문서) 접근 프로브 — 최초 호출 시 macOS 허용 팝업이 뜨고(릴리스 .app),
//  이후엔 즉시 허용/거부가 판정된다. 한 번 허용되면 앱 단위 영구 → 모든 워크스페이스에서 유효.
//  read_dir 은 팝업 응답까지 블로킹되므로 spawn_blocking 으로 UI 를 막지 않는다.
#[tauri::command]
pub async fn probe_folder_access(folder: String) -> Result<bool, String> {
    let dir = {
        let h = dirs::home_dir().ok_or("홈 디렉토리를 찾을 수 없습니다.")?;
        match folder.as_str() {
            "downloads" => h.join("Downloads"),
            "desktop" => h.join("Desktop"),
            "documents" => h.join("Documents"),
            _ => return Err("지원하지 않는 폴더".into()),
        }
    };
    let granted = tauri::async_runtime::spawn_blocking(move || std::fs::read_dir(&dir).is_ok())
        .await
        .map_err(|e| format!("프로브 실패: {e}"))?;
    Ok(granted)
}

// '파일 및 폴더' 개인정보 설정 열기 — 팝업에서 거부한 뒤 다시 켤 때 안내용.
#[tauri::command]
pub fn open_files_privacy_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("설정 열기 실패: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

// 알림 권한 요청(온보딩) — 릴리스 .app 에선 macOS 허용 배너가 뜨고, 허용 여부를 돌려준다.
#[tauri::command]
pub fn notification_permission(app: AppHandle) -> bool {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let notif = app.notification();
    if matches!(notif.permission_state(), Ok(PermissionState::Granted)) {
        return true;
    }
    matches!(notif.request_permission(), Ok(PermissionState::Granted))
}

// 설정 화면은 열기만 해도 OS 권한 팝업을 띄우면 안 된다. 현재 상태만 읽는 별도 커맨드.
#[tauri::command]
pub fn notification_permission_state(app: AppHandle) -> String {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    match app.notification().permission_state() {
        Ok(PermissionState::Granted) => "granted",
        Ok(PermissionState::Denied) => "denied",
        Ok(PermissionState::Prompt) => "prompt",
        Ok(PermissionState::PromptWithRationale) => "prompt",
        _ => "unknown",
    }
    .into()
}

// 거부된 알림 권한은 앱에서 다시 요청해도 macOS가 팝업을 내지 않는다 → 앱별 설정으로 복구.
#[tauri::command]
pub fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // macOS 26 실측:
        //  · 일반 pane URL만 넘기면 CodingPT 행이 선택되지 않는다.
        //  · `open <url>`만 쓰면 성공(0)을 돌려도 CodingPT가 계속 frontmost라 사용자는 "안 열림"으로 본다.
        // 앱 bundle id를 쿼리에 싣고 System Settings를 명시한 뒤 전면 활성화한다.
        let url = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.ghmate.codingpt.pc";
        std::process::Command::new("/usr/bin/open")
            .args(["-b", "com.apple.systempreferences", url])
            .spawn()
            .map_err(|e| format!("알림 설정 열기 실패: {e}"))?;
        // `application id`는 표시 언어(System Settings/시스템 설정)에 무관하다.
        std::process::Command::new("/usr/bin/osascript")
            .args(["-e", "tell application id \"com.apple.systempreferences\" to activate"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("시스템 설정 활성화 실패: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

// 외부 브라우저로 URL 열기(프리뷰의 프레임 차단 사이트·웹검색용). http/https 만 허용.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("http/https URL 만 열 수 있습니다.".into());
    }
    // 절대경로 — PATH 에 open shim(cmux 등 터미널 멀티플렉서의 URL 가로채기)이 있으면
    //  브라우저 대신 그쪽 pane 으로 열린다(dev 실행 실측). 시스템 open 을 명시한다.
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("/usr/bin/open").arg(u).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", u]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(u).spawn();
    r.map(|_| ()).map_err(|e| format!("열기 실패: {e}"))
}

// 로컬 파일을 시스템 기본 앱으로 열기(채팅 첨부의 "원본 보기"). 존재하는 파일 절대경로만 —
//  URL/스킴/디렉토리를 막아 open_external(원격 URL)과 관심사를 분리한다.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err("존재하는 파일 절대경로만 열 수 있습니다.".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("/usr/bin/open").arg(p).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", ""]).arg(p).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(p).spawn();
    r.map(|_| ()).map_err(|e| format!("열기 실패: {e}"))
}

// NSData → Vec<u8> (macOS 클립보드 헬퍼).
#[cfg(target_os = "macos")]
unsafe fn nsdata_bytes(d: *mut objc2::runtime::AnyObject) -> Option<Vec<u8>> {
    use objc2::msg_send;
    if d.is_null() {
        return None;
    }
    let len: usize = msg_send![d, length];
    let ptr: *const u8 = msg_send![d, bytes];
    if len == 0 || ptr.is_null() {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr, len).to_vec())
}

// 클립보드의 파일 참조(Finder ⌘C/⌘X 등) → 절대경로 목록. 파일 참조가 없으면 빈 배열.
//  실측(2026-07-30): Finder 파일 복사는 NSPasteboard 에 public.file-url + NSFilenamesPboardType
//  (경로 NSArray)로 실린다 — 웹뷰 clipboardData 로는 경로가 안 나와 네이티브로 읽는다.
#[tauri::command]
pub fn clipboard_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        let pb: *mut AnyObject = msg_send![objc2::class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return Vec::new();
        }
        let t = NSString::from_str("NSFilenamesPboardType");
        let arr: *mut AnyObject = msg_send![pb, propertyListForType: &*t];
        if arr.is_null() {
            return Vec::new();
        }
        let is_arr: bool = msg_send![arr, isKindOfClass: objc2::class!(NSArray)];
        if !is_arr {
            return Vec::new();
        }
        let n: usize = msg_send![arr, count];
        let mut out = Vec::new();
        for i in 0..n.min(64) {
            let s: *mut AnyObject = msg_send![arr, objectAtIndex: i];
            if s.is_null() {
                continue;
            }
            let is_str: bool = msg_send![s, isKindOfClass: objc2::class!(NSString)];
            if is_str {
                out.push((*(s as *mut NSString)).to_string());
            }
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

// 클립보드의 이미지 데이터(스크린샷 ⌘⇧^4, 브라우저 이미지 복사 등) → 임시 PNG 파일로 저장 후
//  경로 반환. 이미지가 없으면 null. 파일 참조가 함께 있으면(=복사한 파일 — Finder 가 아이콘
//  이미지를 얹는 경우가 있다) 파일 쪽이 정본이므로 여기서는 무시한다.
#[tauri::command]
pub fn clipboard_image_png() -> Option<String> {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        if !clipboard_paths().is_empty() {
            return None;
        }
        let pb: *mut AnyObject = msg_send![objc2::class!(NSPasteboard), generalPasteboard];
        if pb.is_null() {
            return None;
        }
        let png_t = NSString::from_str("public.png");
        let d: *mut AnyObject = msg_send![pb, dataForType: &*png_t];
        let mut bytes = nsdata_bytes(d);
        if bytes.is_none() {
            // PNG 미제공 소스(일부 앱은 TIFF 만) — NSBitmapImageRep 으로 PNG 재인코딩.
            let tiff_t = NSString::from_str("public.tiff");
            let td: *mut AnyObject = msg_send![pb, dataForType: &*tiff_t];
            if !td.is_null() {
                let rep: *mut AnyObject =
                    msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: td];
                if !rep.is_null() {
                    let props: *mut AnyObject = msg_send![objc2::class!(NSDictionary), dictionary];
                    // 4 = NSBitmapImageFileTypePNG
                    let pd: *mut AnyObject =
                        msg_send![rep, representationUsingType: 4usize, properties: props];
                    bytes = nsdata_bytes(pd);
                }
            }
        }
        let bytes = bytes?;
        if bytes.len() > 64 * 1024 * 1024 {
            return None; // 비정상 크기 방어
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?;
        let p = std::env::temp_dir().join(format!(
            "cpt-paste-{}-{:06}.png",
            ts.as_secs(),
            ts.subsec_micros() % 1_000_000
        ));
        std::fs::write(&p, &bytes).ok()?;
        Some(p.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    None
}

// 수동 실측용 스모크(클립보드 상태 의존이라 CI 부적합 — 항상 ignored).
//  실행: 클립보드에 파일/이미지를 올린 뒤 `cargo test clipboard_smoke -- --ignored --nocapture`
#[cfg(all(test, target_os = "macos"))]
mod clipboard_tests {
    #[test]
    #[ignore]
    fn clipboard_smoke() {
        println!("paths: {:?}", super::clipboard_paths());
        println!("image: {:?}", super::clipboard_image_png());
    }
}

// 네이티브 알림(OSC/벨 → macOS 알림). 프론트 notifications.js 에서 호출.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String, sound: Option<String>) {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let notif = app.notification();
    // 권한 미허용이면 1회 요청 — tauri dev(비번들 바이너리)에선 배너가 안 뜰 수 있고,
    //  빌드된 .app 에선 이 요청으로 System Settings 알림 항목이 생성돼 배너가 표시된다.
    if !matches!(notif.permission_state(), Ok(PermissionState::Granted)) {
        let _ = notif.request_permission();
    }
    let mut builder = notif
        .builder()
        .title(if title.is_empty() { "CodingPT".into() } else { title })
        .body(body);
    // macOS 시스템 사운드 이름. none 은 builder 에 sound 를 싣지 않아 무음으로 보낸다.
    if let Some(name) = sound.filter(|s| !s.is_empty() && s != "none") {
        builder = builder.sound(name);
    }
    let _ = builder.show();
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
    timeout_secs: Option<u64>,
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
    .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(25).clamp(1, 900)));
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => r
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("응답 파싱 실패: {e}")),
        Err(ureq::Error::Status(code, r)) => {
            // back 의 errorResponse 는 분기용 구조화 코드를 `detail.code` 에 싣는다(utils/response.js).
            //  승인 409 는 ALREADY_RESOLVED / HOST_OFFLINE 두 의미가 같은 상태코드로 오므로,
            //  **한글 메시지 정규식으로 추측하면 문구가 바뀌는 순간 조용히 오분기**한다(approvalService.js
            //  :370 주석과 같은 함정). 그래서 코드가 있으면 문자열에 실어 JS 가 코드로 분기하게 한다.
            //  형식: `HTTP 409 ALREADY_RESOLVED: 이미 …` / 코드 없으면 기존 형식 그대로(하위호환).
            let body = r.into_json::<serde_json::Value>().ok();
            let msg = body
                .as_ref()
                .and_then(|v| v.get("message").and_then(|m| m.as_str().map(String::from)))
                .unwrap_or_default();
            let detail_code = body
                .as_ref()
                .and_then(|v| v.get("detail"))
                .and_then(|d| d.get("code"))
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .to_string();
            let head = if detail_code.is_empty() {
                format!("HTTP {code}")
            } else {
                format!("HTTP {code} {detail_code}")
            };
            if msg.is_empty() {
                Err(head)
            } else {
                Err(format!("{head}: {msg}"))
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

// ── 워크스페이스 목록 캐시 단위 테스트 ─────────────────────────────────────────
//  "서버가 죽어도 로컬 폴더에 진입할 수 있다"의 하부 계약을 고정한다. 홈(~/.codingpt)을 건드리지 않고
//  임시 경로로만 검증한다(사용자 실파일 오염 금지).
#[cfg(test)]
mod ws_cache_tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("cpt-wscache-{}-{}", std::process::id(), name));
        p.push("pc-ws-cache.json");
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn 왕복_stale_플래그와_권한() {
        let p = tmp("roundtrip");
        let data = serde_json::json!({ "workspaces": [{ "id": "w1", "localPath": "proj/a" }] });
        ws_cache_save_at(&p, "tok-1", "http://localhost:5300", &data);

        let got = ws_cache_load_at(&p, "tok-1", "http://localhost:5300").expect("캐시를 읽어야 한다");
        assert_eq!(got["workspaces"][0]["id"], "w1");
        assert_eq!(got["stale"], serde_json::json!(true), "UI 가 오프라인 표시/조작 차단을 하려면 stale 필수");
        assert!(got["cachedAt"].as_u64().unwrap_or(0) > 0);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "목록도 계정 정보다 — 0600");
        }
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 지문_불일치는_무효화() {
        let p = tmp("fp");
        let data = serde_json::json!({ "workspaces": [{ "id": "w1" }] });
        ws_cache_save_at(&p, "tok-1", "http://localhost:5300", &data);
        // 계정 전환(토큰 변경) — 옛 계정 목록이 절대 보이면 안 된다.
        assert!(ws_cache_load_at(&p, "tok-2", "http://localhost:5300").is_none());
        // 서버 전환(local ↔ prod)도 다른 캐시다.
        assert!(ws_cache_load_at(&p, "tok-1", "https://codingpt-back.ghmate.com").is_none());
        assert!(ws_cache_load_at(&p, "tok-1", "http://localhost:5300").is_some());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 배열_응답은_workspaces_로_감싼다() {
        let p = tmp("array");
        ws_cache_save_at(&p, "t", "s", &serde_json::json!([{ "id": "w9" }]));
        let got = ws_cache_load_at(&p, "t", "s").unwrap();
        assert_eq!(got["workspaces"][0]["id"], "w9");
        assert_eq!(got["stale"], serde_json::json!(true));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn 캐시_없음_또는_손상은_none() {
        let p = tmp("missing");
        assert!(ws_cache_load_at(&p, "t", "s").is_none());
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        std::fs::write(&p, "{not json").unwrap();
        assert!(ws_cache_load_at(&p, "t", "s").is_none(), "손상 캐시는 Err 로 떨어져야 한다");
        let _ = std::fs::remove_file(&p);
    }
}
