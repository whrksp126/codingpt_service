// preview.rs — 프리뷰 pane 용 임베디드 네이티브 webview.
//  iframe 은 X-Frame-Options 로 구글 등 대형 사이트를 못 띄우지만, 네이티브 webview 는
//  top-level 컨텍스트라 아무 사이트나 로드 가능(cmux 프리뷰와 동일 원리).
//  webview 는 메인 DOM 위에 얹히므로, 프론트가 pane 위치/가시성을 rAF 로 동기화한다.
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl};

#[derive(Default)]
pub struct PreviewManager {
    inner: Mutex<HashMap<String, Entry>>,
}
struct Entry {
    webview: Webview,
    url: String,
    // macOS: webview 를 감싸는 pane 크기 컨테이너 NSView(포인터, 0=미생성).
    //  WebKit 인스펙터 attach 는 "inspected 뷰의 superview 전체"를 분할하므로(Safari 가정),
    //  superview 를 pane 크기 컨테이너로 만들어야 "내부 열기"가 pane 안에 갇힌다.
    container: Arc<AtomicUsize>,
}

fn sanitize(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// AppKit 지오메트리(objc2 msg_send 인코딩용 최소 정의).
#[cfg(target_os = "macos")]
mod ns {
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Point { pub x: f64, pub y: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Size { pub w: f64, pub h: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Rect { pub origin: Point, pub size: Size }
    unsafe impl objc2::Encode for Point {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for Size {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for Rect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }
}

// ── punch-through: 프리뷰를 앱 웹뷰 "아래" 에 깔고 앱 UI 의 투명 슬롯으로 비춰 보이게 한다 ──
//  (cmux/VSCode 급 임베드) 이제 DOM(모달·메뉴·토스트·설정)이 자연히 프리뷰 위에 그려진다.
//  이벤트는 메인 창 contentView 의 hitTest 오버라이드가 커서 위치로 라우팅:
//  프리뷰 컨테이너 rect 안 + DOM 오버레이 없음(shield off) → 프리뷰, 그 외 → 앱 웹뷰(super).
#[cfg(target_os = "macos")]
static PUNCH_SHIELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(target_os = "macos")]
static PUNCH_SUPER: AtomicUsize = AtomicUsize::new(0); // contentView 원 클래스(&'static AnyClass)
#[cfg(target_os = "macos")]
static CONTAINERS: Mutex<Vec<usize>> = Mutex::new(Vec::new()); // 살아있는 프리뷰 컨테이너 NSView 들

// DOM 오버레이(모달/메뉴/드롭다운)가 떠 있는 동안 프리뷰로의 이벤트 포워딩을 차단(JS 가 갱신).
#[tauri::command]
pub fn preview_shield(on: bool) {
    #[cfg(target_os = "macos")]
    PUNCH_SHIELD.store(on, std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(target_os = "macos"))]
    let _ = on;
}

// 메인 창 배경색 — 투명 슬롯의 "누수" 영역이 앱 배경과 동일해 보이게 테마 base 색으로 맞춘다.
#[tauri::command]
pub fn window_set_bg(app: AppHandle, hex: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let h = hex.trim_start_matches('#');
        if h.len() != 6 { return Err("hex 형식(#rrggbb) 이어야 합니다".into()); }
        let r = u8::from_str_radix(&h[0..2], 16).map_err(|e| e.to_string())? as f64 / 255.0;
        let g = u8::from_str_radix(&h[2..4], 16).map_err(|e| e.to_string())? as f64 / 255.0;
        let b = u8::from_str_radix(&h[4..6], 16).map_err(|e| e.to_string())? as f64 / 255.0;
        let window = app.get_window("main").ok_or("메인 창 없음")?;
        let nsw = window.ns_window().map_err(|e| e.to_string())? as usize;
        let _ = app.run_on_main_thread(move || unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;
            let nsw = nsw as *mut AnyObject;
            let color: *mut AnyObject = msg_send![objc2::class!(NSColor), colorWithSRGBRed: r, green: g, blue: b, alpha: 1.0f64];
            let _: () = msg_send![nsw, setBackgroundColor: color];
        });
    }
    #[cfg(not(target_os = "macos"))]
    { let (_, _) = (app, hex); }
    Ok(())
}

// contentView hitTest 오버라이드 본체 — 프리뷰 컨테이너 rect 안이면 프리뷰(아래층)로 라우팅.
#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn punch_hit_test(
    this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    point: ns::Point,
) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    if !PUNCH_SHIELD.load(std::sync::atomic::Ordering::Relaxed) {
        let sv: *mut AnyObject = msg_send![&*this, superview];
        let p_self: ns::Point = if sv.is_null() { point } else { msg_send![&*this, convertPoint: point, fromView: sv] };
        let conts: Vec<usize> = CONTAINERS.lock().map(|v| v.clone()).unwrap_or_default();
        for c in conts {
            let cont = c as *mut AnyObject;
            let fr: ns::Rect = msg_send![&*cont, frame];
            if p_self.x >= fr.origin.x && p_self.x <= fr.origin.x + fr.size.w
                && p_self.y >= fr.origin.y && p_self.y <= fr.origin.y + fr.size.h
            {
                let hit: *mut AnyObject = msg_send![&*cont, hitTest: p_self];
                if !hit.is_null() {
                    return hit;
                }
            }
        }
    }
    let sup = PUNCH_SUPER.load(Ordering::Relaxed) as *const AnyClass;
    if sup.is_null() {
        return std::ptr::null_mut();
    }
    msg_send![super(&*this, &*sup), hitTest: point]
}

// punch-through 설치(앱 시작 시 1회) — ①메인 앱 웹뷰 배경 투명화 ②contentView 를 hitTest
//  오버라이드 서브클래스로 교체(isa-swizzle). 프리뷰 컨테이너는 wrap_in_container 가 아래층 삽입.
pub fn install_punch_through(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || unsafe {
            use objc2::msg_send;
            use objc2::runtime::{AnyClass, AnyObject, ClassBuilder};
            let Some(window) = app2.get_window("main") else { return };
            // ① 앱 UI 웹뷰 투명화 — DOM 이 투명한 곳(프리뷰 슬롯)은 아래층 프리뷰가 비친다.
            for wv in window.webviews() {
                if wv.label() == "main" {
                    let _ = wv.with_webview(|pw| unsafe {
                        let wk: *mut AnyObject = pw.inner().cast();
                        let no: *mut AnyObject = msg_send![objc2::class!(NSNumber), numberWithBool: false];
                        let key = objc2_foundation::NSString::from_str("drawsBackground");
                        let _: () = msg_send![&*wk, setValue: no, forKey: &*key];
                    });
                }
            }
            // ② contentView hitTest 오버라이드 설치.
            let Ok(nsw_ptr) = window.ns_window() else { return };
            let nsw = nsw_ptr as *mut AnyObject;
            let content: *mut AnyObject = msg_send![&*nsw, contentView];
            if content.is_null() { return; }
            let orig: &AnyClass = msg_send![&*content, class];
            PUNCH_SUPER.store(orig as *const AnyClass as usize, Ordering::SeqCst);
            let name = std::ffi::CString::new("CptPunchContentView").unwrap();
            let cls: &'static AnyClass = if let Some(existing) = AnyClass::get(&name) {
                existing
            } else if let Some(mut b) = ClassBuilder::new(&name, orig) {
                b.add_method(
                    objc2::sel!(hitTest:),
                    punch_hit_test as unsafe extern "C-unwind" fn(_, _, _) -> _,
                );
                b.register()
            } else {
                return;
            };
            let _ = AnyObject::set_class(&*content, cls);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

// 컨테이너 프레임 갱신(위치/크기/숨김) — 생성 전(0)이면 false 반환(호출측이 tauri 경로 사용).
#[cfg(target_os = "macos")]
fn container_set_frame(webview: &Webview, container: &Arc<AtomicUsize>, x: f64, y: f64, w: f64, h: f64) -> bool {
    let cont = container.load(Ordering::Acquire);
    if cont == 0 {
        return false;
    }
    let _ = webview.with_webview(move |_pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let cont = cont as *mut AnyObject;
        // 부모 뷰가 non-flipped(AppKit 기본, 원점=좌하단)면 top-left y 를 변환한다
        //  (wry set_bounds 가 해주던 변환을 컨테이너 직접 제어에선 우리가 해야 함).
        let sv: *mut AnyObject = msg_send![cont, superview];
        let (x, y, mut w, mut h) = (x.round(), y.round(), w.round(), h.round());
        let mut ay = y;
        if !sv.is_null() {
            let sb: ns::Rect = msg_send![sv, bounds];
            // 컨테이너가 창 콘텐츠 영역을 1px 라도 벗어나면 WebKit 인스펙터(우측 도킹)가
            //  contentLayoutRect 로 프레임을 클리핑하고, 클리핑된 폭을 기준으로 다음 relayout 이
            //  또 줄이는 자가-축소 루프에 빠져 폭 조절이 불가능해진다 → 우/하단 가장자리 클램프.
            if x < sb.size.w && x + w > sb.size.w {
                w = (sb.size.w - x).max(1.0);
            }
            if y < sb.size.h && y + h > sb.size.h {
                h = (sb.size.h - y).max(1.0);
            }
            let flipped: bool = msg_send![sv, isFlipped];
            if !flipped {
                ay = sb.size.h - y - h;
            }
        }
        let frame = ns::Rect { origin: ns::Point { x, y: ay }, size: ns::Size { w, h } };
        let _: () = msg_send![cont, setFrame: frame];
    });
    true
}

// 컨테이너 안에서 인스펙터 프론트엔드 WKWebView(페이지 webview 가 아닌 것)를 찾는다.
#[cfg(target_os = "macos")]
unsafe fn find_inspector_view(
    page: *mut objc2::runtime::AnyObject,
    cont: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if cont.is_null() {
        return std::ptr::null_mut();
    }
    let subs: *mut AnyObject = msg_send![cont, subviews];
    let n: usize = msg_send![subs, count];
    for i in 0..n {
        let v: *mut AnyObject = msg_send![subs, objectAtIndex: i];
        if v != page {
            let is_wk: bool = msg_send![v, isKindOfClass: objc2::class!(WKWebView)];
            if is_wk {
                return v;
            }
        }
    }
    std::ptr::null_mut()
}

// webview 를 pane 크기 컨테이너 NSView 로 감싼다(생성 직후 1회).
//  이후 위치/크기 동기화는 컨테이너 프레임만 움직인다(webview 는 autoresizing 으로 추종,
//  인스펙터 attach 시엔 WebKit 이 컨테이너 안에서 webview/인스펙터를 분할 배치).
#[cfg(target_os = "macos")]
fn wrap_in_container(webview: &Webview, slot: Arc<AtomicUsize>) {
    let _ = webview.with_webview(move |pw| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let wk: *mut AnyObject = pw.inner().cast();
        let superview: *mut AnyObject = msg_send![wk, superview];
        if superview.is_null() {
            return;
        }
        let frame: ns::Rect = msg_send![wk, frame];
        let cls = objc2::class!(NSView);
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        let cont: *mut AnyObject = msg_send![alloc, initWithFrame: frame];
        // punch-through: 컨테이너를 형제 최하단(앱 웹뷰 아래)에 삽입 — 앱 UI 의 투명 슬롯으로 비친다.
        let below: isize = -1; // NSWindowBelow
        let nil_view: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![superview, addSubview: cont, positioned: below, relativeTo: nil_view];
        // 재부모화 — 컨테이너 로컬 (0,0) 에 가득 채우고 autoresize 로 추종.
        let _: () = msg_send![wk, retain];
        let _: () = msg_send![wk, removeFromSuperview];
        let _: () = msg_send![cont, addSubview: wk];
        let bounds: ns::Rect = msg_send![cont, bounds];
        let _: () = msg_send![wk, setFrame: bounds];
        let mask: usize = 2 | 16; // NSViewWidthSizable | NSViewHeightSizable
        let _: () = msg_send![wk, setAutoresizingMask: mask];
        let _: () = msg_send![wk, release];
        slot.store(cont as usize, Ordering::Release);
        if let Ok(mut v) = CONTAINERS.lock() { v.push(cont as usize); } // hitTest 라우팅 대상 등록
    });
}

// 컨테이너 정리(웹뷰 close 후) — 메인 스레드에서 remove + release.
#[cfg(target_os = "macos")]
fn drop_container(app: &AppHandle, container: &Arc<AtomicUsize>) {
    let cont = container.swap(0, Ordering::AcqRel);
    if cont == 0 {
        return;
    }
    if let Ok(mut v) = CONTAINERS.lock() { v.retain(|&c| c != cont); } // hitTest 라우팅 대상 해제
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let cont = cont as *mut AnyObject;
        let _: () = msg_send![cont, removeFromSuperview];
        let _: () = msg_send![cont, release];
    });
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
        // macOS: 컨테이너가 있으면 컨테이너 프레임만 이동(웹뷰는 autoresize/WebKit 이 관리).
        #[cfg(target_os = "macos")]
        let moved = container_set_frame(&entry.webview, &entry.container, px, py, if sized { w } else { 1.0 }, if sized { h } else { 1.0 });
        #[cfg(not(target_os = "macos"))]
        let moved = false;
        if !moved {
            let _ = entry.webview.set_position(LogicalPosition::new(px, py));
            if sized {
                let _ = entry.webview.set_size(LogicalSize::new(w, h));
            }
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
    let container = Arc::new(AtomicUsize::new(0));
    #[cfg(target_os = "macos")]
    wrap_in_container(&webview, container.clone());
    map.insert(pane_id, Entry { webview, url, container });
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
        let cont_ptr = entry.container.load(std::sync::atomic::Ordering::Acquire);
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
                            // 내부(attach)는 WebKit 이 superview 전체를 분할하는데, webview 를
                            //  pane 크기 컨테이너로 감쌌으므로 pane 안에서 분할된다. 내부/외부
                            //  전환은 인스펙터 자체 UI 버튼으로 — 둘 다 정상 동작.
                            let _: () = msg_send![insp, show];
                        }
                    }
                    "devtools_fit" => {
                        // 좁은 pane 에서 사이드 도킹은 WebKit 최소폭(인스펙터 500 + 페이지 320)
                        //  때문에 조절 불가로 잠기므로, 인스펙터 프론트엔드에 하단 도킹을 요청한다.
                        let insp = find_inspector_view(wk, cont_ptr as *mut AnyObject);
                        if !insp.is_null() {
                            let js = "(function(){try{if(window.WI&&window.InspectorFrontendHost&&(WI.dockConfiguration==='right'||WI.dockConfiguration==='left'))InspectorFrontendHost.requestSetDockSide('bottom');}catch(e){}})();";
                            let ns = objc2_foundation::NSString::from_str(js);
                            let nil: *mut AnyObject = std::ptr::null_mut();
                            let _: () = msg_send![insp, evaluateJavaScript: &*ns, completionHandler: nil];
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
            "devtools_fit" => Ok(()),
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

// ── 브라우저 자동화(browser.*) 지원 ─────────────────────────────────
//  · preview_eval: evaluateJavaScript 결과를 completionHandler 로 회수. 결과 타입 단순화를 위해
//    호출측(JS)이 항상 JSON.stringify 한 "문자열"을 반환하도록 감싸는 책임을 진다(NSString 만 처리).
//  · preview_screenshot: takeSnapshotWithConfiguration → NSImage → JPEG base64.
//  둘 다 async 커맨드 — 메인 스레드가 아닌 async 런타임에서 돌아야 completionHandler(메인 런루프)가
//  살아 있는 채로 recv_timeout 대기가 가능하다(메인 스레드 블로킹=데드락).

// NSString* → Rust String (preview_info 의 ns_str 과 동일 규칙, 모듈 공용).
#[cfg(target_os = "macos")]
unsafe fn ns_to_string(o: *mut objc2::runtime::AnyObject) -> String {
    use objc2::msg_send;
    if o.is_null() {
        return String::new();
    }
    let c: *const std::os::raw::c_char = msg_send![o, UTF8String];
    if c.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned()
}

// evaluateJavaScript completionHandler(result, error) → 문자열 결과.
//  JS 쪽이 JSON.stringify 문자열을 반환하는 전제 — NSString 외 타입은 description 폴백.
#[cfg(target_os = "macos")]
unsafe fn eval_result_to_string(
    result: *mut objc2::runtime::AnyObject,
    error: *mut objc2::runtime::AnyObject,
) -> Result<String, String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if !error.is_null() {
        let desc: *mut AnyObject = msg_send![error, localizedDescription];
        return Err(format!("JS 평가 오류: {}", ns_to_string(desc)));
    }
    if result.is_null() {
        return Ok("null".to_string());
    }
    let is_str: bool = msg_send![result, isKindOfClass: objc2::class!(NSString)];
    if is_str {
        Ok(ns_to_string(result))
    } else {
        let d: *mut AnyObject = msg_send![result, description];
        Ok(ns_to_string(d))
    }
}

// NSBitmapImageRep → JPEG 바이트(quality 0.0~1.0).
#[cfg(target_os = "macos")]
unsafe fn jpeg_bytes(rep: *mut objc2::runtime::AnyObject, quality: f64) -> Result<Vec<u8>, String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // NSImageCompressionFactor 상수(문자열 리터럴과 동일 값) — AppKit 심볼 링크 회피.
    let key = objc2_foundation::NSString::from_str("NSImageCompressionFactor");
    let num: *mut AnyObject = msg_send![objc2::class!(NSNumber), numberWithDouble: quality];
    let props: *mut AnyObject = msg_send![objc2::class!(NSDictionary), dictionaryWithObject: num, forKey: &*key];
    // NSBitmapImageFileTypeJPEG = 3
    let jpeg: *mut AnyObject = msg_send![rep, representationUsingType: 3usize, properties: props];
    if jpeg.is_null() {
        return Err("JPEG 인코딩 실패".into());
    }
    let len: usize = msg_send![jpeg, length];
    let bytes: *const u8 = msg_send![jpeg, bytes];
    if bytes.is_null() || len == 0 {
        return Err("JPEG 데이터 없음".into());
    }
    Ok(std::slice::from_raw_parts(bytes, len).to_vec())
}

// takeSnapshot completionHandler(image, error) → JPEG base64.
//  2MB 초과면 품질을 낮춰 1회 재시도, 그래도 크면 그대로 반환(호출측이 감내).
#[cfg(target_os = "macos")]
unsafe fn snapshot_to_b64(
    img: *mut objc2::runtime::AnyObject,
    error: *mut objc2::runtime::AnyObject,
) -> Result<String, String> {
    use base64::Engine;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if !error.is_null() {
        let desc: *mut AnyObject = msg_send![error, localizedDescription];
        return Err(format!("스냅샷 오류: {}", ns_to_string(desc)));
    }
    if img.is_null() {
        return Err("스냅샷 이미지 없음".into());
    }
    // NSImage → TIFF → NSBitmapImageRep → JPEG.
    let tiff: *mut AnyObject = msg_send![img, TIFFRepresentation];
    if tiff.is_null() {
        return Err("TIFF 변환 실패".into());
    }
    let rep: *mut AnyObject = msg_send![objc2::class!(NSBitmapImageRep), imageRepWithData: tiff];
    if rep.is_null() {
        return Err("비트맵 변환 실패".into());
    }
    let mut jpeg = jpeg_bytes(rep, 0.8)?;
    if jpeg.len() > 2 * 1024 * 1024 {
        if let Ok(smaller) = jpeg_bytes(rep, 0.4) {
            jpeg = smaller;
        }
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&jpeg))
}

// pane 의 프리뷰 webview 핸들 복제 — 잠금은 여기까지만(완료 대기 중 다른 프리뷰 명령을 막지 않는다).
fn webview_of(mgr: &State<PreviewManager>, pane_id: &str) -> Result<Webview, String> {
    let map = mgr.inner.lock().map_err(|e| e.to_string())?;
    Ok(map.get(pane_id).ok_or("프리뷰 없음")?.webview.clone())
}

// 프리뷰 페이지에서 JS 평가 후 결과 회수. 호출측이 JSON.stringify 문자열 반환을 보장할 것.
#[tauri::command]
pub async fn preview_eval(mgr: State<'_, PreviewManager>, pane: String, js: String) -> Result<String, String> {
    let webview = webview_of(&mgr, &pane)?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                let ns = objc2_foundation::NSString::from_str(&js);
                // completionHandler 는 메인 런루프에서 1회 호출 → 채널로 결과 전달.
                let block = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                    let out = eval_result_to_string(result, error);
                    let _ = tx.send(out);
                });
                let _: () = msg_send![wk, evaluateJavaScript: &*ns, completionHandler: &*block];
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(25))
            .map_err(|_| "JS 평가 시간 초과".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 비 macOS: wry eval 은 반환값 회수가 안 됨 — 명시적 미지원.
        let _ = (webview, js);
        Err("preview_eval 은 macOS 전용입니다".into())
    }
}

// 프리뷰 보이는 영역 스크린샷 → JPEG base64 문자열.
#[tauri::command]
pub async fn preview_screenshot(mgr: State<'_, PreviewManager>, pane: String) -> Result<String, String> {
    let webview = webview_of(&mgr, &pane)?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                let block = block2::RcBlock::new(move |img: *mut AnyObject, error: *mut AnyObject| {
                    let out = snapshot_to_b64(img, error);
                    let _ = tx.send(out);
                });
                // configuration=nil → 보이는 뷰포트 rect 그대로 스냅샷.
                let nil_cfg: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![wk, takeSnapshotWithConfiguration: nil_cfg, completionHandler: &*block];
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(25))
            .map_err(|_| "스크린샷 시간 초과".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err("preview_screenshot 은 macOS 전용입니다".into())
    }
}

// ── 프리뷰 세션 핸드오프: 네이티브 쿠키 브리지(httpOnly 포함) ─────────────────
//  document.cookie(eval)로는 httpOnly 쿠키를 못 읽으므로 WKHTTPCookieStore 를 직접 쓴다.
//  캡처=getAllCookies(비동기 completionHandler→mpsc), 심기=setCookie(FIFO 직렬 → 마지막 completion 이 배리어).
//  오리진 재작성(domain/secure/path/__Host- 접두 처리)은 호출측(JS)이 매니페스트 단계에서 수행한다.

// NSArray<NSHTTPCookie*> → JSON 문자열(각 쿠키 name/value/domain/path/expiresAt/secure/httpOnly/sameSite/session).
#[cfg(target_os = "macos")]
unsafe fn cookies_to_json(cookies: *mut objc2::runtime::AnyObject) -> String {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let mut arr: Vec<serde_json::Value> = Vec::new();
    if !cookies.is_null() {
        let n: usize = msg_send![cookies, count];
        for i in 0..n {
            let c: *mut AnyObject = msg_send![cookies, objectAtIndex: i];
            let name: *mut AnyObject = msg_send![c, name];
            let value: *mut AnyObject = msg_send![c, value];
            let domain: *mut AnyObject = msg_send![c, domain];
            let path: *mut AnyObject = msg_send![c, path];
            let secure: bool = msg_send![c, isSecure];
            let http_only: bool = msg_send![c, isHTTPOnly];
            let exp: *mut AnyObject = msg_send![c, expiresDate];
            let expires_at = if exp.is_null() {
                serde_json::Value::Null
            } else {
                let t: f64 = msg_send![exp, timeIntervalSince1970];
                serde_json::json!(t)
            };
            // sameSitePolicy: macOS 10.15+ (타깃 13.3+ 라 안전). nil=미지정.
            let ss: *mut AnyObject = msg_send![c, sameSitePolicy];
            let same_site = if ss.is_null() { serde_json::Value::Null } else { serde_json::json!(ns_to_string(ss)) };
            arr.push(serde_json::json!({
                "name": ns_to_string(name),
                "value": ns_to_string(value),
                "domain": ns_to_string(domain),
                "path": ns_to_string(path),
                "expiresAt": expires_at,
                "secure": secure,
                "httpOnly": http_only,
                "sameSite": same_site,
                "session": exp.is_null(),
            }));
        }
    }
    serde_json::Value::Array(arr).to_string()
}

// 프리뷰의 모든 쿠키(httpOnly 포함) → JSON 배열 문자열.
#[tauri::command]
pub async fn preview_cookies(mgr: State<'_, PreviewManager>, pane: String) -> Result<String, String> {
    let webview = webview_of(&mgr, &pane)?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                let cfg: *mut AnyObject = msg_send![wk, configuration];
                let store: *mut AnyObject = msg_send![cfg, websiteDataStore];
                let cookie_store: *mut AnyObject = msg_send![store, httpCookieStore];
                let block = block2::RcBlock::new(move |cookies: *mut AnyObject| {
                    let _ = tx.send(cookies_to_json(cookies));
                });
                let _: () = msg_send![cookie_store, getAllCookies: &*block];
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_| "쿠키 조회 시간 초과".to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err("preview_cookies 은 macOS 전용입니다".into())
    }
}

#[cfg(target_os = "macos")]
#[derive(serde::Deserialize)]
struct CookieSpec {
    name: String,
    value: String,
    domain: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "expiresAt", default)]
    expires_at: Option<f64>,
    #[serde(default)]
    secure: Option<bool>,
}

// JSON 쿠키 배열을 프리뷰 쿠키 스토어에 심는다(전부 완료 후 resolve — 다음 로드 전 보장).
//  httpOnly 는 NSHTTPCookie 생성 시 지정 불가(HTTPOnly 프로퍼티 키는 읽기 전용) → 소실되나 값·전송은 동일.
#[tauri::command]
pub async fn preview_set_cookies(mgr: State<'_, PreviewManager>, pane: String, cookies_json: String) -> Result<(), String> {
    let webview = webview_of(&mgr, &pane)?;
    #[cfg(target_os = "macos")]
    {
        let parsed: Vec<CookieSpec> =
            serde_json::from_str(&cookies_json).map_err(|e| format!("쿠키 JSON 파싱 실패: {}", e))?;
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        webview
            .with_webview(move |pw| unsafe {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                let wk: *mut AnyObject = pw.inner().cast();
                let cfg: *mut AnyObject = msg_send![wk, configuration];
                let store: *mut AnyObject = msg_send![cfg, websiteDataStore];
                let cookie_store: *mut AnyObject = msg_send![store, httpCookieStore];
                // NSHTTPCookie 프로퍼티 키는 실제 문자열 값("Name"/"Value"/...)이라 리터럴로 안전(심볼 링크 회피).
                let mut built: Vec<*mut AnyObject> = Vec::new();
                for spec in &parsed {
                    let dict: *mut AnyObject = msg_send![objc2::class!(NSMutableDictionary), dictionary];
                    let put = |k: &str, v: *mut AnyObject| {
                        let key = objc2_foundation::NSString::from_str(k);
                        let _: () = msg_send![dict, setObject: v, forKey: &*key];
                    };
                    let name = objc2_foundation::NSString::from_str(&spec.name);
                    let value = objc2_foundation::NSString::from_str(&spec.value);
                    let domain = objc2_foundation::NSString::from_str(&spec.domain);
                    let path = objc2_foundation::NSString::from_str(spec.path.as_deref().unwrap_or("/"));
                    put("Name", &*name as *const _ as *mut AnyObject);
                    put("Value", &*value as *const _ as *mut AnyObject);
                    put("Domain", &*domain as *const _ as *mut AnyObject);
                    put("Path", &*path as *const _ as *mut AnyObject);
                    if spec.secure.unwrap_or(false) {
                        let t = objc2_foundation::NSString::from_str("TRUE");
                        put("Secure", &*t as *const _ as *mut AnyObject);
                    }
                    if let Some(secs) = spec.expires_at {
                        let date: *mut AnyObject = msg_send![objc2::class!(NSDate), dateWithTimeIntervalSince1970: secs];
                        put("Expires", date);
                    }
                    let cookie: *mut AnyObject = msg_send![objc2::class!(NSHTTPCookie), cookieWithProperties: dict];
                    if !cookie.is_null() {
                        built.push(cookie);
                    }
                }
                if built.is_empty() {
                    let _ = tx.send(());
                } else {
                    // 스토어 연산은 FIFO 직렬 → 마지막 completion 이 전부 완료 배리어.
                    let last = built.len() - 1;
                    for (i, cookie) in built.iter().enumerate() {
                        if i == last {
                            let txc = tx.clone();
                            let block = block2::RcBlock::new(move || { let _ = txc.send(()); });
                            let _: () = msg_send![cookie_store, setCookie: *cookie, completionHandler: &*block];
                        } else {
                            let nil: *mut AnyObject = std::ptr::null_mut();
                            let _: () = msg_send![cookie_store, setCookie: *cookie, completionHandler: nil];
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_| "쿠키 설정 시간 초과".to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, cookies_json);
        Err("preview_set_cookies 은 macOS 전용입니다".into())
    }
}

#[tauri::command]
pub fn preview_close(app: AppHandle, mgr: State<PreviewManager>, pane_id: String) {
    if let Ok(mut map) = mgr.inner.lock() {
        if let Some(e) = map.remove(&pane_id) {
            let _ = e.webview.close();
            #[cfg(target_os = "macos")]
            drop_container(&app, &e.container);
            #[cfg(not(target_os = "macos"))]
            let _ = &app;
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
