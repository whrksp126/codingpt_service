// OS 파일 드롭 경로 스테이징 — macOS TCC 보호 위치의 파일을 ~/.codingpt/drops 로 복사해 그 경로를 넘긴다.
//
// 왜: tmux 서버는 0.1.415 부터 launchd 작업으로 뜬다(⌘Q 뒤 Dock 잔류 수정). 그 결과 tmux 아래
//  claude/codex 는 CodingPT 앱의 TCC 허가(다운로드·데스크탑 폴더 접근)를 물려받지 못한다
//  ("Operation not permitted" 실측). 그래서 ⌘⇧4 스크린샷(데스크탑)·다운로드 파일을 드롭하면
//  에이전트가 파일을 못 읽어 [Image #N] 변환이 안 되고 경로 글자만 남거나 권한 오류를 낸다.
//  스크린샷 썸네일 드래그는 /var/folders/…/NSIRD_screencaptureui_* 임시 경로라 곧 사라지기도 한다.
//  앱(허가 보유)이 드롭 순간 보호되지 않는 곳으로 복사해 두면 에이전트가 항상 읽는다.
//  프로젝트 폴더처럼 보호되지 않은 경로는 원본 그대로(에이전트가 실제 파일을 고칠 수 있게).
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const KEEP: Duration = Duration::from_secs(3 * 24 * 3600);

fn protected(p: &Path, home: &Path) -> bool {
    const HOME_SUBS: [&str; 8] = [
        "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music",
        "Library/Mobile Documents", "Library/CloudStorage",
    ];
    if HOME_SUBS.iter().any(|s| p.starts_with(home.join(s))) {
        return true;
    }
    ["/var/folders", "/private/var/folders", "/Volumes"].iter().any(|r| p.starts_with(r))
}

fn sweep(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map_or(false, |d| d > KEEP);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// 드롭된 경로들 → 에이전트가 읽을 수 있는 경로들(같은 순서·같은 개수). 실패하면 원본 경로 유지.
pub fn stage(paths: Vec<String>) -> Vec<String> {
    if !cfg!(target_os = "macos") || paths.is_empty() {
        return paths;
    }
    let Some(home) = dirs::home_dir() else { return paths };
    let root = home.join(".codingpt").join("drops");
    sweep(&root);
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    paths
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let src = PathBuf::from(&s);
            let ok_file = std::fs::metadata(&src).map_or(false, |m| m.is_file() && m.len() <= MAX_BYTES);
            if !ok_file || !protected(&src, &home) {
                return s;
            }
            let Some(name) = src.file_name() else { return s };
            let dir = root.join(format!("{ms}-{i}"));
            let dst = dir.join(name);
            match std::fs::create_dir_all(&dir).and_then(|_| std::fs::copy(&src, &dst)) {
                Ok(_) => dst.to_string_lossy().into_owned(),
                Err(_) => s,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_paths() {
        let h = Path::new("/Users/u");
        assert!(protected(Path::new("/Users/u/Downloads/a.png"), h));
        assert!(protected(Path::new("/Users/u/Desktop/스크린샷.png"), h));
        assert!(protected(Path::new("/var/folders/x/T/NSIRD_screencaptureui_1/a.png"), h));
        assert!(!protected(Path::new("/Users/u/project/src/a.rs"), h));
        assert!(!protected(Path::new("/Users/u/DownloadsX/a.png"), h));
    }
    #[test]
    fn stages_temp_file() {
        // $TMPDIR = /var/folders/… (스크린샷 썸네일 드래그 경로와 같은 보호 대상).
        let src = std::env::temp_dir().join("cpt-drop-test 스샷.png");
        std::fs::write(&src, b"png").unwrap();
        let keep = "/definitely/missing.txt".to_string();
        let out = stage(vec![src.to_string_lossy().into_owned(), keep.clone()]);
        assert!(out[0].contains("/.codingpt/drops/") && out[0].ends_with("cpt-drop-test 스샷.png"), "{}", out[0]);
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"png");
        assert_eq!(out[1], keep);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_dir_all(Path::new(&out[0]).parent().unwrap());
    }
}
