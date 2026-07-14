// tmux 헬퍼 — 데몬과 같은 전용 소켓(-L codingpt)·세션 규칙을 Rust 에서 재현.
//  · 워크스페이스 = tmux 세션(홈='codingpt', 워크스페이스='cpt-<sanitized>'), 서피스 = tmux window.
//  · 데몬(pty.js)의 sessionForCwd / findTmux 규칙과 정확히 일치해야 폰과 세션이 공유된다.
//  · 여기서는 window 관리·git 브랜치·리스닝 포트 등 "제어" 명령만. 실제 스트림은 pty.rs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const TMUX_SOCKET: &str = "codingpt";
pub const TMUX_SESSION: &str = "codingpt"; // 홈 루트 공유 세션(폰 하위호환)

// 번들 tmux / tmux.conf 경로를 앱 리소스에서 해석해 들고 다니는 컨텍스트(설정 시 1회 계산).
#[derive(Clone)]
pub struct TmuxCtx {
    pub tmux: PathBuf,
    pub conf: Option<PathBuf>,
}

// resource_dir 아래 사이드카(bundle-sidecar.sh 산출물)에서 tmux/tmux.conf 를 찾는다.
//  bundle.resources 설정에 따라 daemon/ 또는 resources/daemon/ 하위 → 후보 탐색.
fn bundled_tmux_paths(app: &AppHandle) -> Option<(PathBuf, Option<PathBuf>)> {
    let res = app.path().resource_dir().ok()?;
    for c in ["daemon", "resources/daemon", "_up_/daemon"] {
        let base = res.join(c).join("tmux");
        let bin = base.join("bin").join("tmux");
        if bin.exists() {
            let conf = base.join("tmux.conf");
            let conf = if conf.exists() { Some(conf) } else { None };
            return Some((bin, conf));
        }
    }
    None
}

// TmuxCtx 해석: 번들 tmux 우선 → CODINGPT_TMUX env → PATH/표준 경로. conf 는 번들 우선, 없으면 dev 모노레포 폴백.
pub fn resolve_ctx(app: &AppHandle) -> TmuxCtx {
    if let Some((bin, conf)) = bundled_tmux_paths(app) {
        return TmuxCtx { tmux: bin, conf };
    }
    // dev/미번들 폴백
    let tmux = std::env::var("CODINGPT_TMUX")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| {
            for p in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"] {
                let pb = PathBuf::from(p);
                if pb.exists() {
                    return Some(pb);
                }
            }
            None
        })
        .unwrap_or_else(|| PathBuf::from("tmux"));
    // dev 모노레포 tmux.conf (codingpt_daemon/tmux.conf) 폴백 — 번들 전 로컬 테스트용.
    let conf = std::env::var("CODINGPT_TMUX_CONF")
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.exists());
    TmuxCtx { tmux, conf }
}

// 홈 디렉토리 절대경로.
pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// 홈-상대 localPath → (세션명, 시작 절대경로). 데몬 sessionForCwd 규칙 1:1.
//  빈 경로 = 홈 공유 세션. 그 외 = 'cpt-<sanitize>' @ 홈/localPath.
pub fn session_for(local_path: &str) -> (String, PathBuf) {
    let lp = local_path.trim().trim_matches('/');
    if lp.is_empty() {
        return (TMUX_SESSION.to_string(), home());
    }
    let abs = home().join(lp);
    // JS: replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'')
    let mut safe = String::with_capacity(lp.len());
    let mut prev_dash = false;
    for ch in lp.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            safe.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            safe.push('-');
            prev_dash = true;
        }
    }
    let safe = safe.trim_matches('-').to_string();
    let safe = if safe.is_empty() { "ws".to_string() } else { safe };
    (format!("cpt-{safe}"), abs)
}

// pane 별 "독립" 세션명 — 데몬 pty.js paneSession 과 동일 규칙("<primary>--p-<paneId>").
//  grouped view(--view--)의 current-window 불안정(여러 pane 이 같은 window 를 비추는 복제)을
//  원천 제거: pane = 자기 세션, 탭 = 그 세션의 window. 모바일 데몬과 같은 아키텍처.
pub fn pane_session(session: &str, pane_id: &str) -> String {
    let safe: String = pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    format!("{session}--p-{safe}")
}

// 전용 소켓으로 tmux 실행(제어 명령). 자식 env 의 TMUX 제거(데몬이 cmux 안에서 돌 수 있음).
pub fn run(ctx: &TmuxCtx, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(&ctx.tmux);
    cmd.arg("-L").arg(TMUX_SOCKET);
    cmd.args(args);
    cmd.env_remove("TMUX");
    let out = cmd.output().map_err(|e| format!("tmux 실행 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// 워크스페이스 primary 세션 보장(없으면 detached 생성 + conf 적용). 서버가 처음이면 -f 로 conf 로드.
//  주의: tmux -t 는 접두사 매칭이라, 풀 세션이 없을 때 이름을 확장한 뷰 세션(--p-...)이 대신 매칭돼
//  명령이 엉뚱한 세션에 떨어진다 → 세션 타겟은 반드시 '=' 정확 일치로 지정한다(이 파일 전체 규칙).
pub fn ensure_session(ctx: &TmuxCtx, session: &str, abs: &PathBuf) -> Result<(), String> {
    // 이미 있으면 아무것도 안 함.
    if run(ctx, &["has-session", "-t", &format!("={session}")]).is_ok() {
        return Ok(());
    }
    let abs_s = abs.to_string_lossy().to_string();
    let mut args: Vec<String> = Vec::new();
    if let Some(conf) = &ctx.conf {
        args.push("-f".into());
        args.push(conf.to_string_lossy().to_string());
    }
    args.extend(["new-session", "-d", "-s", session, "-c", &abs_s].map(String::from));
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    match run(ctx, &refs) {
        Ok(_) => Ok(()),
        // 여러 pane 이 동시에 부팅하며 같은 풀을 만들려는 레이스 — 이미 생겼으면 성공으로 간주.
        Err(e) if e.contains("duplicate session") => Ok(()),
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
pub struct WindowInfo {
    pub index: i64,
    pub active: bool,
    pub name: String,
    pub command: String,
    pub id: String,
}

// 세션의 window 목록(이름 포함 — 공유 풀의 "내역" 원천).
pub fn list_windows(ctx: &TmuxCtx, session: &str) -> Vec<WindowInfo> {
    let out = match run(
        ctx,
        &[
            "list-windows",
            "-t",
            &format!("={session}"),
            "-F",
            "#{window_index}\t#{window_active}\t#{window_id}\t#{window_name}\t#{pane_current_command}",
        ],
    ) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    out.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let parts: Vec<&str> = l.splitn(5, '\t').collect();
            WindowInfo {
                index: parts.first().and_then(|s| s.trim().parse().ok()).unwrap_or(0),
                active: parts.get(1).map(|s| *s == "1").unwrap_or(false),
                id: parts.get(2).map(|s| s.trim().to_string()).unwrap_or_default(),
                name: parts.get(3).map(|s| s.trim().to_string()).unwrap_or_default(),
                command: parts.get(4).map(|s| s.trim().to_string()).unwrap_or_default(),
            }
        })
        .collect()
}

// 다음 풀 터미널 이름("터미널 N") — 이름이 tmux window 에 저장돼 전 기기 동일하게 보인다.
fn next_pool_name(wins: &[WindowInfo]) -> String {
    let mut max = 0i64;
    for w in wins {
        if let Some(rest) = w.name.strip_prefix("터미널 ") {
            if let Ok(n) = rest.trim().parse::<i64>() {
                if n > max {
                    max = n;
                }
            }
        }
    }
    format!("터미널 {}", max + 1)
}

#[derive(Serialize)]
pub struct NewWindowInfo {
    pub index: i64,
    pub name: String,
}

// pane 뷰 세션의 클라이언트 크기로 풀 window 를 맞춘다 — "마지막 입력"이 아니라 "포커스" 기준 리사이즈.
//  resize-window 는 그 window 를 manual 크기로 고정하므로 이후 크기는 오직 포커스(view) 이동으로만 바뀐다.
pub fn resize_to_client(ctx: &TmuxCtx, psess: &str, session: &str, win: i64) {
    let out = match run(ctx, &["list-clients", "-t", &format!("={psess}"), "-F", "#{client_width} #{client_height}"]) {
        Ok(o) => o,
        Err(_) => return,
    };
    if let Some(line) = out.lines().find(|l| !l.trim().is_empty()) {
        let mut it = line.split_whitespace();
        if let (Some(w), Some(h)) = (it.next(), it.next()) {
            if w.parse::<i64>().unwrap_or(0) > 0 && h.parse::<i64>().unwrap_or(0) > 0 {
                let _ = run(ctx, &["resize-window", "-t", &format!("={session}:{win}"), "-x", w, "-y", h]);
            }
        }
    }
}

// pane 뷰 세션 보장 + 풀 window(win)를 같은 인덱스로 link + select — 데몬 ensureView 미러.
//  · 풀 window 가 없으면(스테일 win 자가치유) 그 인덱스에 새 터미널을 만든다.
//  · 뷰 세션 최초 생성 시 기본 셸(window 0)은 999 로 파킹했다가 링크 후 제거.
// 반환 = 실제로 링크/선택한 풀 인덱스 — 요청 win 이 스테일이면 폴백으로 바뀌므로 호출측
//  리사이즈는 반드시 이 값을 써야 한다(스테일 인덱스로 resize 하면 표시 창이 기본 크기로 남는다).
pub fn ensure_view(ctx: &TmuxCtx, psess: &str, session: &str, win: i64, abs: &PathBuf) -> Result<i64, String> {
    let abs_s = abs.to_string_lossy().to_string();
    if run(ctx, &["has-session", "-t", &format!("={session}")]).is_err() {
        ensure_session(ctx, session, abs)?;
        let _ = run(ctx, &["rename-window", "-t", &format!("={session}:0"), "터미널 1"]);
    }
    let mut win = win;
    let mut wins = list_windows(ctx, session);
    if !wins.iter().any(|w| w.index == win) {
        // 재생성 금지 — 그 인덱스에 창을 다시 만들면 다른 기기가 닫은 터미널이 스테일 참조/재연결마다
        //  부활한다. 죽은 win 은 풀의 첫 터미널로 폴백(레이아웃 정리는 리컨실러 몫), 풀이 비었을 때만 생성.
        if wins.is_empty() {
            let _ = run(ctx, &["new-window", "-d", "-t", &format!("={session}:0"), "-n", "터미널 1", "-c", &abs_s]);
            wins = list_windows(ctx, session);
        }
        match wins.first() {
            Some(f) => win = f.index,
            None => return Err("터미널 window 확보 실패".to_string()),
        }
    }
    let target_id = wins
        .iter()
        .find(|w| w.index == win)
        .map(|w| w.id.clone())
        .ok_or_else(|| "터미널 window 확보 실패".to_string())?;
    if run(ctx, &["has-session", "-t", &format!("={psess}")]).is_err() {
        match run(ctx, &["new-session", "-d", "-s", psess, "-c", &abs_s]) {
            Ok(_) => {}
            Err(e) if e.contains("duplicate session") => {}
            Err(e) => return Err(e),
        }
        let _ = run(ctx, &["move-window", "-s", &format!("={psess}:0"), "-t", &format!("={psess}:999")]);
    }
    let slots = list_windows(ctx, psess);
    let slot = slots.iter().find(|w| w.index == win);
    let needs_link = match slot {
        Some(s) if s.id == target_id => false,
        Some(_) => {
            let _ = run(ctx, &["unlink-window", "-t", &format!("={psess}:{win}")]);
            true
        }
        None => true,
    };
    if needs_link {
        run(ctx, &["link-window", "-s", &format!("={session}:{win}"), "-t", &format!("={psess}:{win}")])?;
    }
    run(ctx, &["select-window", "-t", &format!("={psess}:{win}")])?;
    let _ = run(ctx, &["kill-window", "-t", &format!("={psess}:999")]); // temp 셸 정리(전용이라 무해)
    resize_to_client(ctx, psess, session, win); // 포커스한 pane 크기로 즉시 맞춤(클라이언트 미접속이면 무시)
    Ok(win)
}

// 풀에 새 터미널 생성(전 기기에 나타남) — 데몬 terminal.new 미러. 풀이 없으면 window 0 이 곧 새 터미널.
pub fn new_window(ctx: &TmuxCtx, session: &str, abs: &PathBuf, psess: Option<&str>) -> Result<NewWindowInfo, String> {
    if run(ctx, &["has-session", "-t", &format!("={session}")]).is_err() {
        ensure_session(ctx, session, abs)?;
        let _ = run(ctx, &["rename-window", "-t", &format!("={session}:0"), "터미널 1"]);
        if let Some(p) = psess {
            resize_to_client(ctx, p, session, 0);
        }
        return Ok(NewWindowInfo { index: 0, name: "터미널 1".to_string() });
    }
    let name = next_pool_name(&list_windows(ctx, session));
    let abs_s = abs.to_string_lossy().to_string();
    // -d: attach 중인 클라이언트 화면을 즉시 바꾸지 않음(전환은 호출측 view 가 담당).
    let out = run(
        ctx,
        &["new-window", "-d", "-t", &format!("={session}"), "-n", &name, "-c", &abs_s, "-P", "-F", "#{window_index}"],
    )?;
    let index: i64 = out.trim().parse().unwrap_or(0);
    // 요청 pane 클라이언트 크기로 즉시 맞춤 — 기본 크기→실크기 리사이즈 재프롬프트가 안 쌓이게.
    if let Some(p) = psess {
        resize_to_client(ctx, p, session, index);
    }
    Ok(NewWindowInfo { index, name })
}

// 서피스(window) 종료.
pub fn kill_window(ctx: &TmuxCtx, session: &str, index: i64) -> Result<(), String> {
    run(ctx, &["kill-window", "-t", &format!("={session}:{index}")]).map(|_| ())
}

// git 현재 브랜치(사이드바 표시용). 실패 시 None.
pub fn git_branch(abs: &PathBuf) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(abs)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b.is_empty() || b == "HEAD" {
        None
    } else {
        Some(b)
    }
}

// 로컬 리스닝 TCP 포트 목록(프리뷰/사이드바 배지). lsof 기반, 실패 시 빈 목록.
// LISTEN 소켓 → [(pid, port)] (프로세스별 그룹). -Fpn: p<pid> 블록 + n<name> 라인.
fn listen_sockets() -> Vec<(u32, u16)> {
    let out = match Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut rows: Vec<(u32, u16)> = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse::<u32>().ok();
        } else if let Some(rest) = line.strip_prefix('n') {
            if let (Some(p), Some(idx)) = (pid, rest.rfind(':')) {
                if let Ok(port) = rest[idx + 1..].parse::<u16>() {
                    if port >= 1024 {
                        rows.push((p, port));
                    }
                }
            }
        }
    }
    rows
}

// pid[] → { pid: cwd(절대경로) }. 각 프로세스의 현재 작업 디렉토리.
fn cwds_for(pids: &[u32]) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    if pids.is_empty() {
        return map;
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let out = match Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &list])
        .output()
    {
        Ok(o) => o,
        Err(_) => return map,
    };
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse::<u32>().ok();
        } else if let Some(rest) = line.strip_prefix('n') {
            if let Some(p) = pid {
                map.insert(p, rest.to_string());
            }
        }
    }
    map
}

// LISTEN 중인 로컬 포트. filter 를 주면 그 폴더 아래에서 도는 프로세스의 포트만(그 워크스페이스
//  터미널에서 띄운 dev 서버만 감지 — 시스템/타 폴더 포트 제외).
pub fn listen_ports_in(filter: Option<&Path>) -> Vec<u16> {
    let rows = listen_sockets();
    if rows.is_empty() {
        return vec![];
    }
    let mut ports: Vec<u16> = Vec::new();
    match filter {
        None => {
            for (_pid, port) in rows {
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
        Some(base) => {
            let mut pids: Vec<u32> = rows.iter().map(|r| r.0).collect();
            pids.sort_unstable();
            pids.dedup();
            let cwds = cwds_for(&pids);
            let base_str = base.to_string_lossy();
            let base_trim = base_str.trim_end_matches('/');
            let prefix = format!("{base_trim}/");
            for (pid, port) in rows {
                if let Some(c) = cwds.get(&pid) {
                    if (c == base_trim || c.starts_with(&prefix)) && !ports.contains(&port) {
                        ports.push(port);
                    }
                }
            }
        }
    }
    ports.sort_unstable();
    ports
}

// ── 프론트 노출 커맨드 ──

#[tauri::command]
pub fn tmux_list_windows(ctx: tauri::State<TmuxCtx>, local_path: String) -> Vec<WindowInfo> {
    let (session, _abs) = session_for(&local_path);
    list_windows(&ctx, &session)
}

#[tauri::command]
pub fn tmux_new_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    pane_id: Option<String>,
) -> Result<NewWindowInfo, String> {
    let (session, abs) = session_for(&local_path);
    let psess = pane_id.as_deref().map(|p| pane_session(&session, p));
    new_window(&ctx, &session, &abs, psess.as_deref())
}

// 풀에서 완전 삭제(전 기기 공통) — 링크된 모든 뷰에서 사라지고, 마지막 링크였던 뷰 세션은 소멸.
#[tauri::command]
pub fn tmux_kill_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    index: i64,
) -> Result<(), String> {
    let (session, _abs) = session_for(&local_path);
    kill_window(&ctx, &session, index)
}

// = view: 이 pane 뷰 세션에 풀 window 를 링크 + 선택(탭 전환/드롭 이동 공용).
#[tauri::command]
pub fn tmux_view_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    pane_id: String,
    index: i64,
) -> Result<i64, String> {
    let (session, abs) = session_for(&local_path);
    let psess = pane_session(&session, &pane_id);
    ensure_view(&ctx, &psess, &session, index, &abs)
}

// pane 뷰에서 탭 제거(풀 window 는 보존) — 드래그 이동의 src 측.
#[tauri::command]
pub fn tmux_unview_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    pane_id: String,
    index: i64,
) -> Result<(), String> {
    let (session, _abs) = session_for(&local_path);
    let psess = pane_session(&session, &pane_id);
    let n = list_windows(&ctx, &psess).len();
    if n == 0 {
        return Ok(());
    }
    if n <= 1 {
        let _ = run(&ctx, &["kill-session", "-t", &format!("={psess}")]);
        return Ok(());
    }
    let _ = run(&ctx, &["unlink-window", "-t", &format!("={psess}:{index}")]);
    Ok(())
}

#[tauri::command]
pub fn tmux_git_branch(local_path: String) -> Option<String> {
    let (_session, abs) = session_for(&local_path);
    git_branch(&abs)
}

#[tauri::command]
pub fn tmux_listen_ports(local_path: String) -> Vec<u16> {
    // 워크스페이스 폴더 안에서 도는 프로세스의 포트만. 빈 경로(홈)면 필터 없음(하위호환).
    if local_path.trim().is_empty() {
        return listen_ports_in(None);
    }
    let (_session, abs) = session_for(&local_path);
    listen_ports_in(Some(&abs))
}
