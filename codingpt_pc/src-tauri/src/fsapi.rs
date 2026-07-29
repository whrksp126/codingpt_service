// fsapi.rs — 내장 IDE 용 로컬 파일 접근(홈 jail). PC 앱은 같은 머신이라 Rust 가 직접 읽고 쓴다.
//  경로는 홈-상대(localPath 기준). `..`/심링크 탈출은 거부. node_modules/.git 등은 트리에서 스킵.
use std::path::{Path, PathBuf};

use serde::Serialize;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// 홈-상대 경로를 절대경로로 안전 변환(홈 밖 거부). 신규 파일은 부모 디렉토리로 검증.
fn safe_abs(rel: &str) -> Result<PathBuf, String> {
    let home = home();
    let joined = home.join(rel.trim_start_matches('/'));
    // 존재하면 canonicalize, 없으면 부모를 canonicalize 후 파일명 부착.
    let checked = if joined.exists() {
        joined.canonicalize().map_err(|e| format!("경로 오류: {e}"))?
    } else {
        let parent = joined.parent().ok_or("잘못된 경로")?;
        let cp = parent.canonicalize().map_err(|e| format!("상위 경로 오류: {e}"))?;
        cp.join(joined.file_name().ok_or("파일명 없음")?)
    };
    let home_c = home.canonicalize().unwrap_or(home);
    if !checked.starts_with(&home_c) {
        return Err("홈 디렉토리 밖은 접근할 수 없어요.".into());
    }
    Ok(checked)
}

fn rel_of(abs: &Path) -> String {
    let home = home().canonicalize().unwrap_or_else(|_| home());
    abs.strip_prefix(&home).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| abs.to_string_lossy().to_string())
}

// 홈-상대 경로 → 절대경로 문자열(홈 jail 검증). 파일트리 노드를 터미널에 절대경로로 삽입할 때 사용.
#[tauri::command]
pub fn fs_abs(rel: String) -> Result<String, String> {
    Ok(safe_abs(rel.trim_start_matches('/'))?.to_string_lossy().to_string())
}

const SKIP: &[&str] = &["node_modules", ".git", ".next", "dist", "build", ".cache", "target", ".venv", "__pycache__"];

#[derive(Serialize)]
pub struct Node {
    pub name: String,
    pub path: String, // 홈-상대
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Node>>,
}

fn read_dir_nodes(abs: &Path, depth: i32) -> Vec<Node> {
    let mut out = vec![];
    let rd = match std::fs::read_dir(abs) {
        Ok(r) => r,
        Err(_) => return out,
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| {
        let dir = e.path().is_dir();
        // 디렉토리 먼저, 그다음 이름.
        (if dir { 0 } else { 1 }, e.file_name().to_string_lossy().to_lowercase())
    });
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" && name != ".gitignore" {
            if SKIP.contains(&name.as_str()) {
                continue;
            }
        }
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        let is_dir = p.is_dir();
        let children = if is_dir && depth > 0 {
            Some(read_dir_nodes(&p, depth - 1))
        } else {
            None
        };
        out.push(Node { name, path: rel_of(&p), dir: is_dir, children });
    }
    out
}

// 워크스페이스 파일 트리(홈-상대 root). depth 로 재귀 제한.
// 홈-상대 경로가 이 기기에 실재하는 디렉토리인지(멀티기기: 로컬 워크스페이스 호스트 클레임 판단용).
#[tauri::command]
pub fn path_exists(rel: String) -> bool {
    match safe_abs(&rel) {
        Ok(abs) => abs.is_dir(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn fs_tree(rel: String, depth: Option<i32>) -> Result<Vec<Node>, String> {
    let abs = safe_abs(&rel)?;
    if !abs.is_dir() {
        return Err("디렉토리가 아니에요.".into());
    }
    Ok(read_dir_nodes(&abs, depth.unwrap_or(2)))
}

// ── 프로젝트 전체 텍스트 검색(VS Code Cmd+Shift+F 유사) ──
#[derive(Serialize)]
pub struct SearchHit {
    pub path: String, // 홈-상대
    pub name: String,
    pub line: u32, // 1-based 매칭 줄. 0 = 파일명 매치
    pub text: String,
}

fn walk_search(dir: &Path, ql: &str, hits: &mut Vec<SearchHit>, max: usize) {
    if hits.len() >= max {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| (if e.path().is_dir() { 0 } else { 1 }, e.file_name().to_string_lossy().to_lowercase()));
    for e in entries {
        if hits.len() >= max {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk_search(&p, ql, hits, max);
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 512_000 {
            continue;
        }
        let rel = rel_of(&p);
        if name.to_lowercase().contains(ql) {
            hits.push(SearchHit { path: rel.clone(), name: name.clone(), line: 0, text: name.clone() });
        }
        let bytes = match std::fs::read(&p) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(4000).any(|&b| b == 0) {
            continue; // 바이너리 스킵
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut per_file = 0;
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(ql) {
                let t = line.trim();
                let snippet: String = if t.chars().count() > 200 { t.chars().take(200).collect() } else { t.to_string() };
                hits.push(SearchHit { path: rel.clone(), name: name.clone(), line: (i + 1) as u32, text: snippet });
                per_file += 1;
                if per_file >= 40 || hits.len() >= max {
                    break;
                }
            }
        }
    }
}

#[tauri::command]
pub fn fs_search(rel: String, query: String, max: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let ql = query.trim().to_lowercase();
    if ql.is_empty() {
        return Ok(vec![]);
    }
    let abs = safe_abs(&rel)?;
    if !abs.is_dir() {
        return Err("디렉토리가 아니에요.".into());
    }
    let mut hits = Vec::new();
    walk_search(&abs, &ql, &mut hits, max.unwrap_or(500));
    Ok(hits)
}

// 파일 읽기(텍스트). 큰 파일/바이너리는 거부.
#[tauri::command]
pub fn fs_read(rel: String) -> Result<String, String> {
    let abs = safe_abs(&rel)?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("{e}"))?;
    if meta.len() > 2_000_000 {
        return Err("파일이 너무 커요 (2MB 초과).".into());
    }
    let bytes = std::fs::read(&abs).map_err(|e| format!("읽기 실패: {e}"))?;
    // 널바이트 있으면 바이너리로 판단.
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err("바이너리 파일은 편집할 수 없어요.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// 파일 쓰기(저장).
#[tauri::command]
pub fn fs_write(rel: String, content: String) -> Result<(), String> {
    let abs = safe_abs(&rel)?;
    std::fs::write(&abs, content).map_err(|e| format!("저장 실패: {e}"))
}

// 드롭 파일 미리보기(채팅 첨부 썸네일 — 2026-07-30) — 사용자가 방금 드래그한 파일을 그대로 읽어
//  base64 로 준다. 홈 jail 을 걸지 않는다: 드롭 자체가 사용자의 명시적 선택이고 표시 외 어디로도
//  나가지 않는다. 미리보기 용도라 8MB 캡(초과 시 썸네일만 생략 — 전송은 경로라 무관).
#[tauri::command]
pub fn file_preview_b64(path: String) -> Result<String, String> {
    use base64::Engine;
    let meta = std::fs::metadata(&path).map_err(|e| format!("파일 확인 실패: {e}"))?;
    if !meta.is_file() {
        return Err("파일이 아닙니다".into());
    }
    if meta.len() > 8 * 1024 * 1024 {
        return Err("미리보기 생략(8MB 초과)".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("읽기 실패: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// base64 바이너리 저장(Design Mode 크롭샷 등) — 부모 디렉토리 자동 생성 후 저장하고
//  **절대경로를 반환**한다(클라가 터미널에 절대경로를 삽입해야 함 — 데몬 fs.write absPath 규약 미러).
//  부모(~/.codingpt/attachments 등)가 아직 없으면 safe_abs(canonicalize)가 실패하므로
//  `..` 세그먼트 사전 거부 → 부모 mkdir → safe_abs 재검증(홈 jail) 순서로 처리한다.
#[tauri::command]
pub fn fs_write_b64(rel: String, b64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 디코드 실패: {e}"))?;
    if bytes.len() > 6 * 1024 * 1024 {
        return Err("파일이 너무 큽니다(6MB 제한)".into());
    }
    let cleaned = rel.trim_start_matches('/');
    if cleaned.is_empty() || cleaned.split('/').any(|s| s == "..") {
        return Err("잘못된 경로".into());
    }
    if let Some(parent) = home().join(cleaned).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    }
    let abs = safe_abs(cleaned)?;
    std::fs::write(&abs, &bytes).map_err(|e| format!("저장 실패: {e}"))?;
    Ok(abs.to_string_lossy().to_string())
}

// 새 폴더.
#[tauri::command]
pub fn fs_mkdir(rel: String) -> Result<(), String> {
    let abs = safe_abs(&rel)?;
    if abs.exists() {
        return Err("이미 존재해요.".into());
    }
    std::fs::create_dir_all(&abs).map_err(|e| format!("폴더 생성 실패: {e}"))
}

// 새 빈 파일.
#[tauri::command]
pub fn fs_create_file(rel: String) -> Result<(), String> {
    let abs = safe_abs(&rel)?;
    if abs.exists() {
        return Err("이미 존재해요.".into());
    }
    std::fs::write(&abs, "").map_err(|e| format!("파일 생성 실패: {e}"))
}

// 이름 변경/이동.
#[tauri::command]
pub fn fs_rename(rel: String, dest: String) -> Result<(), String> {
    let from = safe_abs(&rel)?;
    let to = safe_abs(&dest)?;
    if to.exists() {
        return Err("대상이 이미 존재해요.".into());
    }
    std::fs::rename(&from, &to).map_err(|e| format!("이동 실패: {e}"))
}

// 삭제(파일/폴더 재귀).
#[tauri::command]
pub fn fs_delete(rel: String) -> Result<(), String> {
    let abs = safe_abs(&rel)?;
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(|e| format!("삭제 실패: {e}"))
    } else {
        std::fs::remove_file(&abs).map_err(|e| format!("삭제 실패: {e}"))
    }
}
