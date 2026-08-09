// term-host 클라이언트 — win32 터미널 세션 호스트(tmux 등가물, 포팅 계약 1)의 named pipe NDJSON 프로토콜.
//  정본: codingpt_daemon/packages/term-host/lib/server.js (프로토콜) · lib/paths.js (파이프 경로 유도).
//
//  · 파이프: \\.\pipe\cpt-termhost-<sha256(homedir) 앞 8자>. env CPT_TERMHOST_SOCK 있으면 우선
//    (term-backend 가 스폰 시 같은 값을 호스트에 전달 — 유도 규칙이 어긋나면 유령 호스트를 본다).
//  · 단발 op(접속당 1건): {id,op,...} 1줄 → {id,ok,...} 1줄 후 종료(term-backend request 관례 미러).
//  · attach: {id,op:"attach",name,cols,rows} 1줄 → {id,ok:true,...} 응답 후 그 커넥션은 양방향 스트림.
//    서버→클라 {t:"o",d:<b64>}(첫 프레임=전체 리페인트)·{t:"x",code}·{t:"bell"},
//    클라→서버 {t:"i",d:<b64>}·{t:"r",cols,rows}(latest wins).
//
//  프레이밍(인코딩/디코딩)은 순수 함수로 분리해 mac 에서도 컴파일·유닛테스트한다(설계 검증 전략 1).
//  커넥션(named pipe 파일 핸들)만 win32 전용 — cptsock.rs cpt_connect 의 ERROR_PIPE_BUSY(231)
//  재시도 패턴을 미러한다(cptsock.rs 는 타 스트림 산출물이라 무수정 — 추출 대신 규칙 복제, 동작 동일).

use base64::Engine;
use serde_json::Value;

// ── 오류 모델 ────────────────────────────────────────────────────────────────
//  NotRunning = 파이프 부재(호스트 미기동) — tmux "no server running" 등가. 목록은 빈 결과,
//  kill 은 멱등 성공으로 흡수할 수 있게 오류 종류를 구분해 돌려준다(문자열 매칭 금지).
#[derive(Debug)]
pub enum ThError {
    /// 호스트 미기동(파이프 없음) — tmux 서버 부재와 같은 의미론으로 처리한다.
    NotRunning(String),
    /// 전송/파싱 등 프로토콜 계층 실패.
    Proto(String),
    /// 서버가 ok:false 로 응답 — code 는 server.js 의 오류 코드(NO_SESSION/DUPLICATE_SESSION/…).
    Op { code: String, msg: String },
}

impl ThError {
    pub fn message(&self) -> String {
        match self {
            ThError::NotRunning(m) => m.clone(),
            ThError::Proto(m) => m.clone(),
            ThError::Op { msg, .. } => msg.clone(),
        }
    }
}

// ── NDJSON 프레이밍(순수 함수 — 플랫폼 중립) ────────────────────────────────

/// 단발 op 요청 1줄. args 는 object 여야 하며 id/op 를 병합한다(서버 {id,op,...} 계약).
pub fn op_line(id: u64, op: &str, args: Value) -> String {
    let mut obj = match args {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert("id".into(), Value::from(id));
    obj.insert("op".into(), Value::from(op));
    let mut s = Value::Object(obj).to_string();
    s.push('\n');
    s
}

/// attach 핸드셰이크 1줄 — 접속 크기(cols/rows)가 곧 latest(서버가 응답 직후 resize).
pub fn attach_line(id: u64, name: &str, cols: u16, rows: u16) -> String {
    op_line(id, "attach", serde_json::json!({ "name": name, "cols": cols, "rows": rows }))
}

/// 입력 프레임(클라→서버) — 원시 바이트를 base64 로 실은 {t:"i",d}.
pub fn input_frame(data: &[u8]) -> String {
    let d = base64::engine::general_purpose::STANDARD.encode(data);
    let mut s = serde_json::json!({ "t": "i", "d": d }).to_string();
    s.push('\n');
    s
}

/// 리사이즈 프레임(클라→서버) — latest wins(window-size latest 등가). pty_claim 의 nudge 등가는
///  이 프레임 1회다(서버 session.resize 가 같은 크기면 no-op — 이미 내 크기면 저절로 조용하다).
pub fn resize_frame(cols: u16, rows: u16) -> String {
    let mut s = serde_json::json!({ "t": "r", "cols": cols, "rows": rows }).to_string();
    s.push('\n');
    s
}

/// 단발 op / attach 핸드셰이크 응답 1줄 파싱 — ok:true 면 전체 객체, ok:false 면 Op{code,msg}.
pub fn parse_op_response(line: &str) -> Result<Value, ThError> {
    let v: Value = serde_json::from_str(line.trim())
        .map_err(|e| ThError::Proto(format!("term-host 응답 파싱 실패: {e}")))?;
    if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        Ok(v)
    } else {
        Err(ThError::Op {
            code: v.get("code").and_then(|c| c.as_str()).unwrap_or("ERROR").to_string(),
            msg: v.get("error").and_then(|e| e.as_str()).unwrap_or("term-host 오류").to_string(),
        })
    }
}

/// attach 스트림 프레임(서버→클라).
#[derive(Debug, PartialEq)]
pub enum Frame {
    /// 출력 — d 는 base64 원문 그대로(pty://data 의 b64 와 같은 표현이라 재인코딩 없이 통과).
    Output(String),
    Exit(i32),
    Bell,
    /// 알 수 없는/무관 프레임(전방 호환 — 조용히 스킵).
    Other,
}

pub fn parse_stream_line(line: &str) -> Option<Frame> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    let v: Value = serde_json::from_str(t).ok()?;
    match v.get("t").and_then(|x| x.as_str()) {
        Some("o") => Some(Frame::Output(v.get("d").and_then(|d| d.as_str()).unwrap_or("").to_string())),
        Some("x") => Some(Frame::Exit(v.get("code").and_then(|c| c.as_i64()).unwrap_or(0) as i32)),
        Some("bell") => Some(Frame::Bell),
        Some(_) => Some(Frame::Other),
        None => Some(Frame::Other), // {id,ok,...} 등 스트림 외 프레임 — 무시 대상
    }
}

/// 출력 프레임 b64 디코드(테스트/필요 시) — 런타임 경로는 b64 통과라 쓰지 않는다.
#[allow(dead_code)]
pub fn decode_b64(d: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(d).ok()
}

// ── 커넥션(win32 전용 — named pipe 파일 핸들) ───────────────────────────────

#[cfg(windows)]
static REQ_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[cfg(windows)]
pub fn next_id() -> u64 {
    REQ_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

// 파이프 경로 — term-host lib/paths.pipePath 와 반드시 같은 규칙. env 오버라이드 우선.
#[cfg(windows)]
pub fn pipe_path() -> Result<String, String> {
    if let Ok(p) = std::env::var("CPT_TERMHOST_SOCK") {
        if !p.trim().is_empty() {
            return Ok(p);
        }
    }
    use sha2::Digest;
    let home = dirs::home_dir().ok_or_else(|| "홈 디렉토리를 찾을 수 없습니다.".to_string())?;
    let digest = sha2::Sha256::digest(home.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(r"\\.\pipe\cpt-termhost-{}", &hex[..8]))
}

// cpt 컨트롤 파이프 이름(계약 2 — 세션 env CPT_SOCK 값). cptsock.rs pipe_path 와 동일 유도이나
//  그 파일은 타 스트림 산출물이라 무수정 원칙 — 규칙만 미러(sha256(homedir) 앞 8자, 원문 해시).
#[cfg(windows)]
pub fn cpt_sock_name() -> Option<String> {
    use sha2::Digest;
    let home = dirs::home_dir()?;
    let digest = sha2::Sha256::digest(home.to_string_lossy().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Some(format!(r"\\.\pipe\codingpt-cpt-{}", &hex[..8]))
}

// 파이프 열기 — cptsock::cpt_connect 패턴 미러: 서버가 다음 파이프 인스턴스를 아직 안 걸어 둔
//  찰나는 ERROR_PIPE_BUSY(231) → 짧게 재시도. 파이프 부재(NotFound)는 NotRunning(호스트 미기동).
#[cfg(windows)]
pub fn connect() -> Result<std::fs::File, ThError> {
    let path = pipe_path().map_err(ThError::NotRunning)?;
    for _ in 0..20 {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(231) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ThError::NotRunning(format!(
                    "term-host 미기동(파이프 없음 — 데몬이 세션 호스트를 아직 안 띄움): {e}"
                )));
            }
            Err(e) => return Err(ThError::Proto(format!("term-host 파이프 연결 실패: {e}"))),
        }
    }
    Err(ThError::Proto("term-host 파이프 연결 실패: 파이프가 계속 사용 중입니다(ERROR_PIPE_BUSY).".into()))
}

// 단발 op 왕복 — 접속→요청 1줄→응답 1줄→종료(term-backend request/cpt-server one-shot 관례).
#[cfg(windows)]
pub fn oneshot(op: &str, args: Value) -> Result<Value, ThError> {
    use std::io::{BufRead, BufReader, Write};
    let mut stream = connect()?;
    let line = op_line(next_id(), op, args);
    stream
        .write_all(line.as_bytes())
        .map_err(|e| ThError::Proto(format!("term-host 요청 전송 실패(op={op}): {e}")))?;
    let mut reader = BufReader::new(stream);
    let mut resp = String::new();
    let n = reader
        .read_line(&mut resp)
        .map_err(|e| ThError::Proto(format!("term-host 응답 수신 실패(op={op}): {e}")))?;
    if n == 0 {
        return Err(ThError::Proto(format!("term-host 응답 없음(op={op})")));
    }
    parse_op_response(&resp)
}

// ── 유닛테스트(프레이밍 — mac cargo test 로 검증) ───────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_line_merges_id_and_op() {
        let s = op_line(7, "list", serde_json::json!({}));
        assert!(s.ends_with('\n'));
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["op"], "list");
    }

    #[test]
    fn attach_line_carries_size() {
        let s = attach_line(1, "cpt-ws--t-1234567", 120, 32);
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v["op"], "attach");
        assert_eq!(v["name"], "cpt-ws--t-1234567");
        assert_eq!(v["cols"], 120);
        assert_eq!(v["rows"], 32);
    }

    #[test]
    fn input_frame_is_node_compatible_b64() {
        // Node: Buffer.from('hi').toString('base64') === 'aGk='
        let s = input_frame(b"hi");
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v["t"], "i");
        assert_eq!(v["d"], "aGk=");
        // UTF-8 한글 왕복(모바일/PC 입력 경로의 실데이터 모양).
        let s2 = input_frame("한글\r".as_bytes());
        let v2: Value = serde_json::from_str(s2.trim()).unwrap();
        assert_eq!(decode_b64(v2["d"].as_str().unwrap()).unwrap(), "한글\r".as_bytes());
    }

    #[test]
    fn resize_frame_shape() {
        let v: Value = serde_json::from_str(resize_frame(81, 24).trim()).unwrap();
        assert_eq!(v["t"], "r");
        assert_eq!(v["cols"], 81);
        assert_eq!(v["rows"], 24);
    }

    #[test]
    fn parse_ok_response() {
        let v = parse_op_response("{\"id\":1,\"ok\":true,\"name\":\"s\",\"cols\":80,\"rows\":24}\n").unwrap();
        assert_eq!(v["name"], "s");
    }

    #[test]
    fn parse_err_response_keeps_code() {
        let e = parse_op_response("{\"id\":1,\"ok\":false,\"error\":\"세션이 없습니다: x\",\"code\":\"NO_SESSION\"}").unwrap_err();
        match e {
            ThError::Op { code, msg } => {
                assert_eq!(code, "NO_SESSION");
                assert!(msg.contains("세션이 없습니다"));
            }
            other => panic!("Op 이어야 함: {other:?}"),
        }
    }

    #[test]
    fn parse_garbage_is_proto_error() {
        assert!(matches!(parse_op_response("not-json"), Err(ThError::Proto(_))));
    }

    #[test]
    fn stream_frames_decode() {
        // 서버 session.js _broadcast 모양 그대로(o 는 b64 통과 — 재인코딩 없음).
        assert_eq!(
            parse_stream_line("{\"t\":\"o\",\"d\":\"aGk=\"}"),
            Some(Frame::Output("aGk=".to_string()))
        );
        assert_eq!(parse_stream_line("{\"t\":\"x\",\"code\":3}"), Some(Frame::Exit(3)));
        assert_eq!(parse_stream_line("{\"t\":\"x\"}"), Some(Frame::Exit(0)));
        assert_eq!(parse_stream_line("{\"t\":\"bell\"}"), Some(Frame::Bell));
        assert_eq!(parse_stream_line("{\"t\":\"??\"}"), Some(Frame::Other));
        assert_eq!(parse_stream_line("{\"id\":1,\"ok\":true}"), Some(Frame::Other));
        assert_eq!(parse_stream_line("   "), None);
        assert_eq!(parse_stream_line("broken{"), None);
    }
}
