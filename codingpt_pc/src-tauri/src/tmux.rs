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
    // 이미 있으면 자동 개명 마이그레이션만 보장(프로세스당 세션 1회).
    if run(ctx, &["has-session", "-t", &format!("={session}")]).is_ok() {
        ensure_auto_rename_once(ctx, session);
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
    let created = match run(ctx, &refs) {
        Ok(_) => Ok(()),
        // 여러 pane 이 동시에 부팅하며 같은 풀을 만들려는 레이스 — 이미 생겼으면 성공으로 간주.
        Err(e) if e.contains("duplicate session") => Ok(()),
        Err(e) => Err(e),
    };
    if created.is_ok() {
        inject_pool_env(ctx, session, abs);
        ensure_auto_rename_once(ctx, session);
    }
    created
}

// ensure_auto_rename 의 프로세스당 세션 1회 래퍼 — ensure_session 이 pane 부팅마다 불리므로 절약.
fn ensure_auto_rename_once(ctx: &TmuxCtx, session: &str) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static DONE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let done = DONE.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut g = done.lock().unwrap();
        if !g.insert(session.to_string()) {
            return;
        }
    }
    ensure_auto_rename(ctx, session);
}

// 자동 개명(automatic-rename) 보장 — 셸 대기=폴더명, 실행 중=앱 OSC 타이틀(pane_title)→프로세스명
//  폴백(cmux 탭 UX, 데몬 미러). 셸이 쏘는 "user@host:path" 타이틀은 걸러낸다.
//  포맷은 데몬 tmux.conf·pty.js 와 3벌 동기 — 한쪽만 수정 금지.
//  이미 떠 있는 서버(구 conf)에도 전역 옵션을 런타임 주입하고, 구 빌드가 -n 으로 만들어
//  per-window automatic-rename 이 꺼진 "터미널 N" window 를 개별로 다시 켠다(수동 이름은 보존).
const AUTO_RENAME_FMT: &str =
    "#{?#{||:#{==:#{pane_current_command},zsh},#{||:#{==:#{pane_current_command},bash},#{||:#{==:#{pane_current_command},sh},#{||:#{==:#{pane_current_command},fish},#{||:#{==:#{pane_current_command},-zsh},#{||:#{==:#{pane_current_command},-bash},#{==:#{pane_current_command},login}}}}}}},#{b:pane_current_path},#{?#{&&:#{!=:#{pane_title},},#{&&:#{!=:#{pane_title},#{host}},#{&&:#{!=:#{pane_title},#{host_short}},#{?#{m:*@#{host_short}*,#{pane_title}},0,1}}}},#{pane_title},#{pane_current_command}}}";
pub fn ensure_auto_rename(ctx: &TmuxCtx, session: &str) {
    let _ = run(ctx, &["set-window-option", "-g", "automatic-rename-format", AUTO_RENAME_FMT]);
    let _ = run(ctx, &["set-window-option", "-g", "automatic-rename", "on"]);
    for w in list_windows(ctx, session) {
        let is_legacy = w
            .name
            .strip_prefix("터미널 ")
            .map(|rest| rest.trim().parse::<i64>().is_ok())
            .unwrap_or(false);
        if is_legacy {
            let _ = run(ctx, &["set-window-option", "-t", &format!("={session}:{}", w.index), "automatic-rename", "on"]);
        }
    }
}

// 풀 세션 환경에 cpt CLI 좌표 주입 — 이후 생성되는 window 셸이 상속(데몬 injectPoolEnv 미러).
//  PC 가 풀을 먼저 만들어도 터미널 안의 `cpt` 가 자기 워크스페이스/소켓을 알 수 있게 한다.
fn inject_pool_env(ctx: &TmuxCtx, session: &str, abs: &PathBuf) {
    let h = home();
    let rel = abs
        .strip_prefix(&h)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().to_string());
    let sock = h.join(".codingpt").join("cpt.sock").to_string_lossy().to_string();
    let tmux_bin = ctx.tmux.to_string_lossy().to_string();
    let target = format!("={session}");
    let _ = run(ctx, &["set-environment", "-t", &target, "CPT_WS", &rel]);
    let _ = run(ctx, &["set-environment", "-t", &target, "CPT_SOCK", &sock]);
    let _ = run(ctx, &["set-environment", "-t", &target, "CPT_TMUX", &tmux_bin]);
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
    let line = match out.lines().find(|l| !l.trim().is_empty()) {
        Some(l) => l,
        None => return,
    };
    let mut it = line.split_whitespace();
    let (w, h) = match (it.next(), it.next()) {
        (Some(w), Some(h)) => (w, h),
        _ => return,
    };
    let (wi, hi) = (w.parse::<i64>().unwrap_or(0), h.parse::<i64>().unwrap_or(0));
    if wi <= 0 || hi <= 0 {
        return;
    }
    // 이미 같은 크기면 스킵 — 다른 기기와 크기 주장이 교차할 때 불필요한 SIGWINCH 로 셸 프롬프트가
    //  스크롤백에 누적되는 것을 막는다(데몬 resizeToClient 미러).
    if let Ok(cur) = run(ctx, &["list-windows", "-t", &format!("={session}"), "-F", "#{window_index} #{window_width} #{window_height}"]) {
        for l in cur.lines() {
            let mut p = l.split_whitespace();
            if let (Some(idx), Some(cw), Some(ch)) = (p.next(), p.next(), p.next()) {
                if idx.parse::<i64>().unwrap_or(-1) == win
                    && cw.parse::<i64>().unwrap_or(0) == wi
                    && ch.parse::<i64>().unwrap_or(0) == hi
                {
                    return; // 이미 맞음
                }
            }
        }
    }
    let _ = run(ctx, &["resize-window", "-t", &format!("={session}:{win}"), "-x", w, "-y", h]);
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
    }
    let mut win = win;
    let mut wins = list_windows(ctx, session);
    if !wins.iter().any(|w| w.index == win) {
        // 재생성 금지 — 그 인덱스에 창을 다시 만들면 다른 기기가 닫은 터미널이 스테일 참조/재연결마다
        //  부활한다. 죽은 win 은 풀의 첫 터미널로 폴백(레이아웃 정리는 리컨실러 몫), 풀이 비었을 때만 생성.
        //  -n 금지 — 명시 이름은 그 window 의 automatic-rename 을 끈다.
        if wins.is_empty() {
            let _ = run(ctx, &["new-window", "-d", "-t", &format!("={session}:0"), "-c", &abs_s]);
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
    // 뷰 세션(psess) 준비 + 링크 + 선택 — 소켓(-L codingpt)을 공유하는 (번들) 데몬의 reapStaleViews 가
    //  attach=0 인 이 pane 뷰 세션을 재사용 직전에 지우면 link/select 가 "can't find window/session"
    //  으로 터졌다. 특히 앱 업데이트에서 결정적으로 재현: 다운로드+설치+재실행이 리퍼 grace(90s)를
    //  넘겨 이 세션이 idle 로 판정 → 재기동한 번들 데몬의 startup reap 이 킬 → 레이아웃 복원 attach 와
    //  충돌(사용자가 매 업데이트마다 본 "터미널 연결 실패: can't find window: 0"). 뷰 세션은 고유
    //  상태가 없어 재생성이 멱등 → 최대 3회 재생성 재시도로 레이스를 흡수한다(데몬 JS ensureView 미러).
    let is_race = |e: &str| {
        let l = e.to_lowercase();
        l.contains("can't find session") || l.contains("can't find window") || l.contains("no server running")
    };
    let mut last_err = String::new();
    let mut linked = false;
    for _attempt in 0..3 {
        if run(ctx, &["has-session", "-t", &format!("={psess}")]).is_err() {
            match run(ctx, &["new-session", "-d", "-s", psess, "-c", &abs_s]) {
                Ok(_) => {}
                Err(e) if e.contains("duplicate session") => {}
                Err(e) => { last_err = e; std::thread::sleep(std::time::Duration::from_millis(120)); continue; }
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
            if let Err(e) = run(ctx, &["link-window", "-s", &format!("={session}:{win}"), "-t", &format!("={psess}:{win}")]) {
                if is_race(&e) { last_err = e; std::thread::sleep(std::time::Duration::from_millis(120)); continue; }
                return Err(e);
            }
        }
        if let Err(e) = run(ctx, &["select-window", "-t", &format!("={psess}:{win}")]) {
            if is_race(&e) { last_err = e; std::thread::sleep(std::time::Duration::from_millis(120)); continue; }
            return Err(e);
        }
        linked = true;
        break;
    }
    if !linked {
        return Err(if last_err.is_empty() { "뷰 세션 준비 실패".to_string() } else { last_err });
    }
    let _ = run(ctx, &["kill-window", "-t", &format!("={psess}:999")]); // temp 셸 정리(전용이라 무해)
    resize_to_client(ctx, psess, session, win); // 포커스한 pane 크기로 즉시 맞춤(클라이언트 미접속이면 무시)
    Ok(win)
}

// 풀에 새 터미널 생성(전 기기에 나타남) — 데몬 terminal.new 미러. 풀이 없으면 window 0 이 곧 새 터미널.
//  이름은 자동 개명(automatic-rename)이 부여 — -n 지정은 그 window 의 자동 개명을 꺼서 금지.
pub fn new_window(ctx: &TmuxCtx, session: &str, abs: &PathBuf, psess: Option<&str>) -> Result<NewWindowInfo, String> {
    if run(ctx, &["has-session", "-t", &format!("={session}")]).is_err() {
        ensure_session(ctx, session, abs)?;
        if let Some(p) = psess {
            resize_to_client(ctx, p, session, 0);
        }
        let name = list_windows(ctx, session)
            .iter()
            .find(|w| w.index == 0)
            .map(|w| w.name.clone())
            .unwrap_or_default();
        return Ok(NewWindowInfo { index: 0, name });
    }
    let abs_s = abs.to_string_lossy().to_string();
    // -d: attach 중인 클라이언트 화면을 즉시 바꾸지 않음(전환은 호출측 view 가 담당).
    let out = run(
        ctx,
        &["new-window", "-d", "-t", &format!("={session}"), "-c", &abs_s, "-P", "-F", "#{window_index}\t#{window_name}"],
    )?;
    let mut it = out.trim().splitn(2, '\t');
    let index: i64 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let name = it.next().unwrap_or("").trim().to_string();
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
pub fn tmux_listen_ports(local_path: String) -> Vec<u16> {
    // 워크스페이스 폴더 안에서 도는 프로세스의 포트만. 빈 경로(홈)면 필터 없음(하위호환).
    if local_path.trim().is_empty() {
        return listen_ports_in(None);
    }
    let (_session, abs) = session_for(&local_path);
    listen_ports_in(Some(&abs))
}
