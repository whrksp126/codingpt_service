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
            Err(v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("cpt 명령 실패")
                .to_string())
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (cmd, args);
        Err("이 플랫폼에서는 아직 지원되지 않습니다.".to_string())
    }
}

// 원격 프리뷰 로컬 포워더 기동 — 데몬이 127.0.0.1:<port> 리스너를 열고 back WS 로 파이프.
//  반환 result: { ok:true } | { ok:false, error:'EADDRINUSE'… } (JS 가 프록시 폴백 판단).
#[tauri::command]
pub fn forward_start(port: u16, token: String) -> Result<serde_json::Value, String> {
    cpt_request("forward.start", serde_json::json!({ "port": port, "token": token }))
}

#[tauri::command]
pub fn forward_stop(port: u16) -> Result<serde_json::Value, String> {
    cpt_request("forward.stop", serde_json::json!({ "port": port }))
}

// 종단간 암호화(기능2) — MK 가 필요한 연산은 전부 데몬이 수행한다(PC UI JS 에 마스터키를 주지 않는다).
//  울타리: `e2ee.` 접두사 명령만 통과시킨다. 프런트에 임의 cpt 명령 통로를 열면 웹뷰에서 실행되는
//  어떤 스크립트든 데몬 제어권을 갖게 되므로(deviceToken 을 JS 에 노출하지 않는 것과 같은 이유).
#[tauri::command]
pub fn e2ee_local(cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    if !cmd.starts_with("e2ee.") {
        return Err("허용되지 않은 명령입니다.".to_string());
    }
    cpt_request(&cmd, args)
}
