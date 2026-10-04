// stt.rs — 채팅 음성 입력. 번들 `cpt-stt`(native/cpt-stt.swift)를 자식으로 띄우고 그 표준출력(JSON 줄)을
//  웹뷰에 `cpt-stt` 이벤트로 옮긴다. 인식·마이크·권한은 전부 그 프로세스의 일이다(죽어도 앱은 산다).
//  한 번에 하나만 듣는다 — 새로 시작하면 앞의 것은 끊는다.
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

struct Run {
    id: u64,
    child: Child,
    stdin: Option<ChildStdin>,
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(1);

// 사이드카 자리(bundle-sidecar.sh 가 resources/daemon/cpt-stt 로 둔다) — tmux.rs 와 같은 후보 탐색.
fn helper(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    for c in ["daemon", "resources/daemon", "_up_/daemon"] {
        let p = res.join(c).join("cpt-stt");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn kill_current() {
    if let Ok(mut g) = RUN.lock() {
        if let Some(mut r) = g.take() {
            drop(r.stdin.take());
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

/// 듣기 시작 → 이 실행의 id. 이벤트 `cpt-stt` 의 payload 는 헬퍼의 JSON 줄에 `id` 를 얹은 것이고,
///  프로세스가 끝나면 `{id, t:"exit"}` 가 한 번 온다. 엔진이 없으면 `STT_UNAVAILABLE`.
#[tauri::command(async)]
pub fn stt_start(app: AppHandle, locale: String) -> Result<u64, String> {
    let bin = helper(&app).ok_or_else(|| "STT_UNAVAILABLE".to_string())?;
    kill_current();
    let loc: String = locale
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    let mut cmd = Command::new(bin);
    if !loc.is_empty() {
        cmd.arg("--locale").arg(loc);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("STT_UNAVAILABLE: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "STT_UNAVAILABLE".to_string())?;
    let stdin = child.stdin.take();
    let id = SEQ.fetch_add(1, Ordering::SeqCst);
    *RUN.lock().map_err(|_| "STT_UNAVAILABLE".to_string())? = Some(Run { id, child, stdin });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if let Some(o) = v.as_object_mut() {
                o.insert("id".into(), id.into());
                let _ = app.emit("cpt-stt", v);
            }
        }
        // 표준출력이 닫혔다 = 끝났다. 아직 이 실행이 등록돼 있으면 거둔다(좀비 방지).
        if let Ok(mut g) = RUN.lock() {
            if g.as_ref().map(|r| r.id) == Some(id) {
                if let Some(mut r) = g.take() {
                    let _ = r.child.wait();
                }
            }
        }
        let _ = app.emit("cpt-stt", serde_json::json!({ "id": id, "t": "exit" }));
    });
    Ok(id)
}

/// 그만 듣는다 — 남은 소리를 마저 인식한 뒤 스스로 끝난다(마지막 text 이벤트가 최종 문장).
#[tauri::command(async)]
pub fn stt_stop() {
    if let Ok(mut g) = RUN.lock() {
        if let Some(r) = g.as_mut() {
            if let Some(mut si) = r.stdin.take() {
                let _ = si.write_all(b"stop\n");
                let _ = si.flush();
            }
        }
    }
}

/// 바로 끊는다(전송·pane 닫힘) — 마지막 결과를 기다리지 않는다.
#[tauri::command(async)]
pub fn stt_cancel() {
    kill_current();
}
