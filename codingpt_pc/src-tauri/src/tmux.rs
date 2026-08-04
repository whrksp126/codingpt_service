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

// ── 터미널 = 전용 tmux 세션(신 아키텍처, 데몬 pty.js termSession 미러) ──
//  터미널 하나 = 세션 "<ns>--t-<tid>" 하나(window 0 하나). ns = 워크스페이스 네임스페이스(session_for).
//  tid = 안정적 숫자 ID(31-bit 랜덤) — 와이어/영속(pc-ui.json tab.win)의 기존 숫자 자리에 그대로.
//  뷰 세션/link-window/인덱스 간접층을 전면 폐기: attach 대상이 곧 실체라 "can't find window/session"
//  레이스 클래스가 구조적으로 사라진다(세션 부재 = 사용자가 닫음이라는 결정적 상태뿐).
pub fn term_session(ns: &str, tid: i64) -> String {
    format!("{ns}--t-{tid}")
}
// 레거시 작은 인덱스(0~수십)와 절대 안 겹치게 1e6 이상, `|0` 경유에도 안전한 31-bit 안.
pub fn new_tid() -> i64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as i64)
        .unwrap_or(0);
    let pid = std::process::id() as i64;
    1_000_000 + ((nanos.wrapping_mul(2_654_435_761) ^ (pid << 16)).rem_euclid(0x7fff_ffff - 2_000_000))
}

// 전용 소켓으로 tmux 실행(제어 명령). 자식 env 의 TMUX 제거(데몬이 cmux 안에서 돌 수 있음).
//  UTF-8 로케일 강제(데몬 pty.js 242 미러) — Finder/독 실행 앱엔 LANG 이 없어 POSIX C 로케일이
//  되고, 그러면 tmux 가 출력의 제어문자(탭 구분자!)와 한글을 '_' 로 이스케이프해 list 파싱이
//  전멸한다(살아있는 세션이 0개로 보여 탭 오소거 — 2일 추적 끝에 확정한 실사고 근원).
//  pty.rs 스트림 spawn 엔 이미 있었고 이 제어 경로에만 빠져 있었다.
pub fn run(ctx: &TmuxCtx, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(&ctx.tmux);
    cmd.arg("-L").arg(TMUX_SOCKET);
    cmd.args(args);
    cmd.env_remove("TMUX");
    let utf8 = |v: std::ffi::OsString| {
        let s = v.to_string_lossy().to_uppercase();
        s.contains("UTF-8") || s.contains("UTF8")
    };
    if !std::env::var_os("LANG").map(utf8).unwrap_or(false) {
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_CTYPE", "en_US.UTF-8");
    }
    let out = cmd.output().map_err(|e| format!("tmux 실행 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// 주의: tmux -t 는 접두사 매칭 — 세션 타겟은 반드시 '=' 정확 일치로 지정한다(이 파일 전체 규칙).
// detached 세션 생성(+서버 첫 기동이면 -f 로 conf 로드). duplicate = Err(호출측이 tid 재시도/스킵) —
//  성공으로 뭉개면 기존 터미널 세션을 오인 점유(마이그레이션 move-window -k 덮어쓰기)할 수 있다.
fn new_detached_session(ctx: &TmuxCtx, name: &str, abs: &PathBuf) -> Result<(), String> {
    let abs_s = abs.to_string_lossy().to_string();
    let mut args: Vec<String> = Vec::new();
    if let Some(conf) = &ctx.conf {
        args.push("-f".into());
        args.push(conf.to_string_lossy().to_string());
    }
    args.extend(["new-session", "-d", "-s", name, "-c", &abs_s].map(String::from));
    // ⚠ 초기 셸에 shim env(-e)를 spawn 시점 주입 — set-environment(inject_pool_env)는 이미 뜬 셸엔
    //  안 먹어(tmux 세션 env 는 이후 spawn 프로세스만 상속), new-session 이 셸을 즉시 띄우므로 ZDOTDIR/
    //  PATH 를 못 받아 shim(open→프리뷰·cpt·훅)이 비활성이었다(실측: PC 생성 터미널 bare open → 외부 브라우저).
    //  데몬 pty.js poolEnvArgs 미러. tmux 3.2+ -e 지원.
    args.extend(pool_env_args(ctx, abs));
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(ctx, &refs).map(|_| ())
}

// new-session -e 로 넣을 env(-e KEY=VAL) 목록 — 초기 셸부터 shim 활성화. inject_pool_env(세션 env 영속)와
//  같은 값이되, 이건 spawn 시점 적용이라 초기 셸이 바로 받는다.
fn pool_env_args(ctx: &TmuxCtx, abs: &PathBuf) -> Vec<String> {
    let h = home();
    let rel = abs
        .strip_prefix(&h)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().to_string());
    let cptdir = h.join(".codingpt");
    let sock = cptdir.join("cpt.sock").to_string_lossy().to_string();
    let bin = cptdir.join("bin").to_string_lossy().to_string();
    let zdot = cptdir.join("shim").join("zdot");
    let tmux_bin = ctx.tmux.to_string_lossy().to_string();
    let base_path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
    let mut out: Vec<String> = Vec::new();
    out.push("-e".into()); out.push(format!("CPT_WS={rel}"));
    out.push("-e".into()); out.push(format!("CPT_SOCK={sock}"));
    out.push("-e".into()); out.push(format!("CPT_TMUX={tmux_bin}"));
    out.push("-e".into()); out.push(format!("PATH={bin}:{base_path}"));
    if zdot.exists() {
        let z = zdot.to_string_lossy().to_string();
        out.push("-e".into()); out.push(format!("ZDOTDIR={z}"));
        if let Ok(orig) = std::env::var("ZDOTDIR") {
            if !orig.is_empty() && orig != z {
                out.push("-e".into()); out.push(format!("CPT_ORIG_ZDOTDIR={orig}"));
            }
        }
    }
    out
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
    // PATH/ZDOTDIR 도 세션 env 에 — 재spawn(respawn-pane) 되는 셸이 shim 을 잃지 않게(데몬 injectPoolEnv 미러).
    let bin = h.join(".codingpt").join("bin").to_string_lossy().to_string();
    let base_path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
    let _ = run(ctx, &["set-environment", "-t", &target, "PATH", &format!("{bin}:{base_path}")]);
    let zdot = h.join(".codingpt").join("shim").join("zdot");
    if zdot.exists() {
        let z = zdot.to_string_lossy().to_string();
        let _ = run(ctx, &["set-environment", "-t", &target, "ZDOTDIR", &z]);
        if let Ok(orig) = std::env::var("ZDOTDIR") {
            if !orig.is_empty() && orig != z {
                let _ = run(ctx, &["set-environment", "-t", &target, "CPT_ORIG_ZDOTDIR", &orig]);
            }
        }
    }
}

#[derive(Serialize)]
pub struct WindowInfo {
    pub index: i64,
    pub active: bool,
    pub name: String,
    pub command: String,
    pub id: String,
    // ※ pane_title 원본은 싣지 않는다(2026-07-25 교차실행으로 되돌림). 토글 판정의 보조 재료로 넣었지만
    //  JS 사다리에서 **도달 불가**였다 — 자동 개명 포맷은 셸=폴더명 / 그 외=pane_title|pane_current_command
    //  로 window_name 을 항상 비지 않게 채우고, 수동 rename 은 사용자 이름이 얼어붙으므로 `name` 이 빈
    //  경우가 없다. 이름이 얼어붙어 글리프를 잃는 터미널은 사다리 ④(신호 없으면 켠다)가 흡수한다.
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

// 워크스페이스의 터미널 목록 — 전용 세션들을 훑어 [{index(tid), name, command}] 생성순 정렬.
//  window name(자동 개명)이 곧 전 기기 공유 탭 이름.
//  "서버 없음" = 터미널 0개(정상) → Ok(빈 목록). 그 외 오류 = Err — 호출측(리컨실러)이 빈 목록을
//  "전부 삭제됨" 으로 신뢰할 수 있게 오류와 진짜 0개를 구분한다.
pub fn list_terminals(ctx: &TmuxCtx, ns: &str) -> Result<Vec<WindowInfo>, String> {
    let out = match run(
        ctx,
        &["list-windows", "-a", "-F", "#{session_name}\t#{session_created}\t#{window_name}\t#{pane_current_command}"],
    ) {
        Ok(o) => o,
        Err(e) => {
            if e.to_lowercase().contains("no server running") {
                return Ok(vec![]);
            }
            return Err(e);
        }
    };
    let prefix = format!("{ns}--t-");
    let mut rows: Vec<(i64, i64, WindowInfo)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for l in out.lines().filter(|l| !l.trim().is_empty()) {
        let parts: Vec<&str> = l.splitn(4, '\t').collect();
        let sname = parts.first().copied().unwrap_or("");
        if !sname.starts_with(&prefix) || !seen.insert(sname.to_string()) {
            continue; // 세션당 첫 window 만(사용자가 tmux 로 window 를 더 만들어도 1터미널)
        }
        let tid: i64 = match sname[prefix.len()..].parse() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let created: i64 = parts.get(1).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        rows.push((created, tid, WindowInfo {
            index: tid,
            active: false,
            id: sname.to_string(),
            name: parts.get(2).map(|s| s.trim().to_string()).unwrap_or_default(),
            command: parts.get(3).map(|s| s.trim().to_string()).unwrap_or_default(),
        }));
    }
    rows.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    Ok(rows.into_iter().map(|r| r.2).collect())
}

// 새 터미널 생성(전 기기에 나타남) — 전용 세션 detached 생성 + cpt env 주입.
//  이름은 자동 개명(automatic-rename)이 부여 — -n 지정은 automatic-rename 을 꺼서 금지.
pub fn create_terminal(ctx: &TmuxCtx, ns: &str, abs: &PathBuf) -> Result<NewWindowInfo, String> {
    let mut last_err = String::new();
    for _ in 0..3 {
        let tid = new_tid();
        let name = term_session(ns, tid);
        match new_detached_session(ctx, &name, abs) {
            Ok(_) => {
                inject_pool_env(ctx, &name, abs);
                ensure_auto_rename_once(ctx, &name);
                let wname = list_windows(ctx, &name).first().map(|w| w.name.clone()).unwrap_or_default();
                return Ok(NewWindowInfo { index: tid, name: wname });
            }
            Err(e) if e.contains("duplicate session") => { last_err = e; continue } // tid 충돌 — 재시도
            Err(e) => return Err(e),
        }
    }
    Err(if last_err.is_empty() { "터미널 생성 실패".to_string() } else { last_err })
}

// 레거시 공유 풀(ns 세션의 window들) → 전용 세션 마이그레이션(데몬 migrateLegacyPool 미러).
//  move-window 라 실행 중인 셸이 무손실 보존된다. 데몬과 동시에 돌아도 안전 — window 이동은
//  tmux 서버에서 원자적이라 진 쪽은 자기가 만든 빈 세션만 회수한다. 멱등(풀 소멸 후 no-op).
pub fn migrate_legacy_pool(ctx: &TmuxCtx, ns: &str, abs: &PathBuf) {
    if ns == TMUX_SESSION {
        return; // 홈 공유 세션은 풀이 아님(레거시 직결 attach) — 옮기지 않는다
    }
    if run(ctx, &["has-session", "-t", &format!("={ns}")]).is_err() {
        return;
    }
    let wins = list_windows(ctx, ns);
    // 기존 --t- tid 와의 충돌 회피 필수 — 충돌하면 아래 move-window -k 가 기존 터미널을 덮어쓴다.
    let taken: std::collections::HashSet<i64> =
        list_terminals(ctx, ns).unwrap_or_default().iter().map(|t| t.index).collect();
    let mut base = new_tid();
    for _ in 0..32 {
        let clash = (0..wins.len() as i64).any(|i| taken.contains(&(base + i))) || base + wins.len() as i64 > 0x7fff_ffff;
        if !clash {
            break;
        }
        base = new_tid();
    }
    for (i, w) in wins.iter().enumerate() {
        let name = term_session(ns, base + i as i64);
        if new_detached_session(ctx, &name, abs).is_err() {
            continue; // duplicate(동시 마이그레이션 등) — 이번은 스킵, 풀에 남아 다음 호출이 잇는다
        }
        match run(ctx, &["move-window", "-k", "-s", &format!("={ns}:{}", w.index), "-t", &format!("={name}:0")]) {
            Ok(_) => {
                // 구 모델 resize-window 가 남긴 manual 고정 해제 → 전역 window-size latest 복귀.
                let _ = run(ctx, &["set-option", "-w", "-u", "-t", &format!("={name}:0"), "window-size"]);
                inject_pool_env(ctx, &name, abs);
            }
            Err(_) => {
                // 다른 액터(번들 데몬)가 먼저 옮김 — 내가 만든 자리(빈 세션)만 회수.
                let _ = run(ctx, &["kill-session", "-t", &format!("={name}")]);
            }
        }
    }
}

// 요청 tid 확정 — 살아있으면 그대로, 죽었으면(닫힘/구버전 인덱스) 첫 터미널 폴백.
//  터미널 0개면 Err — 여기서 "생성"하면 죽은 pane 의 자동 재연결이 닫은 터미널을 유령으로
//  부활시킨다(0개 = 정식 상태, 생성은 tmux_new_window/시드의 명시 경로만).
pub fn resolve_tid(ctx: &TmuxCtx, ns: &str, want: i64) -> Result<i64, String> {
    if want > 0 && run(ctx, &["has-session", "-t", &format!("={}", term_session(ns, want))]).is_ok() {
        return Ok(want);
    }
    let list = list_terminals(ctx, ns)?;
    match list.first() {
        Some(first) => Ok(first.index),
        None => Err("열린 터미널이 없습니다".to_string()),
    }
}

// 터미널 완전 삭제(전 기기 공통) = kill-session. 이미 없거나 서버가 죽었어도 멱등 성공.
pub fn kill_terminal(ctx: &TmuxCtx, ns: &str, tid: i64) -> Result<(), String> {
    match run(ctx, &["kill-session", "-t", &format!("={}", term_session(ns, tid))]) {
        Ok(_) => Ok(()),
        Err(e) => {
            let l = e.to_lowercase();
            if l.contains("no server running") || l.contains("can't find session") || l.contains("session not found") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

// ── 프론트 노출 커맨드 ──

#[tauri::command]
pub fn tmux_list_windows(ctx: tauri::State<TmuxCtx>, local_path: String) -> Result<Vec<WindowInfo>, String> {
    let (ns, abs) = session_for(&local_path);
    migrate_legacy_pool(&ctx, &ns, &abs); // 구 풀 잔재가 있으면 무손실 승격(멱등)
    let r = list_terminals(&ctx, &ns);
    match &r {
        Ok(v) => {
            eprintln!("[tmux] list ns={ns} -> {} terminals", v.len());
            // "N>0 → 0" 급전이 순간의 원시 진단 — 살아있는 세션이 있는데 목록이 0개로 고착돼
            //  탭이 오소거된 실사고(원인 미확정)의 부검용. no-server 였는지 / 서버는 응답했는데
            //  prefix 매칭이 0이었는지(ns 불일치)를 구분해 남긴다. 0개 지속 시엔 1회만 기록.
            use std::collections::HashMap;
            use std::sync::{Mutex, OnceLock};
            static LAST: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
            let last = LAST.get_or_init(|| Mutex::new(HashMap::new()));
            let prev = last.lock().unwrap().insert(ns.clone(), v.len());
            if v.is_empty() && prev.unwrap_or(1) > 0 {
                let raw = run(&ctx, &["list-windows", "-a", "-F", "#{session_name}"]);
                let diag = match &raw {
                    Ok(o) => {
                        let names: Vec<&str> = o.lines().filter(|l| !l.trim().is_empty()).collect();
                        format!("서버 응답 세션 {}개: [{}]", names.len(), names.join(","))
                    }
                    Err(e) => format!("raw ERR: {e}"),
                };
                crate::applog(&format!("[tmux] list ns={ns} -> 0개 급전이! {diag}"));
            }
        }
        Err(e) => {
            eprintln!("[tmux] list ns={ns} -> ERR {e}");
            crate::applog(&format!("[tmux] list ns={ns} -> ERR {e}")); // 오류만 파일로(정상 틱은 소음)
        }
    }
    r
}

#[tauri::command]
pub fn tmux_new_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    pane_id: Option<String>,
) -> Result<NewWindowInfo, String> {
    let _ = pane_id; // 구 시그니처 유지(호출측 무수정) — 전용 세션 모델에선 불필요
    let (ns, abs) = session_for(&local_path);
    migrate_legacy_pool(&ctx, &ns, &abs);
    create_terminal(&ctx, &ns, &abs)
}

// 터미널 완전 삭제(전 기기 공통) — 전용 세션 kill(멱등).
#[tauri::command]
pub fn tmux_kill_window(
    ctx: tauri::State<TmuxCtx>,
    local_path: String,
    index: i64,
) -> Result<(), String> {
    let (ns, _abs) = session_for(&local_path);
    kill_terminal(&ctx, &ns, index)
}
