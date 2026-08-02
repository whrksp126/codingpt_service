// cptsock — 사이드카 데몬의 cpt 컨트롤 소켓(~/.codingpt/cpt.sock, NDJSON one-shot) 클라이언트.
//  프리뷰 로컬 포트 포워더처럼 "리스너/소켓 수명이 데몬에 있어야 하는" 지시를 앱에서 보낼 때 쓴다
//  (앱 프로세스가 리스너를 직접 들면 앱 재시작마다 연결이 끊긴다 — 데몬이 수명 주인).
//  프로토콜: 요청 1줄 {id,cmd,args} → 응답 1줄 {id,ok,result|error} 후 서버가 소켓을 닫는다
//  (runner-core/cpt-server.js one-shot 규약 미러).

// 경로는 tmux.rs pool_env_args 와 동일 가정(~/.codingpt/cpt.sock — 홈 경로는 sun_path 한계 안).
fn sock_path() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".codingpt").join("cpt.sock"))
        .ok_or_else(|| "홈 디렉토리를 찾을 수 없습니다.".to_string())
}

// one-shot 요청/응답. ok:false 는 Err(error 메시지)로 승격 — 단, dispatch 가 정상 반환한
//  구조화 실패(예: forward.start 의 { ok:false, error:'EADDRINUSE' })는 result 로 그대로 전달된다.
fn cpt_request(cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    cpt_request_coded(cmd, args, false)
}

// with_code=true 면 데몬이 실은 `code`(cpt-server.js:1166 의 error 프레임 필드)를 에러 문자열 앞에
//  `<CODE>: ` 로 붙인다. 왜 문자열인가: tauri invoke 의 Err 타입이 String 이라 구조를 실을 자리가 없고,
//  이 리포에는 이미 같은 선례가 있다(bridge.rs back_api 의 `HTTP 409 ALREADY_RESOLVED: …`).
//  ★ 코드를 지우면 JS 가 **한글 문구 정규식**으로 분기하게 되고, 문구가 바뀌는 순간 조용히 오분기한다.
//   특히 봉투 RPC 는 "갱신하면 낫는 세대 불일치" 와 "구조적 미지원(10분 캐시)" 을 반드시 갈라야 한다
//   (계약 §2.7 자가복구 ③ — 세대 불일치를 캐시하면 갱신 후에도 10분간 전부 평문이 된다).
//  기존 호출부(forward/lan/sync)는 with_code=false 로 남겨 에러 문자열을 **한 글자도** 바꾸지 않는다.
fn cpt_request_coded(
    cmd: &str,
    args: serde_json::Value,
    with_code: bool,
) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let path = sock_path()?;
        let mut stream = UnixStream::connect(&path)
            .map_err(|e| format!("cpt.sock 연결 실패(데몬 미기동?): {e}"))?;
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
        let req = serde_json::json!({ "id": 1, "cmd": cmd, "args": args });
        let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .map_err(|e| format!("요청 전송 실패: {e}"))?;
        let mut reader = BufReader::new(stream);
        let mut resp = String::new();
        reader
            .read_line(&mut resp)
            .map_err(|e| format!("응답 수신 실패: {e}"))?;
        let v: serde_json::Value =
            serde_json::from_str(resp.trim()).map_err(|e| format!("응답 파싱 실패: {e}"))?;
        if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
            Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
        } else {
            let msg = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("cpt 명령 실패")
                .to_string();
            let code = v.get("code").and_then(|c| c.as_str()).unwrap_or_default();
            if with_code && !code.is_empty() {
                Err(format!("{code}: {msg}"))
            } else {
                Err(msg)
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (cmd, args, with_code);
        Err("이 플랫폼에서는 아직 지원되지 않습니다.".to_string())
    }
}

// 원격 프리뷰 로컬 포워더 기동 — 데몬이 127.0.0.1:<port> 리스너를 열고 back WS 로 파이프.
//  반환 result: { ok:true } | { ok:false, error:'EADDRINUSE'… } (JS 가 프록시 폴백 판단).
//
//  upstream(옵셔널, 기능4) — LAN 직결 좌표 { mode:'lan', host, lanPort, grantId, secret, clientKey,
//   kind, hostDeviceId, remotePort }. 주면 데몬이 **연결마다** 직결을 먼저 시도하고, 첫 바이트 전에
//   실패하면 버퍼를 승계해 그 연결만 릴레이(token)로 넘긴다 → 사용자 무자각 폴백.
//   token 은 upstream 이 있어도 **항상 함께 넘긴다**(릴레이가 폴백의 전제). 구 데몬은 이 필드를 무시한다.
#[tauri::command]
pub fn forward_start(
    port: u16,
    token: String,
    upstream: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut args = serde_json::json!({ "port": port, "token": token });
    if let Some(up) = upstream {
        if !up.is_null() {
            args["upstream"] = up;
        }
    }
    cpt_request("forward.start", args)
}

#[tauri::command]
pub fn forward_stop(port: u16) -> Result<serde_json::Value, String> {
    cpt_request("forward.stop", serde_json::json!({ "port": port }))
}

// ── LAN 직결(기능4) — 전부 사이드카 데몬에 위임한다 ──────────────────────────
//  왜 PC 앱이 LAN 클라이언트를 직접 만들지 않는가:
//   ① 리스너/소켓 수명이 앱 재시작을 넘어 살아야 한다(forward 가 이미 증명한 패턴).
//   ② grant secret 을 웹뷰 JS 에 절대 노출하지 않는다 — 데몬이 back 에서 직접 grant 를 받는다
//      (deviceToken 을 JS 에 주지 않는 것과 같은 이유).
//   ③ 모바일에만 자체 구현이 필요하고 PC 는 데몬 구현을 공짜로 재사용한다.
//  구 데몬(사이드카 스테일)에는 이 커맨드가 없어 Err 가 온다 → JS 가 조용히 릴레이로 폴백한다.

/// 대상 PC 로 직결이 되는지 왕복 측정. result: { ok:true, rttMs, endpoint } | { ok:false, code }
#[tauri::command]
pub fn lan_probe(host_device_id: i64) -> Result<serde_json::Value, String> {
    cpt_request("lan.probe", serde_json::json!({ "hostDeviceId": host_device_id }))
}

/// 이 PC ↔ 대상 PC 경로 상태 스냅샷(배지 표시용). result: { mode:'lan'|'relay'|…, … }
///  ※ 데몬이 이 커맨드를 아직 갖고 있지 않으면 Err — JS 는 **배지를 안 띄우는 것**으로 처리한다
///    (거짓 표시 금지). 기능 자체는 forward.start 의 upstream 으로 이미 동작한다.
#[tauri::command]
pub fn lan_status(host_device_id: i64) -> Result<serde_json::Value, String> {
    cpt_request("lan.status", serde_json::json!({ "hostDeviceId": host_device_id }))
}

/// 원격 fs 등 제어 RPC 1건을 LAN 으로 왕복. result: { ok:true, result } | { ok:false, code }
///  울타리: `fs.` / `net.` / `terminal.list` 처럼 읽기·편집에 필요한 메서드만 데몬이 scope 로 게이팅한다
///  (여기서 임의 메서드를 막지 않는 대신 **데몬이 grant scope 밖 메서드를 거부**한다 — 정책의 정본은 서버).
#[tauri::command]
pub fn lan_rpc(
    host_device_id: i64,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    cpt_request(
        "lan.rpc",
        serde_json::json!({ "hostDeviceId": host_device_id, "method": method, "params": params }),
    )
}

// 자동 체크포인트(작업 스냅샷) — 같은 머신인데 back → 제어 WS → 사이드카 데몬으로 돌아오던 왕복을
//  끊고 데몬에 직접 지시한다. 데몬이 back REST(begin/commit)를 직접 호출하고 번들·업로드는 백그라운드로
//  진행하므로 이 호출은 좌표 발급까지만 기다린다(반환 { accepted:true, checkpointId }).
//  구버전 사이드카/구 back 이면 Err → JS 가 기존 back_api 경로로 폴백한다.
#[tauri::command]
pub fn sync_checkpoint(
    ws_id: String,
    reason: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args = serde_json::json!({
        "workspaceId": ws_id,
        "reason": reason.unwrap_or_else(|| "periodic".to_string()),
    });
    if let Some(c) = cwd.filter(|s| !s.trim().is_empty()) {
        args["cwd"] = serde_json::Value::String(c);
    }
    cpt_request("sync.checkpoint", args)
}

// 종단간 암호화(기능2) — MK 가 필요한 연산은 전부 데몬이 수행한다(PC UI JS 에 마스터키를 주지 않는다).
//  울타리: `e2ee.` 접두사 명령만 통과시킨다. 프런트에 임의 cpt 명령 통로를 열면 웹뷰에서 실행되는
//  어떤 스크립트든 데몬 제어권을 갖게 되므로(deviceToken 을 JS 에 노출하지 않는 것과 같은 이유).
#[tauri::command]
//  ★ 실패는 데몬 코드를 실어 `<CODE>: <메시지>` 로 돌려준다(e2ee-fallback.js rpcFailCode 가 파싱).
//   E2EE_EPOCH_MISMATCH/E2EE_DECRYPT_FAILED(= 갱신하면 낫는다)와 E2EE_UNKNOWN_CMD/E2EE_UNSUPPORTED
//   (= 구조적 미지원, 10분 캐시)를 구분해야 하는데, 코드를 지우면 그 구분이 불가능하다.
pub fn e2ee_local(cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    if !cmd.starts_with("e2ee.") {
        return Err("허용되지 않은 명령입니다.".to_string());
    }
    cpt_request_coded(&cmd, args, true)
}

// 에이전트 관리(2026-07-27) — 이 PC 에 설치된 AI CLI 감지·배선·실행. 데몬이 단일 출처다.
//  울타리는 e2ee_local 과 동일한 이유·동일한 모양: `agents.` 접두사만 통과시킨다. 임의 cpt 명령
//  통로를 프런트에 열면 웹뷰에서 도는 어떤 스크립트든 데몬 제어권을 갖는다.
//  ⚠ 설치 명령 자체를 여기서 실행하지 않는다 — 설치는 **사용자가 보는 터미널에서** 돈다(그래서
//   무엇이 실행되는지 숨겨지지 않고, Ctrl+C 로 멈출 수 있다). 이 커맨드는 감지/배선/타이핑만 한다.
#[tauri::command]
pub fn agents_local(cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    if !cmd.starts_with("agents.") {
        return Err("허용되지 않은 명령입니다.".to_string());
    }
    cpt_request(&cmd, args)
}

// 에이전트 모드 즉시 확인(2026-08-02) — 이 PC 의 터미널은 **로컬 tmux 직결**이라 shift+tab 이
//  데몬 입력 경로를 지나가지 않는다(원격 기기 입력만 지나간다). 그래서 그 키를 보낼 때 이 커맨드로
//  데몬에 "지금 다시 봐"를 알린다 → 데몬이 그 터미널을 즉시 다시 읽어 **이 PC 와 폰의 알약이 함께**
//  갱신된다(3초 폴링 대기 없음). 조작이 아니라 재확인 신호라 인자도 (cwd, tid) 뿐이다.
#[tauri::command]
pub fn mode_poke(cwd: String, tid: i64) -> Result<serde_json::Value, String> {
    cpt_request("status.poke", serde_json::json!({ "cwd": cwd, "tid": tid }))
}

// ── 로컬 UI 채널(같은 기기 ui_command 왕복 제거) ─────────────────────────────────
//  터미널의 `cpt` → 로컬 데몬 → (지금까지) back WSS → 다시 이 앱. 같은 기기 안에서 서버를 왕복했다.
//  `ui.attach` 로 cpt.sock 커넥션을 유지하면 데몬이 이 앱에 직접 명령을 밀어 넣을 수 있다.
//  one-shot 헬퍼(cpt_request)로는 불가능하므로 전용 스레드 + 이벤트(cpt-local-ui) + 회신 커맨드로 구성한다.
//  데몬 재시작(업데이트·takeover)으로 소켓이 끊기면 2초 간격으로 재접속한다 — 이 루프가 없으면
//  "데몬 갱신 후 로컬 채널만 조용히 죽는" 상태가 된다.
#[cfg(unix)]
fn ui_writer() -> &'static std::sync::Mutex<Option<std::os::unix::net::UnixStream>> {
    static W: std::sync::OnceLock<std::sync::Mutex<Option<std::os::unix::net::UnixStream>>> =
        std::sync::OnceLock::new();
    W.get_or_init(|| std::sync::Mutex::new(None))
}

fn ui_attach_args() -> &'static std::sync::Mutex<serde_json::Value> {
    static A: std::sync::OnceLock<std::sync::Mutex<serde_json::Value>> = std::sync::OnceLock::new();
    A.get_or_init(|| std::sync::Mutex::new(serde_json::json!({})))
}

static UI_LOCAL_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// 채널 기동(멱등) — args = { clientKey, deviceId?, kind, foreground }.
#[tauri::command]
pub fn ui_local_start(app: tauri::AppHandle, args: serde_json::Value) -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Ok(mut g) = ui_attach_args().lock() {
            *g = args;
        }
        if UI_LOCAL_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(()); // 이미 재접속 루프가 돌고 있다(args 만 갱신)
        }
        std::thread::spawn(move || ui_local_loop(app));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (app, args);
        Err("이 플랫폼에서는 아직 지원되지 않습니다.".to_string())
    }
}

#[cfg(unix)]
fn ui_local_loop(app: tauri::AppHandle) {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use tauri::Emitter;
    loop {
        let path = match sock_path() {
            Ok(p) => p,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
        };
        let stream = match UnixStream::connect(&path) {
            Ok(s) => s,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_secs(2)); // 데몬 미기동/재기동 중
                continue;
            }
        };
        let mut wstream = match stream.try_clone() {
            Ok(w) => w,
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
        };
        let args = ui_attach_args()
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| serde_json::json!({}));
        let req = serde_json::json!({ "id": 1, "cmd": "ui.attach", "args": args });
        if wstream
            .write_all((req.to_string() + "\n").as_bytes())
            .is_err()
        {
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }
        if let Ok(mut g) = ui_writer().lock() {
            *g = Some(wstream);
        }
        // 읽기는 무한 블로킹(타임아웃 금지 — 명령은 언제 올지 모른다).
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(t) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // attach 응답({id,ok,result})은 무시하고 ui_command 프레임만 프런트로 올린다.
            if v.get("t").and_then(|x| x.as_str()) == Some("ui_command") {
                let _ = app.emit("cpt-local-ui", v);
            }
        }
        if let Ok(mut g) = ui_writer().lock() {
            *g = None;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

// 프런트 → 데몬 회신/신호({t:'ui_result',…} · {t:'presence',active}).
#[tauri::command]
pub fn ui_local_send(frame: serde_json::Value) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        let mut g = ui_writer().lock().map_err(|_| "채널 상태 오류".to_string())?;
        let s = g
            .as_mut()
            .ok_or_else(|| "로컬 UI 채널이 연결돼 있지 않습니다.".to_string())?;
        s.write_all((frame.to_string() + "\n").as_bytes())
            .map_err(|e| format!("전송 실패: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = frame;
        Err("이 플랫폼에서는 아직 지원되지 않습니다.".to_string())
    }
}
