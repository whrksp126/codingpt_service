// PTY 스트림 — cmux식 로컬 터미널 pane. portable-pty 로 번들 tmux 에 attach 해 xterm(webview)과 브리지.
//
//  모델(모바일 데몬과 동일 — pane 당 "독립" tmux 세션):
//   · pane = 자기 세션 "<primary>--p-<paneId>", 탭 = 그 세션의 window.
//   · grouped view(--view--) 는 폐기 — current-window 가 attach/동시성에 취약해 여러 pane 이
//     같은 window 를 비추는 복제가 발생했다(모바일과 같은 근본 원인). 독립 세션은 경쟁 자체가 없다.
//   · pane 스트림 닫기 = attach 클라이언트만 종료(세션/셸은 tmux 서버에 생존 → 재실행 시 복원).
//     터미널 완전 삭제 = window kill(tmux.rs, 마지막 window kill 시 세션 자동 소멸).
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
    view_session: String,
    // 마지막으로 반영한 클라이언트 크기 — pty_resize 에서 크기가 "변할 때"만 표시 창을 따라
    //  리사이즈(분할선 드래그/창 크기 변경이 TUI(claude 등)에 즉시 반영되게).
    last_cols: u16,
    last_rows: u16,
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

// pane 열기: pane 독립 세션 보장 → 지정 window 선택 → PTY attach + reader 스레드.
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
    let view = tmux::pane_session(&session, &pane_id);
    // 공유 풀 모델: 터미널 실체 = 풀(primary) window(전 기기 공유), pane = 뷰 세션(link-window).
    //  ensure_view 가 풀/뷰/링크/선택을 전부 보장. 반환 = 실제 표시 인덱스(스테일 win 폴백 반영) —
    //  아래 attach 후 리사이즈 보정은 반드시 이 값을 타깃해야 한다.
    let win = if win_index >= 0 { win_index } else { 0 };
    let win = tmux::ensure_view(&ctx, &view, &session, win, &abs)?;

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 생성 실패: {e}"))?;
    let mut cmd = CommandBuilder::new(ctx.tmux.to_string_lossy().to_string());
    // -d: 다른 클라이언트 detach — 죽은 이전 실행의 스테일 attach 가 화면 크기를 물고 늘어지는 것 자가치유.
    cmd.args(["-L", tmux::TMUX_SOCKET, "attach", "-d", "-t", &format!("={view}")]);
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

    mgr.panes.lock().unwrap().insert(
        pane_id.clone(),
        PtyHandle { master: pair.master, writer, child, view_session: view.clone(), last_cols: cols, last_rows: rows },
    );

    // 클라이언트 attach 완료 직후 이 pane 크기로 리사이즈 — ensure_view 는 attach 전이라
    //  클라이언트가 없어 스킵됐으므로, 부팅 시에도 활성 탭이 제 크기로 보이게 한 번 보정.
    //  manual 여부와 무관하게 이 pane 의 클라이언트 크기를 주장한다(데몬 resizeToClient 미러) —
    //  이전엔 "virgin(비-manual) 창"에만 보정했는데, 다른 기기(모바일)가 공유 풀 window 를
    //  manual 로 남겨두면 PC 가 자기 크기를 못 주장해 TUI(claude 등)가 어긋난 크기로 그려졌다
    //  (실측: PC client 61x23 인데 모바일이 남긴 window 62x55 를 그대로 표시). resize_to_client 는
    //  같은 크기면 내부에서 스킵하므로 단일 기기에서 불필요한 SIGWINCH 도 없다.
    {
        let ctx2 = tmux::TmuxCtx { tmux: ctx.tmux.clone(), conf: ctx.conf.clone() };
        let view2 = view;
        let session2 = session.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            tmux::resize_to_client(&ctx2, &view2, &session2, win);
        });
    }

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

// 리사이즈(xterm FitAddon → PTY). 크기가 변했으면 표시 중인 창(window)도 이 pane 크기로 —
//  창은 manual 크기 고정이라 클라이언트만 리사이즈하면 TUI(claude 등)가 옛 크기로 그려진다
//  (분할선 드래그/창 크기 변경의 실시간 반영. 데몬 openPtyStream 의 resize 처리와 동일 규칙).
#[tauri::command]
pub fn pty_resize(
    ctx: State<TmuxCtx>,
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
        if h.last_cols != cols || h.last_rows != rows {
            h.last_cols = cols;
            h.last_rows = rows;
            let view = h.view_session.clone();
            let ctx2 = tmux::TmuxCtx { tmux: ctx.tmux.clone(), conf: ctx.conf.clone() };
            std::thread::spawn(move || {
                // display-message -t <세션> 은 빈 값을 주는 경우가 있어 list-windows 로 활성 창 조회.
                if let Ok(out) = tmux::run(&ctx2, &["list-windows", "-t", &format!("={view}"), "-F", "#{window_index} #{window_active}"]) {
                    let idx = out
                        .lines()
                        .filter_map(|l| {
                            let mut it = l.split_whitespace();
                            match (it.next(), it.next()) {
                                (Some(i), Some("1")) => Some(i.to_string()),
                                _ => None,
                            }
                        })
                        .next();
                    if let Some(idx) = idx {
                        let _ = tmux::run(
                            &ctx2,
                            &["resize-window", "-t", &format!("={view}:{idx}"), "-x", &cols.to_string(), "-y", &rows.to_string()],
                        );
                    }
                }
            });
        }
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
