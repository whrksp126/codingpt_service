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
#[cfg(not(windows))]
use std::io::{Read, Write};
#[cfg(windows)]
use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

#[cfg(not(windows))]
use base64::Engine;
#[cfg(not(windows))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tmux::{self, TmuxCtx};

#[cfg(not(windows))]
struct PtyHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    // 세대 표식 — 탭 전환(_reattach: close→open)으로 같은 pane_id 에 새 attach 가 끼워진 뒤,
    //  "구" reader 스레드의 종료 정리가 새 핸들을 지워버리는 레이스를 막는다(자기 세대만 정리).
    epoch: u64,
    // attach 대상 터미널 세션 + 마지막 클라이언트 크기 — pty_claim(크기 주장)용.
    target: String,
    last_cols: u16,
    last_rows: u16,
}

// win32 pane 핸들 — tmux attach 자식 대신 term-host 파이프 attach 커넥션(포팅 계약 1).
//  writer = 파이프 쓰기 클론(i/r 프레임), reader = NDJSON 수신 스레드(o/x 프레임 → 기존 이벤트).
//  epoch/target/last_* 의미는 mac 과 동일(위 주석 참조).
#[cfg(windows)]
struct PtyHandle {
    // 겹침 I/O 파이프 뷰 — reader 스레드가 출력 대기로 영구 블로킹 중이어도 입력 쓰기가 막히지 않는다.
    //  std::fs::File 이면 동기 핸들 직렬화로 첫 키 입력에서 메인 스레드가 정지한다(winpipe.rs 주석).
    writer: crate::winpipe::PipeClient,
    reader: Option<std::thread::JoinHandle<()>>,
    epoch: u64,
    last_cols: u16,
    last_rows: u16,
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
#[cfg(not(windows))]
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
    replace: Option<bool>,
) -> Result<i64, String> {
    let (ns, abs) = tmux::session_for(&local_path);
    // 구 풀 잔재가 있으면 무손실 승격(멱등) → 요청 tid 확정. 전용 세션은 리퍼 불가침 + durable 이라
    //  앱이 얼마나 죽어 있었든 여기서의 attach 는 "이름으로 다시 붙기"일 뿐 레이스가 없다.
    tmux::migrate_legacy_pool(&ctx, &ns, &abs);
    let tid = tmux::resolve_tid(&ctx, &ns, win_index)?;
    {
        // replace=true(탭 전환): 같은 pane 의 기존 attach 를 여기서 원자적으로 교체한다 — 예전엔
        //  JS 가 pty_close 완료를 await 한 뒤 pty_open 을 불러 IPC 2왕복이 직렬이었고, 그만큼
        //  탭 전환이 늦었다. 구 핸들 정리는 epoch 가드(reader 스레드)가 자기 세대만 지우므로 안전.
        let mut panes = mgr.panes.lock().unwrap();
        if panes.contains_key(&pane_id) {
            if replace.unwrap_or(false) {
                if let Some(mut old) = panes.remove(&pane_id) {
                    let _ = old.child.kill();
                }
            } else {
                return Ok(tid); // 이미 열림(중복 방지)
            }
        }
    }
    let target = tmux::term_session(&ns, tid);

    // xterm 스크롤백은 클라이언트 로컬 상태다. 그냥 tmux attach 만 하면 새 PC 뷰는 현재 화면만
    // 받고, 오래 살아 있던 모바일 WebView 는 자기 옛 버퍼를 계속 보여 같은 터미널의 과거가
    // 기기마다 달라진다. attach 전에 로컬 버퍼를 비우고 tmux 정본 history(현재 화면 제외)를
    // 심는다. 뒤이어 attach 가 현재 화면을 그리므로 중복 없이 모든 기기가 같은 과거를 본다.
    let history_bootstrap = {
        let captured = tmux::run(
            &ctx,
            &["capture-pane", "-p", "-e", "-t", &format!("={target}:0"), "-S", "-10000", "-E", "-1"],
        ).unwrap_or_default();
        let history = normalize_resize_prompt_history(&captured).replace('\n', "\r\n");
        if history.is_empty() {
            "\x1b[3J\x1b[H\x1b[2J".to_string()
        } else {
            format!("\x1b[3J\x1b[H\x1b[2J{history}\r\n")
        }
    };

    // 셸 attach는 현재 정본 크기를 유지한다. 새 PC/폰이 붙을 때마다 자기 크기로 PTY를 흔들면
    // tmux가 보이는 프롬프트를 history로 밀어 넣는다. alternate-screen TUI만 요청 크기로 attach.
    let display = tmux::run(
        &ctx,
        &["display-message", "-p", "-t", &format!("={target}:0"), "#{alternate_on} #{window_width} #{window_height}"],
    ).unwrap_or_default();
    let mut display_parts = display.split_whitespace();
    let alternate = display_parts.next() == Some("1");
    let current_cols = display_parts.next().and_then(|s| s.parse::<u16>().ok()).unwrap_or(cols);
    let current_rows = display_parts.next().and_then(|s| s.parse::<u16>().ok()).unwrap_or(rows);
    let attach_cols = if alternate { cols } else { current_cols };
    let attach_rows = if alternate { rows } else { current_rows };
    let pair = native_pty_system()
        .openpty(PtySize { rows: attach_rows, cols: attach_cols, pixel_width: 0, pixel_height: 0 })
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
        PtyHandle { master: pair.master, writer, child, epoch, target, last_cols: cols, last_rows: rows },
    );

    // reader 스레드보다 먼저 emit: PTY 쪽 attach 리페인트는 이미 master 버퍼에 대기하므로
    // bootstrap → 현재 화면 순서가 보장된다.
    let bootstrap_b64 = base64::engine::general_purpose::STANDARD.encode(history_bootstrap.as_bytes());
    let _ = app.emit("pty://data", DataEvent { pane_id: pane_id.clone(), b64: bootstrap_b64 });

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

fn normalize_resize_prompt_history(captured: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut previous_prompt = String::new();
    for line in captured.trim_end_matches('\n').split('\n') {
        // capture-pane -e 의 SGR만 제거해 비교한다. 원본 ANSI 줄은 그대로 보존한다.
        let mut plain = String::new();
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\x1b' && chars.peek() == Some(&'[') {
                chars.next();
                while let Some(c) = chars.next() {
                    if ('@'..='~').contains(&c) { break; }
                }
            } else { plain.push(ch); }
        }
        let p = plain.trim();
        let is_prompt = p.split_whitespace().any(|s| s.contains('@'))
            && p.split_whitespace().any(|s| s.starts_with('/') || s.starts_with('~'));
        if is_prompt && p == previous_prompt { continue; }
        out.push(line);
        if is_prompt { previous_prompt = p.to_string(); } else { previous_prompt.clear(); }
    }
    out.join("\n")
}

#[cfg(test)]
mod history_tests {
    use super::normalize_resize_prompt_history;

    #[test]
    fn collapses_only_consecutive_shell_prompt_repaints() {
        let prompt = "user@host ~/work/project main";
        let input = format!("same log\nsame log\n{prompt}\n{prompt}\n{prompt}\nresult\n{prompt}\n");
        assert_eq!(
            normalize_resize_prompt_history(&input),
            format!("same log\nsame log\n{prompt}\nresult\n{prompt}")
        );
    }
}

// 키 입력(UTF-8 문자열) → PTY stdin.
#[cfg(not(windows))]
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
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_resize(
    app: AppHandle,
    ctx: State<TmuxCtx>,
    mgr: State<PtyManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let target = {
        let mut panes = mgr.panes.lock().unwrap();
        if let Some(h) = panes.get_mut(&pane_id) {
            h.last_cols = cols;
            h.last_rows = rows;
            h.target.clone()
        } else { return Ok(()); }
    };
    let ctx2 = tmux::TmuxCtx { tmux: ctx.tmux.clone(), conf: ctx.conf.clone() };
    std::thread::spawn(move || {
        let alt = tmux::run(&ctx2, &["display-message", "-p", "-t", &format!("={target}:0"), "#{alternate_on}"]).unwrap_or_default();
        if alt.trim() != "1" { return; }
        if let Some(m) = app.try_state::<PtyManager>() {
            if let Some(h) = m.panes.lock().unwrap().get(&pane_id) {
                let _ = h.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            }
        }
    });
    Ok(())
}

// 크기 주장(claim) — 사용자가 이 pane 을 클릭/포커스/타이핑할 때, 표시 중인 터미널 창이 다른 기기
//  크기로 잡혀 있으면 클라이언트 pty 를 1칸 줄였다 복원(nudge)한다. 리사이즈 신호가 이 클라이언트를
//  window-size latest 의 "latest" 로 만들어 창이 이 pane 크기로 따라온다 — resize-window(manual 고정)
//  없이 성립하므로 기기 간 크기 뺏기 전쟁이 없다. 창이 이미 내 크기면 완전 no-op.
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_claim(app: AppHandle, ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    let (target, cols, rows) = {
        let panes = mgr.panes.lock().unwrap();
        match panes.get(&pane_id) {
            Some(h) => (h.target.clone(), h.last_cols, h.last_rows),
            None => return,
        }
    };
    if cols < 4 || rows < 2 {
        return;
    }
    let ctx2 = tmux::TmuxCtx { tmux: ctx.tmux.clone(), conf: ctx.conf.clone() };
    std::thread::spawn(move || {
        let cur = tmux::run(&ctx2, &["display-message", "-p", "-t", &format!("={target}:0"), "#{alternate_on} #{window_width} #{window_height}"]).unwrap_or_default();
        let mut it = cur.split_whitespace();
        if it.next() != Some("1") { return; }
        let cw: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ch: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if cw == cols && ch == rows {
            return; // 이미 내 크기 — SIGWINCH 소음 없이 종료
        }
        let nudge = |c: u16| {
            if let Some(m) = app.try_state::<PtyManager>() {
                if let Some(h) = m.panes.lock().unwrap().get(&pane_id) {
                    let _ = h.master.resize(PtySize { rows, cols: c, pixel_width: 0, pixel_height: 0 });
                }
            }
        };
        nudge(cols - 1);
        std::thread::sleep(std::time::Duration::from_millis(60));
        nudge(cols);
    });
}

// 이 pane 의 채널이 실제로 살아있는가 — JS 쪽 낙관 상태(_attachedWin)가 이벤트 유실로 스테일해져도
//  리컨실러 워치독이 진실을 확인해 재attach 할 수 있게 한다.
#[tauri::command]
pub fn pty_alive(mgr: State<PtyManager>, pane_id: String) -> bool {
    mgr.panes.lock().unwrap().contains_key(&pane_id)
}

// pane 스트림 닫기: attach 클라이언트(PTY child)만 종료 — 세션/셸은 tmux 서버에 생존.
//  (워크스페이스 전환/재렌더 dispose 에서 호출되므로 여기서 세션을 kill 하면 안 된다.
//   터미널 완전 삭제는 탭 닫기/pane 닫기의 kill_window 가 담당 — 마지막 window kill 시 세션 자동 소멸.)
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_close(_ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    if let Some(mut h) = mgr.panes.lock().unwrap().remove(&pane_id) {
        let _ = h.child.kill();
    }
}

// 앱 시작/종료 시 레거시 grouped view 세션 정리("--view--" 만 — 독립 pane 세션(--p-)은
//  실제 셸이 사는 곳이라 절대 건드리지 않는다: 앱 재실행 시 레이아웃 복원이 재attach 한다).
#[cfg(not(windows))]
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

// ═══ win32 — term-host 파이프 attach 클라이언트(포팅 계약 1) ═══════════════════
//  tmux attach 자식 프로세스 대신 named pipe NDJSON 스트림으로 같은 의미론을 재현한다:
//   · attach 핸드셰이크 1줄 → {ok} 응답 → o프레임(첫 프레임=전체 리페인트, tmux 리페인트 등가)
//     을 base64 그대로 pty://data 로 통과(와이어 표현이 동일해 재인코딩 불필요).
//   · 입력 = i프레임(b64) · 리사이즈 = r프레임(latest wins — window-size latest 등가).
//   · pty_claim 의 "1칸 nudge" 등가 = 현재 크기 r프레임 1회(서버가 같은 크기면 no-op).
//   · 세션 부재/호스트 미기동 에러 의미론은 mac 경로와 동일(resolve_tid 가 "열린 터미널이
//     없습니다"를 돌려주고, 호스트 미기동은 목록 0개 → 프론트 리컨실러가 기존 tmux 부재 UX 로 대기).
//  프레임 인코딩/디코딩은 termhost.rs 순수 함수(유닛테스트 완비)를 사용한다.

#[cfg(windows)]
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
    replace: Option<bool>,
) -> Result<i64, String> {
    use crate::termhost;
    let (ns, abs) = tmux::session_for(&local_path);
    tmux::migrate_legacy_pool(&ctx, &ns, &abs); // win32 no-op(레거시 tmux 풀 없음) — 시그니처 유지
    let tid = tmux::resolve_tid(&ctx, &ns, win_index)?;
    {
        // 탭 전환(replace=true, mac 경로와 동일 계약): 구 attach 를 여기서 원자적으로 교체.
        //  정리 절차는 pty_close(win32)와 동일 — writer drop + 블로킹 read 를 CancelSynchronousIo 로 해제.
        let removed = {
            let mut panes = mgr.panes.lock().unwrap();
            if panes.contains_key(&pane_id) {
                if replace.unwrap_or(false) { panes.remove(&pane_id) } else { return Ok(tid); }
            } else { None }
        };
        if let Some(h) = removed {
            drop(h.writer);
            if let Some(t) = h.reader {
                std::thread::spawn(move || {
                    use std::os::windows::io::AsRawHandle;
                    for _ in 0..100 {
                        if t.is_finished() { break; }
                        unsafe {
                            let _ = windows::Win32::System::IO::CancelSynchronousIo(
                                windows::Win32::Foundation::HANDLE(t.as_raw_handle() as _),
                            );
                        }
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                });
            }
        }
    }
    let target = tmux::term_session(&ns, tid);

    // 파이프 열기(ERROR_PIPE_BUSY 재시도 포함) + attach 핸드셰이크. 핸드셰이크 응답을 읽은
    //  BufReader 를 그대로 reader 스레드에 넘긴다 — 응답 뒤에 버퍼링된 첫 리페인트 프레임을 잃지 않게.
    let stream = termhost::connect().map_err(|e| e.message())?;
    let mut writer = stream.try_clone().map_err(|e| format!("파이프 클론 실패: {e}"))?;
    let mut reader = BufReader::new(stream);
    writer
        .write_all(termhost::attach_line(termhost::next_id(), &target, cols, rows).as_bytes())
        .map_err(|e| format!("attach 요청 전송 실패: {e}"))?;
    let mut resp = String::new();
    let n = reader.read_line(&mut resp).map_err(|e| format!("attach 응답 수신 실패: {e}"))?;
    if n == 0 {
        return Err("attach 응답 없음(term-host 종료?)".to_string());
    }
    termhost::parse_op_response(&resp).map_err(|e| format!("attach 실패: {}", e.message()))?;

    let epoch = PTY_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    mgr.panes.lock().unwrap().insert(
        pane_id.clone(),
        PtyHandle { writer, reader: None, epoch, last_cols: cols, last_rows: rows },
    );

    // reader 스레드: o프레임 b64 → 그대로 emit, x프레임/EOF/오류 → exit emit + 매니저 정리(자기 세대만).
    let app2 = app.clone();
    let pid = pane_id.clone();
    let jh = std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break, // EOF/파이프 단절/CancelSynchronousIo(pty_close)
                Ok(_) => {}
            }
            match crate::termhost::parse_stream_line(&line) {
                Some(crate::termhost::Frame::Output(b64)) => {
                    let _ = app2.emit("pty://data", DataEvent { pane_id: pid.clone(), b64 });
                }
                Some(crate::termhost::Frame::Exit(_)) => break, // 세션 종료(셸 exit/kill)
                _ => {} // bell 은 o프레임 안의 BEL 바이트로 이미 전달됨 — 별도 처리 불요
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
    // JoinHandle 을 핸들에 되건다(pty_close 가 블로킹 read 를 CancelSynchronousIo 로 깨우는 재료).
    if let Some(h) = mgr.panes.lock().unwrap().get_mut(&pane_id) {
        if h.epoch == epoch {
            h.reader = Some(jh);
        }
    }
    Ok(tid)
}

// 키 입력(UTF-8 문자열) → i프레임.
#[cfg(windows)]
#[tauri::command]
pub fn pty_write(mgr: State<PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        h.writer
            .write_all(crate::termhost::input_frame(data.as_bytes()).as_bytes())
            .map_err(|e| format!("write 실패: {e}"))?;
        let _ = h.writer.flush();
    }
    Ok(())
}

// 리사이즈 → r프레임(latest wins — 마지막 프레임이 이긴다. mac 의 SIGWINCH→window-size latest 등가).
#[cfg(windows)]
#[tauri::command]
pub fn pty_resize(mgr: State<PtyManager>, pane_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        h.writer
            .write_all(crate::termhost::resize_frame(cols, rows).as_bytes())
            .map_err(|e| format!("resize 실패: {e}"))?;
        let _ = h.writer.flush();
        h.last_cols = cols;
        h.last_rows = rows;
    }
    Ok(())
}

// 크기 주장(claim) — mac 의 "1칸 nudge" 등가는 r프레임 1회다: 세션이 다른 기기 크기로 잡혀 있으면
//  이 프레임이 latest 가 되어 내 크기로 따라오고, 이미 내 크기면 서버 session.resize 가 no-op 라
//  SIGWINCH 소음도 없다(비교 왕복 불필요 — mac 의 display-message 프리체크와 같은 효과).
#[cfg(windows)]
#[tauri::command]
pub fn pty_claim(_app: AppHandle, _ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        if h.last_cols < 4 || h.last_rows < 2 {
            return;
        }
        let _ = h.writer.write_all(crate::termhost::resize_frame(h.last_cols, h.last_rows).as_bytes());
        let _ = h.writer.flush();
    }
}

// pane 스트림 닫기 = attach 커넥션만 종료(세션/셸은 term-host 에 생존 — mac 과 동일 의미론).
//  reader 스레드는 동기 ReadFile 에 블로킹돼 있어 쓰기 핸들 drop 만으론 안 깨어난다 —
//  CancelSynchronousIo 로 깨워 스레드가 자기 File 을 drop 해야 서버가 detach 를 본다.
//  (커맨드 스레드를 붙잡지 않게 정리는 백그라운드에서 반복 시도 — 스레드가 syscall 밖이면
//   ERROR_NOT_FOUND 로 헛빵일 수 있어 종료 확인까지 재시도한다.)
#[cfg(windows)]
#[tauri::command]
pub fn pty_close(_ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) {
    if let Some(h) = mgr.panes.lock().unwrap().remove(&pane_id) {
        drop(h.writer);
        if let Some(t) = h.reader {
            std::thread::spawn(move || {
                use std::os::windows::io::AsRawHandle;
                for _ in 0..100 {
                    if t.is_finished() {
                        break;
                    }
                    unsafe {
                        let _ = windows::Win32::System::IO::CancelSynchronousIo(
                            windows::Win32::Foundation::HANDLE(t.as_raw_handle() as _),
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            });
        }
    }
}

// win32: 레거시 grouped view 세션이라는 개념 자체가 없다(tmux 시절 산물) — no-op.
#[cfg(windows)]
pub fn sweep_views(_ctx: &TmuxCtx) {}
