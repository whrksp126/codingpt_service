// preview.rs — 프리뷰 pane 용 임베디드 네이티브 webview.
//  iframe 은 X-Frame-Options 로 구글 등 대형 사이트를 못 띄우지만, 네이티브 webview 는
//  top-level 컨텍스트라 아무 사이트나 로드 가능(cmux 프리뷰와 동일 원리).
//  webview 는 메인 DOM 위에 얹히므로, 프론트가 pane 위치/가시성을 rAF 로 동기화한다.
use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

#[derive(Default)]
pub struct PreviewManager {
    inner: Mutex<HashMap<String, Entry>>,
}
struct Entry {
    webview: Webview,
    url: String,
}

fn sanitize(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// pane 의 프리뷰 webview 를 (없으면 생성) 위치/크기/가시성/URL 에 맞춘다.
//  visible=false 또는 크기 0 이면 화면 밖으로 옮겨 숨긴다(설정 모달·드래그 중 등).
#[tauri::command]
pub fn preview_sync(
    app: AppHandle,
    mgr: State<PreviewManager>,
    pane_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let mut map = mgr.inner.lock().map_err(|e| e.to_string())?;
    let sized = w > 1.0 && h > 1.0;
    let (px, py) = if visible && sized { (x, y) } else { (-30000.0, -30000.0) };

    if let Some(entry) = map.get_mut(&pane_id) {
        let _ = entry.webview.set_position(LogicalPosition::new(px, py));
        if sized {
            let _ = entry.webview.set_size(LogicalSize::new(w, h));
        }
        if !url.is_empty() && entry.url != url {
            if let Ok(u) = Url::parse(&url) {
                let _ = entry.webview.navigate(u);
                entry.url = url;
            }
        }
        return Ok(());
    }

    // 최초 생성은 URL 이 있을 때만.
    if url.is_empty() {
        return Ok(());
    }
    let parsed = Url::parse(&url).map_err(|_| "잘못된 URL".to_string())?;
    let window = app.get_window("main").ok_or("메인 창 없음")?;
    let label = format!("preview-{}", sanitize(&pane_id));
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(parsed));
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(px, py),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    map.insert(pane_id, Entry { webview, url });
    Ok(())
}

#[tauri::command]
pub fn preview_navigate(mgr: State<PreviewManager>, pane_id: String, url: String) -> Result<(), String> {
    let mut map = mgr.inner.lock().map_err(|e| e.to_string())?;
    if let Some(e) = map.get_mut(&pane_id) {
        if let Ok(u) = Url::parse(&url) {
            let _ = e.webview.navigate(u);
            e.url = url;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn preview_close(mgr: State<PreviewManager>, pane_id: String) {
    if let Ok(mut map) = mgr.inner.lock() {
        if let Some(e) = map.remove(&pane_id) {
            let _ = e.webview.close();
        }
    }
}

// 앱 종료/정리 시 전부 닫기.
pub fn close_all(mgr: &PreviewManager) {
    if let Ok(mut map) = mgr.inner.lock() {
        for (_, e) in map.drain() {
            let _ = e.webview.close();
        }
    }
}
