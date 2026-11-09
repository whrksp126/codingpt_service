// OS 파일 드롭 — macOS 드래그 임시파일(⌘⇧4 썸네일을 바로 끌어 놓은 것)을 ~/.codingpt/drops 로 복사해 그 경로를 넘긴다.
//
// 왜: 스크린샷 썸네일 드래그는 /var/folders/…/TemporaryItems/NSIRD_screencaptureui_* 의 **임시 원본**을 준다.
//  macOS 가 곧 지우고, 드롭을 받은 앱(CodingPT 본체)에게만 읽기가 허락돼 터미널 안 에이전트는 EPERM 을 받는다.
//  Orca 도 같은 처방이다(src/main/window/dragged-temp-file-copy.ts: "detached PTY daemons get EPERM on
//  TemporaryItems/NSIRD_* originals"). 다운로드·데스크탑 같은 보통 파일은 원본 경로 그대로 —
//  tmux 가 앱 아래에서 돌아 앱의 폴더 허가를 물려받으므로 에이전트가 직접 읽는다(tmux-launchd.js).
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const KEEP: Duration = Duration::from_secs(3 * 24 * 3600);

fn protected(p: &Path, _home: &Path) -> bool {
    ["/var/folders", "/private/var/folders"].iter().any(|r| p.starts_with(r))
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
        assert!(!protected(Path::new("/Users/u/Downloads/a.png"), h));
        assert!(!protected(Path::new("/Users/u/Desktop/스크린샷.png"), h));
        assert!(protected(Path::new("/var/folders/x/T/NSIRD_screencaptureui_1/a.png"), h));
        assert!(!protected(Path::new("/Users/u/project/src/a.rs"), h));
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
