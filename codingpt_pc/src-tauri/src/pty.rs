// PTY 스트림 — cmux식 로컬 터미널 pane. portable-pty 로 번들 tmux 에 attach 해 xterm(webview)과 브리지.
//
//  모델(전용 세션 — 데몬과 동일): 터미널 = 자기 tmux 세션 "<ns>--t-<tid>"(window 0 하나).
//   · pane 은 활성 터미널 탭의 세션에 "직접" attach 한다 — 뷰 세션/link-window/인덱스 간접층 없음.
//     탭 전환 = 이 pane 의 attach 재수립(pane.js 가 pty_close→pty_open). 로컬이라 즉시다.
//   · 여러 기기가 같은 세션에 동시 attach = 라이브 미러/이어받기. 크기는 window-size latest(전역) —
//     마지막으로 조작한 기기 크기(수동 resize-window 클레임 전면 폐지).
//   · pane 스트림 닫기 = attach 클라이언트만 종료(세션/셸은 tmux 서버에 생존 → 재실행 시 복원).
//     터미널 완전 삭제 = kill-session(tmux.rs kill_terminal).
//
//  와이어: 출력=raw 바이트(base64 로 emit "pty://data"), 입력=UTF-8 문자열(pty_write), 리사이즈=pty_resize.

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
    // 세대 표식 — 탭 전환(_reattach: close→open)으로 같은 pane_id 에 새 attach 가 끼워진 뒤,
    //  "구" reader 스레드의 종료 정리가 새 핸들을 지워버리는 레이스를 막는다(자기 세대만 정리).
    epoch: u64,
}

static PTY_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

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

// pane 열기: 터미널(tid) 확정 → 전용 세션에 직접 PTY attach + reader 스레드.
//  반환 = 실제로 attach 한 tid — 요청 win_index 가 스테일(닫힘/구버전 인덱스)이면 첫 터미널로
//  폴백되므로, 호출측(pane.js)은 반환값으로 탭을 보정해야 한다.
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
) -> Result<i64, String> {
    let (ns, abs) = tmux::session_for(&local_path);
    // 구 풀 잔재가 있으면 무손실 승격(멱등) → 요청 tid 확정. 전용 세션은 리퍼 불가침 + durable 이라
    //  앱이 얼마나 죽어 있었든 여기서의 attach 는 "이름으로 다시 붙기"일 뿐 레이스가 없다.
    tmux::migrate_legacy_pool(&ctx, &ns, &abs);
    let tid = tmux::resolve_tid(&ctx, &ns, &abs, win_index)?;
    if mgr.panes.lock().unwrap().contains_key(&pane_id) {
        return Ok(tid); // 이미 열림(중복 방지)
    }
    let target = tmux::term_session(&ns, tid);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 생성 실패: {e}"))?;
    let mut cmd = CommandBuilder::new(ctx.tmux.to_string_lossy().to_string());
    // -d 금지 — 같은 세션에 폰/다른 PC 가 동시 attach 해 미러/이어받기 한다(죽은 앱의 스테일
    //  클라이언트는 프로세스 종료와 함께 tmux 가 자동 제거). window-size latest 는 conf 가 전역
    //  세팅하지만, conf 없이 뜬 구 서버 대비로 attach 시에도 한 번 보장한다.
    cmd.args(["-L", tmux::TMUX_SOCKET, "attach", "-t", &format!("={target}"), ";", "set", "-g", "window-size", "latest"]);
    cmd.cwd(abs.to_string_lossy().to_string());
    cmd.env_remove("TMUX");
    // GUI(open)로 뜬 앱은 TERM/LANG 이 없어 tmux attach 가 "terminal does not support clear" 로 죽는다.
    //  데몬(node-pty)은 name:'xterm-256color' 로 TERM 을 넣지만 Rust portable-pty 는 상속뿐 → 명시 주입.
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_CTYPE", "en_US.UTF-8");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("tmux attach 실패: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("reader 실패: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer 실패: {e}"))?;

    let epoch = PTY_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    mgr.panes.lock().unwrap().insert(
        pane_id.clone(),
        PtyHandle { master: pair.master, writer, child, epoch },
    );

    // reader 스레드: 출력 바이트 → base64 → emit. EOF/오류 시 exit emit + 매니저 정리(자기 세대만).
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
            let mut panes = mgr.panes.lock().unwrap();
            if panes.get(&pid).map(|h| h.epoch) == Some(epoch) {
                panes.remove(&pid);
            }
        }
    });
    Ok(tid)
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

// 리사이즈(xterm FitAddon → PTY). 클라이언트 리사이즈(SIGWINCH→MSG_RESIZE)가 그 클라이언트를
//  window-size latest 의 "latest" 로 만들어 창 크기가 자동으로 따라온다 — 수동 resize-window
//  클레임(구 모델의 기기 간 크기 뺏기 전쟁 근원)은 전면 폐지.
#[tauri::command]
pub fn pty_resize(
    mgr: State<PtyManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        h.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize 실패: {e}"))?;
    }
    Ok(())
}

// pane 스트림 닫기: attach 클라이언트(PTY child)만 종료 — 세션/셸은 tmux 서버에 생존.
//  (워크스페이스 전환/재렌더 dispose 에서 호출되므로 여기서 세션을 kill 하면 안 된다.
//   터미널 완전 삭제는 탭 닫기/pane 닫기의 kill_window 가 담당 — 마지막 window kill 시 세션 자동 소멸.)
#[tauri::command]
pub fn pty_close(_ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    if let Some(mut h) = mgr.panes.lock().unwrap().remove(&pane_id) {
        let _ = h.child.kill();
    }
}

// 앱 시작/종료 시 레거시 grouped view 세션 정리("--view--" 만 — 독립 pane 세션(--p-)은
//  실제 셸이 사는 곳이라 절대 건드리지 않는다: 앱 재실행 시 레이아웃 복원이 재attach 한다).
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
