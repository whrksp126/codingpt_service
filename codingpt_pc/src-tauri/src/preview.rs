// preview.rs — 프리뷰 pane 용 임베디드 네이티브 webview.
//  iframe 은 X-Frame-Options 로 구글 등 대형 사이트를 못 띄우지만, 네이티브 webview 는
//  top-level 컨텍스트라 아무 사이트나 로드 가능(cmux 프리뷰와 동일 원리).
//  webview 는 메인 DOM 위에 얹히므로, 프론트가 pane 위치/가시성을 rAF 로 동기화한다.
use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

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
    // 페이지 로드 완료 → 메인 창에 알림(주소창/탭 메타/테마 재적용은 프론트가 처리).
    let pane_for_event = pane_id.clone();
    let app_for_event = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(parsed)).on_page_load(
        move |_wv, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = app_for_event.emit(
                    "preview-loaded",
                    serde_json::json!({ "pane": pane_for_event, "url": payload.url().to_string() }),
                );
            }
        },
    );
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

// 페이지 강제 다크(다크리더식 필터) 주입/해제 — 모바일 프리뷰와 동일 동작.
// html 배경은 filter 로 함께 반전되므로 밝은색(#fff)을 지정해야 결과가 어두워진다.
const DARK_ON_JS: &str = r#"(function(){var d=document.documentElement;if(document.getElementById('__cpt_dark'))return;var s=document.createElement('style');s.id='__cpt_dark';s.textContent='html{filter:invert(1) hue-rotate(180deg)!important;background:#fff!important}img,video,canvas,iframe,embed,object,svg image{filter:invert(1) hue-rotate(180deg)!important}';(document.head||d).appendChild(s);})();"#;
const DARK_OFF_JS: &str = r#"(function(){var s=document.getElementById('__cpt_dark');if(s)s.remove();})();"#;

// 프리뷰 브라우저 제어 — back/forward/reload 는 WKWebView 네이티브 히스토리, devtools 는 인스펙터,
//  theme_on/off 는 페이지에 다크 필터 주입.
#[tauri::command]
pub fn preview_control(mgr: State<PreviewManager>, pane_id: String, action: String) -> Result<(), String> {
    let map = mgr.inner.lock().map_err(|e| e.to_string())?;
    let entry = map.get(&pane_id).ok_or("프리뷰 없음")?;
    // macOS: 전부 WKWebView 네이티브로 처리(뒤/앞/리로드=히스토리 API, devtools=WKInspector,
    //  테마=evaluateJavaScript — tauri eval/open_devtools 가 child webview 에 안 먹는 케이스 회피).
    #[cfg(target_os = "macos")]
    {
        let act = action.clone();
        entry
            .webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                match act.as_str() {
                    "back" => { let _: *mut AnyObject = msg_send![wk, goBack]; }
                    "forward" => { let _: *mut AnyObject = msg_send![wk, goForward]; }
                    "reload" => { let _: *mut AnyObject = msg_send![wk, reload]; }
                    "devtools" => {
                        // macOS 13.3+ 는 inspectable 플래그가 있어야 인스펙터 부착 가능.
                        let _: () = msg_send![wk, setInspectable: true];
                        let insp: *mut AnyObject = msg_send![wk, _inspector];
                        if !insp.is_null() {
                            // attach 모드는 WebKit 이 webview 프레임을 점유해 pane 밖(창 전체)으로
                            //  확장시키므로(강제 재동기화로도 복구 불가), 항상 별도 창으로 연다.
                            //  detach 는 "열린 뒤"에만 유효 — show 후 호출해야 실제로 분리된다.
                            let _: () = msg_send![insp, show];
                            let _: () = msg_send![insp, detach];
                        }
                    }
                    other => {
                        let js = if other == "theme_on" { DARK_ON_JS } else { DARK_OFF_JS };
                        let ns = objc2_foundation::NSString::from_str(js);
                        let nil: *mut AnyObject = std::ptr::null_mut();
                        let _: () = msg_send![wk, evaluateJavaScript: &*ns, completionHandler: nil];
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        match action.as_str() {
            "devtools" => { entry.webview.open_devtools(); Ok(()) }
            "theme_on" => entry.webview.eval(DARK_ON_JS).map_err(|e| e.to_string()),
            "theme_off" => entry.webview.eval(DARK_OFF_JS).map_err(|e| e.to_string()),
            "back" | "forward" | "reload" => {
                let js = match action.as_str() {
                    "back" => "history.back()",
                    "forward" => "history.forward()",
                    _ => "location.reload()",
                };
                let _ = entry.webview.eval(js);
                Ok(())
            }
            _ => Err("알 수 없는 action".into()),
        }
    }
}

#[derive(serde::Serialize, Default)]
pub struct PreviewInfo {
    pub url: String,
    pub title: String,
    pub can_back: bool,
    pub can_fwd: bool,
}

// 현재 페이지 정보(주소/제목/히스토리 가능 여부) — 주소창·탭 메타·버튼 활성화용.
#[tauri::command]
pub fn preview_info(mgr: State<PreviewManager>, pane_id: String) -> Result<PreviewInfo, String> {
    let map = mgr.inner.lock().map_err(|e| e.to_string())?;
    let entry = map.get(&pane_id).ok_or("프리뷰 없음")?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<PreviewInfo>();
        entry
            .webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                let ns_str = |o: *mut AnyObject| -> String {
                    if o.is_null() {
                        return String::new();
                    }
                    let c: *const std::os::raw::c_char = msg_send![o, UTF8String];
                    if c.is_null() {
                        return String::new();
                    }
                    std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned()
                };
                let title: *mut AnyObject = msg_send![wk, title];
                let nsurl: *mut AnyObject = msg_send![wk, URL];
                let url_s = if nsurl.is_null() {
                    String::new()
                } else {
                    let abs: *mut AnyObject = msg_send![nsurl, absoluteString];
                    ns_str(abs)
                };
                let can_back: bool = msg_send![wk, canGoBack];
                let can_fwd: bool = msg_send![wk, canGoForward];
                let _ = tx.send(PreviewInfo { url: url_s, title: ns_str(title), can_back, can_fwd });
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_millis(400))
            .map_err(|_| "정보 조회 시간 초과".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PreviewInfo { url: entry.url.clone(), ..Default::default() })
    }
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
