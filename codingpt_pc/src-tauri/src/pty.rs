// PTY 스트림 — cmux식 로컬 터미널 pane. portable-pty 로 번들 tmux 에 attach 해 xterm(webview)과 브리지.
//
//  모델:
//   · 워크스페이스 = tmux primary 세션(폰과 공유). 서피스 = tmux window.
//   · Mac pane = primary 와 grouped 된 view 세션(window 공유, current-window/size 독립).
//     → 여러 pane 이 서로 다른 window 를 동시에 보여주면서 폰과 세션/서피스를 공유(미러).
//   · pane 닫기 = view 세션만 kill(primary/window 는 보존). 서피스 닫기 = window kill(tmux.rs).
//
//  와이어: 출력=raw 바이트(base64 로 emit "pty://data"), 입력=UTF-8 문자열(pty_write), 리사이즈=pty_resize.
//  view 세션명 = "<primary>--view--<paneId>" (sanitizer 는 '--' 를 못 만들므로 워크스페이스명과 충돌 없음).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tmux::{self, TmuxCtx};

struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    view_session: String,
}

#[derive(Default)]
pub struct PtyManager {
    panes: Mutex<HashMap<String, PtyHandle>>,
}

#[derive(Clone, Serialize)]
struct DataEvent {
    #[serde(rename = "paneId")]
    pane_id: String,
    b64: String,
}
#[derive(Clone, Serialize)]
struct ExitEvent {
    #[serde(rename = "paneId")]
    pane_id: String,
}

fn view_name(session: &str, pane_id: &str) -> String {
    let safe: String = pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    format!("{session}--view--{safe}")
}

// pane 열기: primary 보장 → grouped view 생성(재사용) → 지정 window 선택 → PTY attach + reader 스레드.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    ctx: State<TmuxCtx>,
    mgr: State<PtyManager>,
    pane_id: String,
    local_path: String,
    win_index: i64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if mgr.panes.lock().unwrap().contains_key(&pane_id) {
        return Ok(()); // 이미 열림(중복 방지)
    }

    let (session, abs) = tmux::session_for(&local_path);
    tmux::ensure_session(&ctx, &session, &abs)?;

    let view = view_name(&session, &pane_id);
    if tmux::run(&ctx, &["has-session", "-t", &view]).is_err() {
        let cols_s = cols.max(2).to_string();
        let rows_s = rows.max(2).to_string();
        tmux::run(
            &ctx,
            &["new-session", "-d", "-t", &session, "-s", &view, "-x", &cols_s, "-y", &rows_s],
        )?;
    }
    if win_index >= 0 {
        let _ = tmux::run(&ctx, &["select-window", "-t", &format!("{view}:{win_index}")]);
    }

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 생성 실패: {e}"))?;
    let mut cmd = CommandBuilder::new(ctx.tmux.to_string_lossy().to_string());
    cmd.args(["-L", tmux::TMUX_SOCKET, "attach", "-t", &view]);
    cmd.cwd(abs.to_string_lossy().to_string());
    cmd.env_remove("TMUX");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("tmux attach 실패: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader 실패: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer 실패: {e}"))?;

    mgr.panes.lock().unwrap().insert(
        pane_id.clone(),
        PtyHandle { master: pair.master, writer, child, view_session: view },
    );

    // reader 스레드: 출력 바이트 → base64 → emit. EOF/오류 시 exit emit + 매니저 정리.
    let app2 = app.clone();
    let pid = pane_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("pty://data", DataEvent { pane_id: pid.clone(), b64 });
                }
            }
        }
        let _ = app2.emit("pty://exit", ExitEvent { pane_id: pid.clone() });
        if let Some(mgr) = app2.try_state::<PtyManager>() {
            mgr.panes.lock().unwrap().remove(&pid);
        }
    });
    Ok(())
}

// 키 입력(UTF-8 문자열) → PTY stdin.
#[tauri::command]
pub fn pty_write(mgr: State<PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        h.writer.write_all(data.as_bytes()).map_err(|e| format!("write 실패: {e}"))?;
        let _ = h.writer.flush();
    }
    Ok(())
}

// 리사이즈(xterm FitAddon → PTY). tmux window-size latest/aggressive-resize 로 화면 반영.
#[tauri::command]
pub fn pty_resize(
    mgr: State<PtyManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get(&pane_id) {
        h.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize 실패: {e}"))?;
    }
    Ok(())
}

// pane 닫기: PTY child kill + grouped view 세션만 kill(공유 primary/window 보존).
#[tauri::command]
pub fn pty_close(ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    if let Some(mut h) = mgr.panes.lock().unwrap().remove(&pane_id) {
        let _ = h.child.kill();
        let _ = tmux::run(&ctx, &["kill-session", "-t", &h.view_session]);
    }
}

// 이 pane 이 보여줄 서피스(window) 전환 — 그룹 세션은 current-window 독립.
#[tauri::command]
pub fn pty_select_window(
    ctx: State<TmuxCtx>,
    mgr: State<PtyManager>,
    pane_id: String,
    index: i64,
) -> Result<(), String> {
    let panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get(&pane_id) {
        tmux::run(&ctx, &["select-window", "-t", &format!("{}:{}", h.view_session, index)])?;
    }
    Ok(())
}

// 앱 종료/시작 시 고아 grouped view 세션 정리("--view--" 표식 + grouped 인 것만).
pub fn sweep_views(ctx: &TmuxCtx) {
    let out = match tmux::run(
        ctx,
        &["list-sessions", "-F", "#{session_name}\t#{session_group_size}"],
    ) {
        Ok(o) => o,
        Err(_) => return,
    };
    for line in out.lines() {
        let name = line.split('\t').next().unwrap_or("");
        if name.contains("--view--") {
            let _ = tmux::run(ctx, &["kill-session", "-t", name]);
        }
    }
}
