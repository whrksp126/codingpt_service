// tmux 헬퍼 — 데몬과 같은 전용 소켓(-L codingpt)·세션 규칙을 Rust 에서 재현.
//  · 워크스페이스 = tmux 세션(홈='codingpt', 워크스페이스='cpt-<sanitized>'), 서피스 = tmux window.
//  · 데몬(pty.js)의 sessionForCwd / findTmux 규칙과 정확히 일치해야 폰과 세션이 공유된다.
//  · 여기서는 window 관리·git 브랜치·리스닝 포트 등 "제어" 명령만. 실제 스트림은 pty.rs.

use std::path::PathBuf;
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
pub fn ensure_session(ctx: &TmuxCtx, session: &str, abs: &PathBuf) -> Result<(), String> {
    // 이미 있으면 아무것도 안 함.
    if run(ctx, &["has-session", "-t", session]).is_ok() {
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
    run(ctx, &refs).map(|_| ())
}

#[derive(Serialize)]
pub struct WindowInfo {
    pub index: i64,
    pub active: bool,
    pub command: String,
}

// 세션의 window(서피스) 목록.
pub fn list_windows(ctx: &TmuxCtx, session: &str) -> Vec<WindowInfo> {
    let out = match run(
        ctx,
        &[
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}\t#{window_active}\t#{pane_current_command}",
        ],
    ) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    out.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let parts: Vec<&str> = l.splitn(3, '\t').collect();
            WindowInfo {
                index: parts.first().and_then(|s| s.trim().parse().ok()).unwrap_or(0),
                active: parts.get(1).map(|s| *s == "1").unwrap_or(false),
                command: parts.get(2).map(|s| s.trim().to_string()).unwrap_or_default(),
            }
        })
        .collect()
}

// 새 서피스(window) 생성 → 인덱스 반환. 세션 없으면 생성 후 재시도.
pub fn new_window(ctx: &TmuxCtx, session: &str, abs: &PathBuf) -> Result<i64, String> {
    ensure_session(ctx, session, abs)?;
    let abs_s = abs.to_string_lossy().to_string();
    let out = run(
        ctx,
        &["new-window", "-t", session, "-c", &abs_s, "-P", "-F", "#{window_index}"],
    )?;
    Ok(out.trim().parse().unwrap_or(0))
}

// 서피스(window) 종료.
pub fn kill_window(ctx: &TmuxCtx, session: &str, index: i64) -> Result<(), String> {
    run(ctx, &["kill-window", "-t", &format!("{session}:{index}")]).map(|_| ())
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
pub fn listen_ports() -> Vec<u16> {
    let out = match Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut ports: Vec<u16> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // -Fn: n<name> 라인. name 예: 127.0.0.1:3000 또는 *:8080
        if let Some(rest) = line.strip_prefix('n') {
            if let Some(idx) = rest.rfind(':') {
                if let Ok(p) = rest[idx + 1..].parse::<u16>() {
                    if p >= 1024 && !ports.contains(&p) {
                        ports.push(p);
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
pub fn tmux_new_window(ctx: tauri::State<TmuxCtx>, local_path: String) -> Result<i64, String> {
    let (session, abs) = session_for(&local_path);
    new_window(&ctx, &session, &abs)
}

#[tauri::command]
pub fn tmux_kill_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    index: i64,
) -> Result<(), String> {
    let (session, _abs) = session_for(&local_path);
    kill_window(&ctx, &session, index)
}

#[tauri::command]
pub fn tmux_git_branch(local_path: String) -> Option<String> {
    let (_session, abs) = session_for(&local_path);
    git_branch(&abs)
}

#[tauri::command]
pub fn tmux_listen_ports() -> Vec<u16> {
    listen_ports()
}
