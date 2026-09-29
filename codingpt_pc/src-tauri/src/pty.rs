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
use std::time::{SystemTime, UNIX_EPOCH};

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
    // 입력마다 tmux 를 스폰하지 않기 위한 절약 상태(실측 tmux 1회 = 5.5ms, 키당 2회면 ~11ms).
    //  · last_claim_ms  — 컨트롤러 리스는 15초짜리라 1/3 이 지났을 때만 갱신한다.
    //  · last_write_ms  — 크기 재주장은 입력이 끊겼다 재개될 때만(다른 기기가 뺏어갔을 수 있는 순간).
    last_claim_ms: u128,
    last_write_ms: u128,
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

#[cfg(not(windows))]
fn controller_now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(not(windows))]
fn controller_lease_allows_value(raw: &str, owner: &str, now: u128) -> bool {
    let Some((current, expiry)) = raw.trim().rsplit_once(':') else { return true };
    let expires_at = expiry.parse::<u128>().unwrap_or(0);
    current == owner || expires_at <= now
}

#[cfg(not(windows))]
fn controller_allows(ctx: &TmuxCtx, target: &str, owner: &str) -> bool {
    let raw = tmux::run(ctx, &["show-options", "-w", "-v", "-t", &format!("={target}:0"), "@codingpt_controller"])
        .unwrap_or_default();
    controller_lease_allows_value(&raw, owner, controller_now_ms())
}

#[cfg(not(windows))]
const CONTROLLER_LEASE_MS: u128 = 15_000;
// 리스 갱신 주기 — 유효기간의 1/3. 키마다 갱신하면 tmux 프로세스가 초당 수십 개 뜬다.
#[cfg(not(windows))]
const CONTROLLER_REFRESH_MS: u128 = CONTROLLER_LEASE_MS / 3;
// 입력이 이만큼 끊겼다 재개되면 그 사이 다른 기기가 크기를 가져갔을 수 있으므로 한 번 되찾는다.
#[cfg(not(windows))]
const SIZE_RECLAIM_IDLE_MS: u128 = 500;

#[cfg(not(windows))]
fn claim_controller(ctx: &TmuxCtx, target: &str, owner: &str) {
    let value = format!("{owner}:{}", controller_now_ms() + CONTROLLER_LEASE_MS);
    let _ = tmux::run(ctx, &["set-option", "-w", "-t", &format!("={target}:0"), "@codingpt_controller", &value]);
}

// 입력 경로에서 "지금 tmux 를 불러야 하는가"를 순수 함수로 분리 — 테스트가 스폰 없이 검증한다.
#[cfg(not(windows))]
fn should_refresh_lease(last_claim_ms: u128, now: u128) -> bool {
    now.saturating_sub(last_claim_ms) >= CONTROLLER_REFRESH_MS
}

#[cfg(not(windows))]
fn should_reclaim_size(last_write_ms: u128, now: u128) -> bool {
    last_write_ms == 0 || now.saturating_sub(last_write_ms) > SIZE_RECLAIM_IDLE_MS
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

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 생성 실패: {e}"))?;
    let mut cmd = CommandBuilder::new(ctx.tmux.to_string_lossy().to_string());
    // -d 금지 — 같은 세션에 폰/다른 PC 가 동시 attach 해 미러/이어받기 한다(죽은 앱의 스테일
    //  클라이언트는 프로세스 종료와 함께 tmux 가 자동 제거). window-size latest 는 conf 가 전역
    //  세팅하지만, conf 없이 뜬 구 서버 대비로 attach 시에도 한 번 보장한다.
    // attach 자체는 공유 창 크기를 건드리지 않는다. 실제 사용자 포커스/입력/viewport resize 만
    // pty_resize·pty_claim 의 명시적 resize-window 로 크기를 정한다. 여러 기기가 동시에 붙을 때
    // tmux 가 클라이언트 수만큼 SIGWINCH 재도장을 만들어 프롬프트/화면을 history 에 복제하는 것 방지.
    cmd.args(["-L", tmux::TMUX_SOCKET, "attach", "-f", "ignore-size", "-t", &format!("={target}"), ";", "set", "-g", "window-size", "latest"]);
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
        PtyHandle { master: pair.master, writer, child, epoch, target: target.clone(), last_cols: cols, last_rows: rows, last_claim_ms: 0, last_write_ms: 0 },
    );

    // reader 스레드보다 먼저 emit: PTY 쪽 attach 리페인트는 이미 master 버퍼에 대기하므로
    // bootstrap → 현재 화면 순서가 보장된다.
    let bootstrap_b64 = base64::engine::general_purpose::STANDARD.encode(history_bootstrap.as_bytes());
    let _ = app.emit("pty://data", DataEvent { pane_id: pane_id.clone(), b64: bootstrap_b64 });

    // reader 스레드: 출력 바이트 → base64 → emit. EOF/오류 시 exit emit + 매니저 정리(자기 세대만).
    let app2 = app.clone();
    let pid = pane_id.clone();
    let clear_ctx = tmux::TmuxCtx { tmux: ctx.tmux.clone(), conf: ctx.conf.clone() };
    let clear_target = target.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut erase_tail: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut scan = erase_tail;
                    scan.extend_from_slice(&buf[..n]);
                    if contains_erase_scrollback(&scan) {
                        // CSI 3 J는 일반 셸 `clear`가 내는 erase-scrollback 신호다. 공유 정본도
                        // 함께 비워야 다른 기기의 재접속/bootstrap에서 과거가 되살아나지 않는다.
                        let _ = tmux::run(&clear_ctx, &["clear-history", "-t", &format!("={clear_target}:0")]);
                    }
                    erase_tail = scan[scan.len().saturating_sub(3)..].to_vec();
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

#[cfg(not(windows))]
fn contains_erase_scrollback(bytes: &[u8]) -> bool {
    bytes.windows(4).any(|w| w == b"\x1b[3J")
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
    use super::{contains_erase_scrollback, controller_lease_allows_value, normalize_resize_prompt_history};

    #[test]
    fn collapses_only_consecutive_shell_prompt_repaints() {
        let prompt = "user@host ~/work/project main";
        let input = format!("same log\nsame log\n{prompt}\n{prompt}\n{prompt}\nresult\n{prompt}\n");
        assert_eq!(
            normalize_resize_prompt_history(&input),
            format!("same log\nsame log\n{prompt}\nresult\n{prompt}")
        );
    }

    #[test]
    fn recognizes_only_the_erase_scrollback_sequence() {
        assert!(contains_erase_scrollback(b"before\x1b[3Jafter"));
        assert!(!contains_erase_scrollback(b"\x1b[2J"));
        assert!(!contains_erase_scrollback(b"\x1b[?1049h"));
    }

    #[test]
    fn input_path_spawns_tmux_only_on_lease_refresh_and_after_idle() {
        use super::{should_reclaim_size, should_refresh_lease, CONTROLLER_REFRESH_MS, SIZE_RECLAIM_IDLE_MS};
        // 연속 타이핑: 리스도 크기도 다시 안 건드린다(키당 tmux 스폰 0).
        assert!(!should_refresh_lease(1_000, 1_000 + CONTROLLER_REFRESH_MS - 1));
        assert!(!should_reclaim_size(1_000, 1_000 + SIZE_RECLAIM_IDLE_MS));
        // 리스 유효기간 1/3 경과 → 한 번 갱신.
        assert!(should_refresh_lease(1_000, 1_000 + CONTROLLER_REFRESH_MS));
        // 입력이 끊겼다 재개 → 크기 한 번 회수. 첫 입력(0)도 회수 대상.
        assert!(should_reclaim_size(1_000, 1_000 + SIZE_RECLAIM_IDLE_MS + 1));
        assert!(should_reclaim_size(0, 1));
    }

    #[test]
    fn history_window_pages_backwards_from_the_newest_line() {
        use super::history_window;
        // before 생략 = 맨 끝(가장 최근) 페이지.
        assert_eq!(history_window(500, None, 200), (300, 500));
        // 이어서 그 앞 페이지 — 경계가 정확히 맞물린다.
        assert_eq!(history_window(500, Some(300), 200), (100, 300));
        // 맨 앞에서 멈춘다(음수 offset 금지).
        assert_eq!(history_window(500, Some(100), 200), (0, 100));
        assert_eq!(history_window(500, Some(0), 200), (0, 0));
        // 과거가 limit 보다 짧아도 안전.
        assert_eq!(history_window(30, None, 200), (0, 30));
        assert_eq!(history_window(0, None, 200), (0, 0));
        // limit 은 1..=500 으로 조인다(0 이나 거대값이 와도 tmux 호출이 깨지지 않게).
        assert_eq!(history_window(500, None, 0), (499, 500));
        assert_eq!(history_window(5000, None, 99_999), (4500, 5000));
        // before 가 범위를 벗어나면 클램프.
        assert_eq!(history_window(100, Some(999), 50), (50, 100));
        assert_eq!(history_window(100, Some(-5), 50), (0, 0));
    }

    #[test]
    fn strip_ansi_keeps_text_and_multibyte() {
        use super::strip_ansi;
        assert_eq!(strip_ansi("\x1b[31mRED\x1b[39m"), "RED");
        assert_eq!(strip_ansi("\x1b[1;38;2;255;0;0m한글 ✳\x1b[0m"), "한글 ✳");
        assert_eq!(strip_ansi("\x1b]0;title\x07shell"), "shell");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link"), "link");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn controller_lease_allows_only_owner_until_expiry() {
        assert!(controller_lease_allows_value("ipad:200", "ipad", 100));
        assert!(!controller_lease_allows_value("ipad:200", "pc", 100));
        assert!(controller_lease_allows_value("ipad:200", "pc", 200));
        assert!(controller_lease_allows_value("", "pc", 100));
    }
}

// 스크롤 라우팅 모드 — 모바일과 **같은 정본**(tmux 가 pane 의 alternate/mouse 를 안다).
//  terminal-overrides 의 smcup@ 때문에 1049 는 클라이언트 xterm 에 오지 않으므로, PC 로컬
//  터미널도 "지금 풀스크린 앱인가"를 xterm 만 보고는 알 수 없다. 예전엔 이걸 codex 브랜드
//  하드코딩으로 때웠는데, 브랜드가 아니라 모드로 판정해야 vim·less·그 밖의 TUI 가 다 맞는다.
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_modes(ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String) -> Result<serde_json::Value, String> {
    let target = { mgr.panes.lock().unwrap().get(&pane_id).map(|h| h.target.clone()) };
    let Some(target) = target else { return Ok(serde_json::json!({})) };
    let raw = tmux::run(&ctx, &["display-message", "-p", "-t", &format!("={target}:0"), "#{alternate_on},#{mouse_any_flag}"])
        .unwrap_or_default();
    let mut it = raw.trim().split(',');
    let alt = it.next().unwrap_or("0") == "1";
    let mouse = it.next().unwrap_or("0") == "1";
    Ok(serde_json::json!({ "altScreen": alt, "mouseTracking": mouse }))
}

// win32(term-host)는 tmux 가 없다 — 모드를 모른다고 답하고 클라이언트가 xterm 추론으로 폴백한다.
#[cfg(windows)]
#[tauri::command]
pub fn pty_modes(_mgr: State<PtyManager>, _pane_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

// ── 과거(스크롤백)는 tmux 격자에서 읽는다 ────────────────────────────────────────
// 왜 클라이언트 xterm 의 스크롤백이 아닌가(2026-09-04 실측·사용자 신고):
//  tmux 는 리사이즈마다 pane 을 **커서 위치에 다시 그린다**(ED 없이 `\e[K`+`\r\n` 반복).
//  그래서 attach 한 xterm 은 재도장 잔재를 계속 스크롤백에 쌓는다. 기기마다 화면 크기가 다른
//  멀티기기(window-size latest)에서는 이 리사이즈가 상시 일어나 잔재가 실제 과거를 밀어내고,
//  폭이 바뀌며 리플로우돼 프롬프트가 한 줄에 여러 개 붙는 형태로 뭉개진다.
//  → PC 도 모바일과 **같은 정본**(서버/tmux history)에서 과거를 읽는다. 계약은 데몬의
//    `{type:'history', before, limit}` → `{start,end,total,hasMore,rows[]}` 와 동일하다.
//
/// offset 0 = 가장 오래된 과거 줄일 때, 요청 페이지의 [start,end) 를 구한다(순수).
fn history_window(total: i64, before: Option<i64>, limit: i64) -> (i64, i64) {
    let lim = limit.clamp(1, 500);
    let end = before.map_or(total, |b| b.clamp(0, total));
    let start = (end - lim).max(0);
    (start, end)
}

/// ANSI(CSI/OSC/단일문자 이스케이프) 제거 — 페이지의 text 필드용(렌더는 ansi 를 쓴다).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek().copied() {
            Some('[') => {
                it.next();
                while let Some(c2) = it.next() {
                    if ('\u{40}'..='\u{7e}').contains(&c2) {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                while let Some(c2) = it.next() {
                    if c2 == '\u{7}' {
                        break;
                    }
                    if c2 == '\u{1b}' {
                        if it.peek() == Some(&'\\') {
                            it.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                it.next();
            }
            None => {}
        }
    }
    out
}

fn empty_history_page() -> serde_json::Value {
    serde_json::json!({ "start": 0, "end": 0, "total": 0, "hasMore": false, "rows": [] })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn pty_history(
    ctx: State<TmuxCtx>,
    mgr: State<PtyManager>,
    pane_id: String,
    before: Option<i64>,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let target = { mgr.panes.lock().unwrap().get(&pane_id).map(|h| h.target.clone()) };
    let Some(target) = target else { return Ok(empty_history_page()) };
    let t = format!("={target}:0");
    let raw = tmux::run(&ctx, &["display-message", "-p", "-t", &t, "#{history_size}"]).unwrap_or_default();
    let total: i64 = raw.trim().parse().unwrap_or(0);
    let (start, end) = history_window(total, before, limit.unwrap_or(200));
    if start >= end {
        return Ok(serde_json::json!({ "start": end, "end": end, "total": total, "hasMore": end > 0, "rows": [] }));
    }
    // tmux 줄번호: 0 = 보이는 화면 첫 줄, 음수 = 과거. offset i → (i - total).
    let s0 = (start - total).to_string();
    let e0 = (end - 1 - total).to_string();
    let out = tmux::run(&ctx, &["capture-pane", "-p", "-e", "-t", &t, "-S", &s0, "-E", &e0]).unwrap_or_default();
    let body = out.strip_suffix('\n').unwrap_or(&out);
    let lines: Vec<&str> = if body.is_empty() { Vec::new() } else { body.split('\n').collect() };
    let rows: Vec<serde_json::Value> = (0..(end - start))
        .map(|i| {
            let raw = lines.get(i as usize).copied().unwrap_or("").trim_end_matches('\r');
            // ★ 줄마다 속성을 닫는다 — tmux 는 배경이 줄 끝까지 이어지면 리셋을 안 붙인다(실측:
            //   파워라인 프롬프트가 `\e[44m` 을 켠 채 끝난다). 페이지를 이어 붙이는 뷰어에서 그
            //   배경이 이후 모든 줄로 번져 화면이 통째로 물든다. 행은 offset 임의 접근 단위라
            //   애초에 자족적이어야 한다.
            let ansi = if raw.contains('\u{1b}') { format!("{raw}\u{1b}[0m") } else { raw.to_string() };
            serde_json::json!({ "offset": start + i, "text": strip_ansi(&ansi), "ansi": ansi, "wrapped": false })
        })
        .collect();
    Ok(serde_json::json!({ "start": start, "end": end, "total": total, "hasMore": start > 0, "rows": rows }))
}

// win32(term-host)는 tmux history 가 없다 — 빈 과거로 답하고 클라이언트는 오버레이를 안 연다.
#[cfg(windows)]
#[tauri::command]
pub fn pty_history(
    _mgr: State<PtyManager>,
    _pane_id: String,
    _before: Option<i64>,
    _limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    Ok(empty_history_page())
}

// 키 입력(UTF-8 문자열) → PTY stdin.
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_write(ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String, data: String) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        // ⚠ 이 블록은 뮤텍스를 쥔 채 키 하나마다 돈다. tmux 호출을 무조건 걸면 타이핑 지연이
        //   키당 ~11ms 쌓인다(실측 tmux 1회 5.5ms) — 리스 갱신과 크기 재주장 모두 조건부다.
        let now = controller_now_ms();
        if should_refresh_lease(h.last_claim_ms, now) {
            claim_controller(&ctx, &h.target, "pc");
            h.last_claim_ms = now;
        }
        if should_reclaim_size(h.last_write_ms, now) {
            let _ = tmux::run(
                &ctx,
                &["resize-window", "-t", &format!("={}:0", h.target), "-x", &h.last_cols.to_string(), "-y", &h.last_rows.to_string()],
            );
            let _ = h.master.resize(PtySize { rows: h.last_rows, cols: h.last_cols, pixel_width: 0, pixel_height: 0 });
        }
        h.last_write_ms = now;
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
    ctx: State<TmuxCtx>,
    mgr: State<PtyManager>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    if let Some(h) = panes.get_mut(&pane_id) {
        if !controller_allows(&ctx, &h.target, "pc") {
            h.last_cols = cols;
            h.last_rows = rows;
            return Ok(());
        }
        claim_controller(&ctx, &h.target, "pc");
        h.last_claim_ms = controller_now_ms();
        let _ = tmux::run(
            &ctx,
            &["resize-window", "-t", &format!("={}:0", h.target), "-x", &cols.to_string(), "-y", &rows.to_string()],
        );
        h.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize 실패: {e}"))?;
        h.last_cols = cols;
        h.last_rows = rows;
    }
    Ok(())
}

// 크기 주장(claim) — 사용자가 이 pane 을 클릭/포커스/타이핑할 때, 공유 창을 PC 에 마지막으로
//  fit 된 크기로 되돌린다. 모바일과 동일하게 resize-window 를 명시해야 일반 셸에서도 확실히
//  회수된다. 예전 nudge 방식은 alternate-screen 에서만 실행되어 일반 프롬프트가 모바일 크기에
//  고정되는 결함이 있었다. 여기서는 capture-pane 스냅샷을 재주입하지 않는다 — resize 로 tmux 가
//  보내는 실제 재도장과 겹치면 프롬프트 중복·화면 중간의 거대한 여백이 생긴다. 이미 같은 크기면 no-op.
#[cfg(not(windows))]
#[tauri::command]
pub fn pty_claim(app: AppHandle, ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String, _sync: Option<bool>) {
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
        claim_controller(&ctx2, &target, "pc");
        let cur = tmux::run(&ctx2, &["display-message", "-p", "-t", &format!("={target}:0"), "#{window_width} #{window_height}"]).unwrap_or_default();
        let mut it = cur.split_whitespace();
        let cw: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ch: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if cw != cols || ch != rows {
            let _ = tmux::run(
                &ctx2,
                &["resize-window", "-t", &format!("={target}:0"), "-x", &cols.to_string(), "-y", &rows.to_string()],
            );
            if let Some(m) = app.try_state::<PtyManager>() {
                if let Some(h) = m.panes.lock().unwrap().get(&pane_id) {
                    let _ = h.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
            }
        }
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
pub fn pty_claim(_app: AppHandle, _ctx: State<TmuxCtx>, mgr: State<PtyManager>, pane_id: String, _sync: Option<bool>) {
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
