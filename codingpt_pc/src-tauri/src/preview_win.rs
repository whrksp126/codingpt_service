// preview_win.rs — Windows 프리뷰 punch-through (macOS preview.rs 의 WKWebView 경로 완전 등가).
//
//  구조 (docs/windows-port/design.md 계약 3, 상세는 docs/windows-port/preview-win.md):
//  · 프리뷰 = WebView2 **CompositionController**(자체 HWND 로 그리지 않고 DirectComposition
//    비주얼에 렌더) + IDCompositionTarget(WRY_WEBVIEW HWND, topmost=FALSE).
//    → 비주얼 트리는 "WRY_WEBVIEW 자체 표면 위, 자식 HWND(Chrome_* = 앱 웹뷰) 아래" 에 합성된다.
//  · 앱 웹뷰(wry windowed WebView2)는 install 때 DefaultBackgroundColor 를 alpha 0 으로 바꿔
//    투명화(tauri.conf 수정 불요) — DOM 이 투명한 슬롯으로 아래층 프리뷰가 비친다.
//  · 입력: 앱 웹뷰 서브트리(Chrome_WidgetWin/Chrome_RenderWidgetHostHWND)를 SetWindowSubclass
//    로 서브클래스 → 슬롯 rect 안 마우스/휠은 SendMouseInput 으로 프리뷰에 전달+스왈로우.
//    shield(모달/메뉴 오버레이) 중엔 통과 — macOS hitTest 스위즐의 등가물.
//  · 스레딩: WebView2/DComp 는 UI(메인) 스레드 강제. 모든 COM 상태는 메인 스레드 thread_local
//    에만 두고, 커맨드 스레드는 on_main() 으로 마샬링 + mpsc 로 결과 회수(비동기 완료는
//    메시지 펌프가 배달 — 커맨드 스레드가 recv 대기 중에도 메인 루프는 살아 있다).
//  · crate 버전은 wry 와 동일 계열(webview2-com 0.38/windows 0.61) 고정 — tauri
//    PlatformWebview::controller()/environment() 가 주는 COM 타입과 그대로 호환된다.
#![cfg(target_os = "windows")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2,
    ICoreWebView2CompositionController, ICoreWebView2Controller, ICoreWebView2Controller2,
    ICoreWebView2Controller3, ICoreWebView2CookieList, ICoreWebView2Environment3,
    ICoreWebView2_2, COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS,
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, COREWEBVIEW2_COLOR,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT, COREWEBVIEW2_MOUSE_EVENT_KIND,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
};
use webview2_com::{
    take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler,
    CapturePreviewCompletedHandler, CreateCoreWebView2CompositionControllerCompletedHandler,
    CursorChangedEventHandler, ExecuteScriptCompletedHandler, GetCookiesCompletedHandler,
    NavigationCompletedEventHandler,
};
use windows::core::{w, Interface, HSTRING, PCWSTR, PWSTR, BOOL};
use windows::Win32::Foundation::{COLORREF, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11DeviceContext1,
    ID3D11RenderTargetView, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice, IDCompositionDevice, IDCompositionSurface, IDCompositionTarget,
    IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_B8G8R8A8_UNORM};
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISurface};
use windows::Win32::Graphics::Gdi::{MapWindowPoints, ScreenToClient};
use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::Shell::{DefSubclassProc, SHCreateMemStream, SetWindowSubclass};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, EnumChildWindows, GetClassNameW, GetCursorPos,
    GetParent, GetSystemMetrics, GetWindowLongPtrW, IsWindow, LoadCursorW, RegisterClassExW,
    SetCursor, SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HCURSOR, HWND_TOP, IDC_ARROW, LWA_ALPHA, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOWNA, WM_CAPTURECHANGED,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN,
    WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SETCURSOR, WM_XBUTTONDBLCLK,
    WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSEXW, WS_CHILD, WS_EX_LAYERED, WS_EX_NOPARENTNOTIFY,
};

use super::PreviewInfo;

// ── 전역(스레드 무관) ────────────────────────────────────────────────────────
static APP: OnceLock<AppHandle> = OnceLock::new();
static MAIN_THREAD: OnceLock<std::thread::ThreadId> = OnceLock::new();
// DOM 오버레이(모달/메뉴) 동안 프리뷰 포워딩 차단 — macOS PUNCH_SHIELD 등가.
static SHIELD: AtomicBool = AtomicBool::new(false);

const SUBCLASS_ID: usize = 0x6370_7476; // "cptv"
// windows crate 에선 Win32_UI_Controls 피처에 있어 값으로 직접 정의(0x02A3 — TrackMouseEvent 계열).
const WM_MOUSELEAVE: u32 = 0x02A3;
// 숨김 시 화면 밖 좌표(macOS 와 동일 값 — 렌더 상태 유지한 채 안 보이게).
const OFFSCREEN: i32 = -30000;

// ── 메인 스레드 전용 상태 ────────────────────────────────────────────────────
thread_local! {
    static STATE: RefCell<Option<WinState>> = const { RefCell::new(None) };
}

struct Dcomp {
    d3d: ID3D11Device,
    ctx: ID3D11DeviceContext,
    dev: IDCompositionDevice,
    _target: IDCompositionTarget, // 보유가 곧 수명(드롭 시 트리 해제)
    root: IDCompositionVisual,
    bg_visual: IDCompositionVisual,
    bg_surface: Option<IDCompositionSurface>,
    bg_size: (u32, u32),
}

struct Pane {
    // 생성 완료 전(None)엔 rect/url 만 축적하고 완료 핸들러가 반영한다.
    comp: Option<ICoreWebView2CompositionController>,
    ctrl: Option<ICoreWebView2Controller>,
    core: Option<ICoreWebView2>,
    visual: Option<IDCompositionVisual>,
    cursor: HCURSOR, // CursorChanged 가 갱신(기본 IDC_ARROW)
    url: String,     // 마지막 요청 URL(내비 dedup — macOS entry.url 동일 역할)
    closed: bool,    // 생성 완료 전 close 된 pane — 완료 핸들러가 즉시 파기
    // 슬롯 rect(호스트 클라이언트 물리 px). 숨김이면 offscreen.
    px: i32,
    py: i32,
    pw: i32,
    ph: i32,
    // 입력 오버레이 HWND(우리 프로세스 소유) — 이 pane 의 마우스 입구. 0 = 아직 없음.
    //  왜 필요한지는 아래 "입력 오버레이" 절 주석 참조.
    overlay: isize,
}

struct WinState {
    main_hwnd: isize,
    host_hwnd: isize, // 앱 웹뷰 컨테이너(WRY_WEBVIEW) — DComp 타깃 + 좌표 기준
    env3: Option<ICoreWebView2Environment3>,
    dcomp: Option<Dcomp>,
    panes: HashMap<String, Pane>,
    bg: (u8, u8, u8),
    subclassed: Vec<isize>,
    last_scan: Instant,
    capture: Option<String>, // 버튼 down~up 사이 드래그를 슬롯 밖까지 따라가게
    hover: Option<String>,   // enter/leave 합성용
}

fn with_state<R>(f: impl FnOnce(&mut WinState) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

// 커맨드 스레드 → 메인 스레드 마샬링. tauri v2 sync 커맨드는 메인 스레드에서 돌 수 있으므로
//  현재 스레드가 메인이면 인라인 실행(큐잉하면 자기 자신을 기다리는 데드락).
fn on_main<R, F>(f: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    if MAIN_THREAD.get() == Some(&std::thread::current().id()) {
        return Ok(f());
    }
    let app = APP.get().ok_or("프리뷰(win) 미초기화")?;
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "메인 스레드 응답 시간 초과".to_string())
}

fn default_cursor() -> HCURSOR {
    unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or_default() }
}

// ── 설치(앱 시작 시 1회) ─────────────────────────────────────────────────────
//  ① 메인 앱 웹뷰 DefaultBackgroundColor → 투명(punch-through 의 "앱 웹뷰 투명" 절반)
//  ② WRY_WEBVIEW/메인 HWND 확보 + 상태 초기화 ③ 입력 서브클래스 설치.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = MAIN_THREAD.set(std::thread::current().id());
        let Some(window) = app2.get_window("main") else { return };
        let Ok(main_hwnd) = window.hwnd() else { return };
        let host = unsafe { find_wry_host(main_hwnd) };
        STATE.with(|s| {
            *s.borrow_mut() = Some(WinState {
                main_hwnd: main_hwnd.0 as isize,
                host_hwnd: host.map(|h| h.0 as isize).unwrap_or(0),
                env3: None,
                dcomp: None,
                panes: HashMap::new(),
                bg: (0x1e, 0x1e, 0x1e), // window_set_bg 가 곧 테마색으로 덮는다
                subclassed: Vec::new(),
                last_scan: Instant::now() - Duration::from_secs(60),
                capture: None,
                hover: None,
            });
        });
        // 앱 웹뷰 투명화 + WebView2 environment 확보(프리뷰 컨트롤러 생성에 재사용 —
        //  같은 브라우저 프로세스/프로필). with_webview 는 메인 스레드에서 실행된다.
        for wv in window.webviews() {
            if wv.label() == "main" {
                let _ = wv.with_webview(|pw| {
                    let controller = pw.controller();
                    unsafe {
                        if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
                            let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                                A: 0,
                                R: 0,
                                G: 0,
                                B: 0,
                            });
                        }
                    }
                    let env3 = pw.environment().cast::<ICoreWebView2Environment3>().ok();
                    with_state(|st| st.env3 = env3);
                });
            }
        }
        with_state(|st| unsafe { rescan_subclasses(st) });
    });
}

// 메인 창 직계 자식 중 클래스 WRY_WEBVIEW(앱 웹뷰 컨테이너 — wry 가 등록하는 클래스명).
unsafe fn find_wry_host(main: HWND) -> Option<HWND> {
    struct Ctx {
        main: HWND,
        found: Option<HWND>,
    }
    unsafe extern "system" fn ep(h: HWND, lp: LPARAM) -> BOOL {
        let ctx = unsafe { &mut *(lp.0 as *mut Ctx) };
        let mut cls = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut cls) };
        if n > 0 && String::from_utf16_lossy(&cls[..n as usize]) == "WRY_WEBVIEW" {
            if unsafe { GetParent(h) }.ok() == Some(ctx.main) {
                ctx.found = Some(h);
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    let mut ctx = Ctx { main, found: None };
    let _ = unsafe {
        EnumChildWindows(Some(main), Some(ep), LPARAM(&mut ctx as *mut Ctx as isize))
    };
    ctx.found
}

// ── 입력 오버레이 ────────────────────────────────────────────────────────────
//  macOS 는 앱 웹뷰(WKWebView)가 **같은 프로세스**라 contentView 의 hitTest 를 스위즐해
//  슬롯 위 이벤트를 프리뷰로 돌릴 수 있었다. Windows 에는 그 등가물이 없다:
//  **WebView2 는 별도 프로세스**(msedgewebview2.exe)이고 창 안의 `Chrome_WidgetWin_*`,
//  `Chrome_RenderWidgetHostHWND` 는 전부 그 프로세스 소유라 `SetWindowSubclass` 가 걸리지 않는다
//  (호출은 성공하는데 프로시저가 영영 안 불린다 — 2026-08-14 실기 확인).
//
//  그래서 슬롯 위에 **우리 프로세스 소유의 투명 자식 창**을 얹어 그 창이 마우스를 받는다.
//  받은 메시지는 기존 `route_mouse` 에 그대로 넘긴다(로직은 이미 있었고 입구만 없었다).
//   · 부모 = WRY_WEBVIEW → 좌표계가 pane 의 px/py(호스트 클라이언트)와 그대로 일치한다.
//   · WS_EX_LAYERED + alpha=1 : 화면상 사실상 안 보이지만(0.4%) **히트테스트는 살아 있다**.
//     alpha=0 으로 두면 클릭이 통과해 버려 의미가 없다 — 1 이어야 한다.
//   · shield(모달/메뉴) 중에는 **숨긴다**. 보이는 채로 두면 우리가 삼켜서 DOM 이 입력을 잃는다.
//   · 렌더는 여전히 DComp(앱 웹뷰 아래) — DOM 이 프리뷰 **위**에 그려지는 성질은 그대로다.
const OVERLAY_CLASS: PCWSTR = w!("CptPreviewInputOverlay");
static OVERLAY_CLASS_ONCE: std::sync::Once = std::sync::Once::new();

fn ensure_overlay_class() {
    OVERLAY_CLASS_ONCE.call_once(|| unsafe {
        let hinst = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_proc),
            hInstance: hinst.into(),
            lpszClassName: OVERLAY_CLASS,
            // 커서는 WM_SETCURSOR 에서 프리뷰가 알려준 모양으로 우리가 그린다 → 클래스 커서 없음.
            hCursor: HCURSOR::default(),
            ..Default::default()
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            eprintln!(
                "[preview_win] 오버레이 창 클래스 등록 실패 err={:?}",
                windows::Win32::Foundation::GetLastError()
            );
        }
    });
}

// pane 하나당 오버레이 하나. 실패하면 0 을 돌려주고 조용히 입력 없는 상태가 된다
//  (프리뷰가 보이기는 하므로 앱 전체를 죽이지 않는다).
unsafe fn create_overlay(host: HWND) -> isize {
    ensure_overlay_class();
    let hinst = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
    let h = unsafe {
        CreateWindowExW(
            // ★ WS_EX_LAYERED 를 여기서 주면 자식 창 생성이 실패한다(널 반환·GetLastError 0).
            //  생성 후 SetWindowLongPtr 로 얹어야 한다.
            WS_EX_NOPARENTNOTIFY,
            OVERLAY_CLASS,
            PCWSTR::null(),
            WS_CHILD, // 처음엔 숨김 — 첫 배치에서 보인다
            0,
            0,
            1,
            1,
            Some(host),
            None,
            Some(hinst.into()),
            None,
        )
    };
    let h = match h {
        Ok(h) if !h.is_invalid() => h,
        other => {
            // 조용히 실패하면 "프리뷰는 보이는데 클릭만 안 되는" 상태가 되고 원인 추적이 어렵다.
            eprintln!(
                "[preview_win] 입력 오버레이 생성 실패 host={:#x} err={:?}",
                host.0 as isize,
                other.err()
            );
            return 0;
        }
    };
    // 레이어드 전환 → alpha=1. 눈에 안 보이면서 히트테스트는 살아 있는 유일한 값
    //  (0 이면 클릭이 통과해 버려 오버레이의 의미가 없다).
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32 | WS_EX_LAYERED.0;
    unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, ex as isize) };
    let _ = unsafe { SetLayeredWindowAttributes(h, COLORREF(0), 1, LWA_ALPHA) };
    h.0 as isize
}

// 슬롯 rect 에 맞춰 위치·크기·표시를 갱신한다. 앱 웹뷰(Chrome_*) 위로 올려야 우리가 먼저 받는다.
unsafe fn place_overlay(p: &Pane) {
    if p.overlay == 0 {
        return;
    }
    let h = HWND(p.overlay as _);
    if !unsafe { IsWindow(Some(h)) }.as_bool() {
        return;
    }
    // shield 중이거나 슬롯이 화면 밖이면 숨긴다 → 입력이 DOM(앱 웹뷰)으로 그대로 간다.
    let show = !SHIELD.load(Ordering::Relaxed) && p.px > OFFSCREEN / 2 && p.pw > 1 && p.ph > 1;
    if !show {
        let _ = unsafe { ShowWindow(h, SW_HIDE) };
        return;
    }
    let _ = unsafe {
        SetWindowPos(
            h,
            Some(HWND_TOP),
            p.px,
            p.py,
            p.pw,
            p.ph,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    };
    let _ = unsafe { ShowWindow(h, SW_SHOWNA) }; // 포커스를 뺏지 않고 표시
}

unsafe fn destroy_overlay(p: &mut Pane) {
    if p.overlay == 0 {
        return;
    }
    let h = HWND(p.overlay as _);
    p.overlay = 0;
    if unsafe { IsWindow(Some(h)) }.as_bool() {
        let _ = unsafe { DestroyWindow(h) };
    }
}

// 오버레이 창 프로시저 — 서브클래스 프로시저와 **같은 판정**을 쓴다(로직 이원화 금지).
unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    if !SHIELD.load(Ordering::Relaxed) {
        if is_mouse_msg(msg) {
            if let Some(r) = unsafe { route_mouse(hwnd, msg, wp, lp) } {
                return r;
            }
        } else if msg == WM_MOUSELEAVE {
            unsafe { forward_hover_leave() };
        } else if msg == WM_CAPTURECHANGED {
            with_state(|st| st.capture = None);
        } else if msg == WM_SETCURSOR {
            if let Some(c) = cursor_for_point() {
                unsafe { SetCursor(Some(c)) };
                return LRESULT(1);
            }
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

// ── 입력 서브클래스 ──────────────────────────────────────────────────────────
//  앱 웹뷰 서브트리 전체를 서브클래스한다. 마우스 메시지는 커서 아래 HWND
//  (Chrome_RenderWidgetHostHWND 등)로 오므로 어떤 자손이 받든 우리가 먼저 본다.
//  Chrome_* HWND 는 내비게이션/렌더러 재기동으로 재생성될 수 있어 sync 마다(스로틀) 재스캔.
unsafe fn rescan_subclasses(st: &mut WinState) {
    st.subclassed
        .retain(|h| unsafe { IsWindow(Some(HWND(*h as _))) }.as_bool());
    if st.host_hwnd == 0 {
        if let Some(h) = unsafe { find_wry_host(HWND(st.main_hwnd as _)) } {
            st.host_hwnd = h.0 as isize;
        } else {
            return;
        }
    }
    let host = HWND(st.host_hwnd as _);
    if !unsafe { IsWindow(Some(host)) }.as_bool() {
        return;
    }
    unsafe extern "system" fn ep(h: HWND, lp: LPARAM) -> BOOL {
        let v = unsafe { &mut *(lp.0 as *mut Vec<isize>) };
        v.push(h.0 as isize);
        BOOL(1)
    }
    let mut found: Vec<isize> = vec![st.host_hwnd];
    let _ = unsafe { EnumChildWindows(Some(host), Some(ep), LPARAM(&mut found as *mut _ as isize)) };
    for h in found {
        if !st.subclassed.contains(&h) {
            let ok = unsafe { SetWindowSubclass(HWND(h as _), Some(subclass_proc), SUBCLASS_ID, 0) };
            if ok.as_bool() {
                st.subclassed.push(h);
            }
        }
    }
    st.last_scan = Instant::now();
}

#[inline]
fn loword_pt(lp: LPARAM) -> POINT {
    POINT {
        x: (lp.0 & 0xFFFF) as u16 as i16 as i32,
        y: ((lp.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
    }
}

fn is_mouse_msg(msg: u32) -> bool {
    matches!(
        msg,
        WM_MOUSEMOVE
            | WM_LBUTTONDOWN
            | WM_LBUTTONUP
            | WM_LBUTTONDBLCLK
            | WM_RBUTTONDOWN
            | WM_RBUTTONUP
            | WM_RBUTTONDBLCLK
            | WM_MBUTTONDOWN
            | WM_MBUTTONUP
            | WM_MBUTTONDBLCLK
            | WM_XBUTTONDOWN
            | WM_XBUTTONUP
            | WM_XBUTTONDBLCLK
            | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
    )
}

// 서브클래스 프로시저 — 메인 스레드에서만 호출된다(모든 STATE 접근 안전).
unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if !SHIELD.load(Ordering::Relaxed) {
        if is_mouse_msg(msg) {
            if let Some(r) = unsafe { route_mouse(hwnd, msg, wp, lp) } {
                return r;
            }
        } else if msg == WM_MOUSELEAVE {
            unsafe { forward_hover_leave() };
        } else if msg == WM_CAPTURECHANGED {
            with_state(|st| st.capture = None);
        } else if msg == WM_SETCURSOR {
            // 슬롯 위에서는 프리뷰가 마지막으로 알린 커서 모양을 우리가 그린다.
            if let Some(c) = cursor_for_point() {
                unsafe { SetCursor(Some(c)) };
                return LRESULT(1);
            }
        } else if (0x0238..=0x024F).contains(&msg) {
            // WM_POINTER* (터치/펜): 슬롯 위면 스왈로우 — 앱 웹뷰로 새는 것만 차단.
            //  (SendPointerInput 포워딩은 1차 미구현 — preview-win.md 리스크 참조. 데스크톱
            //   마우스는 위 경로가 처리하고, 터치의 마우스 승격도 여기서 막혀 일관 무시된다.)
            let mut pt = loword_pt(lp); // pointer 계열 lParam = 화면좌표
            let over = with_state(|st| {
                let _ = unsafe { ScreenToClient(HWND(st.host_hwnd as _), &mut pt) };
                pane_at(st, pt).is_some()
            })
            .unwrap_or(false);
            if over {
                return LRESULT(0);
            }
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
}

fn pane_at(st: &WinState, pt: POINT) -> Option<String> {
    for (id, p) in &st.panes {
        if p.comp.is_some()
            && pt.x >= p.px
            && pt.x < p.px + p.pw
            && pt.y >= p.py
            && pt.y < p.py + p.ph
        {
            return Some(id.clone());
        }
    }
    None
}

// WM_SETCURSOR 용 — 커서 아래 pane 이 있으면 그 pane 의 HCURSOR.
fn cursor_for_point() -> Option<HCURSOR> {
    with_state(|st| {
        let mut pt = POINT::default();
        if unsafe { GetCursorPos(&mut pt) }.is_err() {
            return None;
        }
        let _ = unsafe { ScreenToClient(HWND(st.host_hwnd as _), &mut pt) };
        pane_at(st, pt).map(|id| {
            let c = st.panes.get(&id).map(|p| p.cursor).unwrap_or_default();
            if c.is_invalid() { default_cursor() } else { c }
        })
    })
    .flatten()
}

// hover 중이던 pane 에 LEAVE 합성(마우스가 슬롯 밖/창 밖으로 나갈 때).
unsafe fn forward_hover_leave() {
    let comp = with_state(|st| {
        st.hover
            .take()
            .and_then(|id| st.panes.get(&id).and_then(|p| p.comp.clone()))
    })
    .flatten();
    if let Some(c) = comp {
        let _ = unsafe {
            c.SendMouseInput(
                COREWEBVIEW2_MOUSE_EVENT_KIND(WM_MOUSELEAVE as i32),
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(0),
                0,
                POINT { x: 0, y: 0 },
            )
        };
    }
}

// 슬롯 rect 안 마우스 메시지를 프리뷰로 전달하고 스왈로우. None = 앱으로 통과.
//  borrow 규율: 판정/부기(짧은 borrow) → borrow 밖에서 COM 호출/emit (WebView2 재진입 대비).
unsafe fn route_mouse(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
    let wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
    let is_down = matches!(
        msg,
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
    );
    let is_up = matches!(msg, WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP);

    struct Fwd {
        comp: ICoreWebView2CompositionController,
        ctrl: Option<ICoreWebView2Controller>, // down 시 MoveFocus 용
        rel: POINT,
        leave: Option<ICoreWebView2CompositionController>, // pane 전환/이탈 시 이전 pane LEAVE
        focus_emit: Option<String>,                        // 좌클릭 → preview-focus (mac R4)
    }
    // (전달할 메시지, 슬롯 밖으로 나가며 이전 pane 에 보낼 LEAVE) — 판정은 짧은 borrow 안에서.
    let decided: Option<(Option<Fwd>, Option<ICoreWebView2CompositionController>)> =
        with_state(|st| {
            let host = HWND(st.host_hwnd as _);
            let mut pt = loword_pt(lp);
            if wheel {
                // 휠 lParam 은 화면좌표.
                let _ = unsafe { ScreenToClient(host, &mut pt) };
            } else if hwnd != host {
                let mut pts = [pt];
                let _ = unsafe { MapWindowPoints(Some(hwnd), Some(host), &mut pts) };
                pt = pts[0];
            }
            // 캡처 중이면 슬롯 밖이어도 그 pane 으로(드래그 추적 — 브라우저 SetCapture 등가).
            let target = if let Some(cap) = st.capture.clone() {
                if st.panes.get(&cap).map(|p| p.comp.is_some()).unwrap_or(false) {
                    Some(cap)
                } else {
                    st.capture = None;
                    pane_at(st, pt)
                }
            } else {
                pane_at(st, pt)
            };
            let Some(id) = target else {
                // 슬롯 밖 — hover 중이었다면 LEAVE 만 합성하고 메시지는 앱으로 통과.
                let leave = st
                    .hover
                    .take()
                    .and_then(|h| st.panes.get(&h).and_then(|p| p.comp.clone()));
                return (None, leave);
            };
            let Some(p) = st.panes.get(&id) else { return (None, None) };
            let Some(comp) = p.comp.clone() else { return (None, None) };
            let rel = POINT { x: pt.x - p.px, y: pt.y - p.py };
            let ctrl = if is_down { p.ctrl.clone() } else { None };
            // hover 전환 부기 + 이전 pane LEAVE.
            let leave = if st.hover.as_deref() != Some(id.as_str()) {
                st.hover
                    .replace(id.clone())
                    .and_then(|h| st.panes.get(&h).and_then(|q| q.comp.clone()))
            } else {
                None
            };
            // 캡처 부기(SetCapture/Release 는 borrow 밖).
            if is_down {
                st.capture = Some(id.clone());
            } else if is_up {
                st.capture = None;
            }
            (
                Some(Fwd {
                    comp,
                    ctrl,
                    rel,
                    leave,
                    focus_emit: if msg == WM_LBUTTONDOWN { Some(id) } else { None },
                }),
                None,
            )
        });

    let Some((fwd, exit_leave)) = decided else { return None };
    if let Some(old) = exit_leave {
        let _ = unsafe {
            old.SendMouseInput(
                COREWEBVIEW2_MOUSE_EVENT_KIND(WM_MOUSELEAVE as i32),
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(0),
                0,
                POINT { x: 0, y: 0 },
            )
        };
    }
    let Some(f) = fwd else { return None };

    if let Some(old) = &f.leave {
        let _ = unsafe {
            old.SendMouseInput(
                COREWEBVIEW2_MOUSE_EVENT_KIND(WM_MOUSELEAVE as i32),
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(0),
                0,
                POINT { x: 0, y: 0 },
            )
        };
    }
    // mousedata: 휠 delta / X버튼 식별자(HIWORD(wParam)), 그 외 0.
    let mousedata: u32 = if wheel || matches!(msg, WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK)
    {
        ((wp.0 >> 16) & 0xFFFF) as u32
    } else {
        0
    };
    let vkeys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS((wp.0 & 0xFFFF) as i32);
    let _ = unsafe {
        f.comp
            .SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND(msg as i32), vkeys, mousedata, f.rel)
    };
    if is_down {
        // 슬롯 밖 드래그 추적(버튼 up 까지 메시지가 계속 이 hwnd 로 오게).
        unsafe { SetCapture(hwnd) };
        if let Some(ctrl) = &f.ctrl {
            // 키보드 포커스를 프리뷰로 — macOS 의 first responder 이동 등가.
            let _ = unsafe { ctrl.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC) };
        }
    } else if is_up {
        let _ = unsafe { ReleaseCapture() };
    }
    if let Some(pane) = f.focus_emit {
        if let Some(app) = APP.get() {
            let _ = app.emit("preview-focus", serde_json::json!({ "pane": pane }));
        }
    }
    Some(LRESULT(0))
}

// ── DirectComposition 트리 ───────────────────────────────────────────────────
unsafe fn ensure_dcomp(st: &mut WinState) -> Result<(), String> {
    if st.dcomp.is_some() {
        return Ok(());
    }
    if st.host_hwnd == 0 {
        return Err("앱 웹뷰 HWND(WRY_WEBVIEW) 미확보".into());
    }
    let host = HWND(st.host_hwnd as _);
    let create = |driver| unsafe {
        let mut d: Option<ID3D11Device> = None;
        let mut c: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut d),
            None,
            Some(&mut c),
        )
        .map(|_| (d, c))
    };
    let (d3d, ctx) = match create(D3D_DRIVER_TYPE_HARDWARE) {
        Ok(p) => p,
        Err(_) => create(D3D_DRIVER_TYPE_WARP).map_err(|e| format!("D3D11 장치 생성 실패: {e}"))?,
    };
    let d3d = d3d.ok_or("D3D11 장치 없음")?;
    let ctx = ctx.ok_or("D3D11 컨텍스트 없음")?;
    let dxgi: IDXGIDevice = d3d.cast().map_err(|e| e.to_string())?;
    let dev: IDCompositionDevice =
        unsafe { DCompositionCreateDevice(&dxgi) }.map_err(|e| format!("DComp 장치 실패: {e}"))?;
    // topmost=FALSE → 비주얼 트리를 "자식 HWND(투명한 앱 웹뷰) 아래, 이 창 표면 위"에 합성.
    //
    // ★ 타깃은 반드시 **최상위 창(main_hwnd)** 이다. 자식 HWND(WRY_WEBVIEW)에 걸면
    //  CreateTargetForHwnd 가 **성공을 리턴하는데 합성이 전혀 일어나지 않는다** — 장치·타깃·서페이스
    //  생성이 전 단계 ok 인데 화면은 백지라, 로그 없이는 추적이 사실상 불가능한 형태의 실패다.
    //  2026-08-14 실기에서 이 경로를 밟았고(웨이브3), 타깃을 최상위로 옮기자 즉시 렌더됐다.
    //  (preview-win.md 리스크 1 의 폴백 ①. 폴백 ② `transparent:true` 는 **불필요** — 함께 켜면
    //   투명 창 부작용만 떠안는다. 실측으로 배제했다.)
    let top = HWND(st.main_hwnd as _);
    let target = unsafe { dev.CreateTargetForHwnd(top, false) }.map_err(|e| e.to_string())?;
    let _ = host; // 입력 라우팅용으로만 쓰인다(합성 타깃 아님)
    let root = unsafe { dev.CreateVisual() }.map_err(|e| e.to_string())?;
    unsafe { target.SetRoot(&root) }.map_err(|e| e.to_string())?;
    // 배경 비주얼 — 투명 슬롯의 "누수" 영역이 앱 배경색으로 보이게(macOS NSWindow bg 등가).
    //  가상 스크린 크기 단색 서페이스 1장(리사이즈 무관 커버).
    let bw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1920) as u32;
    let bh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1080) as u32;
    let bg_visual = unsafe { dev.CreateVisual() }.map_err(|e| e.to_string())?;
    let bg_surface =
        unsafe { dev.CreateSurface(bw, bh, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_ALPHA_MODE_IGNORE) }.ok();
    if let Some(s) = &bg_surface {
        let _ = unsafe { bg_visual.SetContent(s) };
    }
    let _ = unsafe { root.AddVisual(&bg_visual, false, None::<&IDCompositionVisual>) };
    let dc = Dcomp {
        d3d,
        ctx,
        dev,
        _target: target,
        root,
        bg_visual,
        bg_surface,
        bg_size: (bw, bh),
    };
    let _ = unsafe { fill_bg(&dc, st.bg) };
    let _ = unsafe { dc.dev.Commit() };
    st.dcomp = Some(dc);
    Ok(())
}

// 배경 서페이스를 단색으로 칠한다(BeginDraw 는 아틀라스 오프셋을 줄 수 있어 ClearView 로 rect 지정).
unsafe fn fill_bg(dc: &Dcomp, color: (u8, u8, u8)) -> Result<(), String> {
    let Some(surface) = &dc.bg_surface else { return Ok(()) };
    let mut off = POINT::default();
    let tex: IDXGISurface =
        unsafe { surface.BeginDraw(None, &mut off) }.map_err(|e| e.to_string())?;
    let res = (|| -> Result<(), String> {
        let tex2d: ID3D11Texture2D = tex.cast().map_err(|e| e.to_string())?;
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        unsafe { dc.d3d.CreateRenderTargetView(&tex2d, None, Some(&mut rtv)) }
            .map_err(|e| e.to_string())?;
        let rtv = rtv.ok_or("RTV 없음")?;
        let col = [
            color.0 as f32 / 255.0,
            color.1 as f32 / 255.0,
            color.2 as f32 / 255.0,
            1.0f32,
        ];
        let (w, h) = dc.bg_size;
        let rect = RECT {
            left: off.x,
            top: off.y,
            right: off.x + w as i32,
            bottom: off.y + h as i32,
        };
        if let Ok(c1) = dc.ctx.cast::<ID3D11DeviceContext1>() {
            unsafe { c1.ClearView(&rtv, &col, Some(&[rect])) };
        } else {
            unsafe { dc.ctx.ClearRenderTargetView(&rtv, &col) };
        }
        Ok(())
    })();
    let _ = unsafe { surface.EndDraw() };
    res
}

fn scale_of(st: &WinState) -> f64 {
    let dpi = unsafe { GetDpiForWindow(HWND(st.main_hwnd as _)) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

// ── preview_sync (rAF 핫패스) ────────────────────────────────────────────────
pub fn sync(
    pane_id: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    hook_js: &'static str,
) -> Result<(), String> {
    let pane_id = pane_id.to_string();
    let url = url.to_string();
    on_main(move || unsafe { sync_on_main(pane_id, url, x, y, w, h, visible, hook_js) })?
}

unsafe fn sync_on_main(
    pane_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    hook_js: &'static str,
) -> Result<(), String> {
    // 서브클래스 재스캔(스로틀) — Chrome_* HWND 재생성 대비.
    with_state(|st| {
        if st.last_scan.elapsed() > Duration::from_millis(500) {
            unsafe { rescan_subclasses(st) };
        }
    });

    // 기존 pane: 프레임/URL 갱신.
    let existed = with_state(|st| -> Option<Result<(), String>> {
        let scale = scale_of(st);
        let sized = w > 1.0 && h > 1.0;
        let (lx, ly) = if visible && sized { (x, y) } else { (OFFSCREEN as f64, OFFSCREEN as f64) };
        let px = (lx * scale).round() as i32;
        let py = (ly * scale).round() as i32;
        let pw = (((if sized { w } else { 1.0 }) * scale).round() as i32).max(1);
        let ph = (((if sized { h } else { 1.0 }) * scale).round() as i32).max(1);
        let p = st.panes.get_mut(&pane_id)?;
        let moved = p.px != px || p.py != py;
        let resized = p.pw != pw || p.ph != ph;
        p.px = px;
        p.py = py;
        p.pw = pw;
        p.ph = ph;
        let nav = if !url.is_empty() && p.url != url {
            p.url = url.clone();
            p.core.clone().map(|c| (c, url.clone()))
        } else {
            None
        };
        if let (Some(ctrl), Some(visual)) = (p.ctrl.clone(), p.visual.clone()) {
            if resized {
                let _ = unsafe {
                    ctrl.SetBounds(RECT { left: 0, top: 0, right: pw, bottom: ph })
                };
                if let Ok(c3) = ctrl.cast::<ICoreWebView2Controller3>() {
                    let _ = unsafe { c3.SetRasterizationScale(scale) };
                }
            }
            if moved || resized {
                let _ = unsafe { visual.SetOffsetX2(px as f32) };
                let _ = unsafe { visual.SetOffsetY2(py as f32) };
                if let Some(dc) = &st.dcomp {
                    let _ = unsafe { dc.dev.Commit() };
                }
            }
        }
        // 입력 오버레이도 슬롯을 따라간다(숨김=화면 밖 이동도 여기서 처리된다 — px 가 바뀌므로 moved).
        if moved || resized {
            unsafe { place_overlay(p) };
        }
        if let Some((core, u)) = nav {
            let _ = unsafe { core.Navigate(&HSTRING::from(u.as_str())) };
        }
        Some(Ok(()))
    })
    .flatten();
    if let Some(r) = existed {
        return r;
    }

    // 최초 생성은 URL 이 있을 때만(macOS 동일). env 미확보면 다음 sync 에서 재시도.
    if url.is_empty() {
        return Ok(());
    }
    let setup = with_state(|st| -> Option<(ICoreWebView2Environment3, isize)> {
        let env3 = st.env3.clone()?;
        Some((env3, st.main_hwnd))
    })
    .flatten();
    let Some((env3, main_hwnd)) = setup else { return Ok(()) };

    // pending 엔트리 삽입(완료 핸들러가 채운다) — rect 는 물리 px 로 환산해 둔다.
    with_state(|st| {
        let scale = scale_of(st);
        let sized = w > 1.0 && h > 1.0;
        let (lx, ly) = if visible && sized { (x, y) } else { (OFFSCREEN as f64, OFFSCREEN as f64) };
        st.panes.insert(
            pane_id.clone(),
            Pane {
                comp: None,
                ctrl: None,
                core: None,
                visual: None,
                cursor: default_cursor(),
                url: url.clone(),
                closed: false,
                overlay: 0,
                px: (lx * scale).round() as i32,
                py: (ly * scale).round() as i32,
                pw: ((((if sized { w } else { 1.0 }) * scale).round()) as i32).max(1),
                ph: ((((if sized { h } else { 1.0 }) * scale).round()) as i32).max(1),
            },
        );
    });

    let pid = pane_id.clone();
    let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, comp: Option<ICoreWebView2CompositionController>| {
            // 메인 스레드(메시지 펌프) — 생성 마무리.
            if result.is_err() || comp.is_none() {
                with_state(|st| st.panes.remove(&pid));
                return Ok(());
            }
            unsafe { finish_create(pid.clone(), comp.unwrap(), hook_js) };
            Ok(())
        },
    ));
    unsafe { env3.CreateCoreWebView2CompositionController(HWND(main_hwnd as _), &handler) }
        .map_err(|e| format!("프리뷰 컨트롤러 생성 실패: {e}"))?;
    Ok(())
}

// 컨트롤러 생성 완료 → 이벤트/스크립트/비주얼 배선 + 최초 내비게이션.
unsafe fn finish_create(pane_id: String, comp: ICoreWebView2CompositionController, hook_js: &'static str) {
    let Ok(ctrl) = comp.cast::<ICoreWebView2Controller>() else { return };
    let Ok(core) = (unsafe { ctrl.CoreWebView2() }) else { return };

    // 닫혔거나 사라진 pane 이면 즉시 파기.
    let alive = with_state(|st| st.panes.get(&pane_id).map(|p| !p.closed).unwrap_or(false))
        .unwrap_or(false);
    if !alive {
        let _ = unsafe { ctrl.Close() };
        return;
    }

    // DPI/경계 모드 — Bounds 는 물리 px, 렌더 배율은 RasterizationScale.
    let scale = with_state(|st| scale_of(st)).unwrap_or(1.0);
    if let Ok(c3) = ctrl.cast::<ICoreWebView2Controller3>() {
        let _ = unsafe { c3.SetShouldDetectMonitorScaleChanges(false) };
        let _ = unsafe { c3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS) };
        let _ = unsafe { c3.SetRasterizationScale(scale) };
    }

    // 상시 콘솔/네트워크 후크 — 매 내비게이션 document start 재설치(macOS initialization_script 등가).
    let noop = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(())));
    let _ = unsafe { core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(hook_js), &noop) };

    // 로드 완료 → "preview-loaded"(macOS PageLoadEvent::Finished 등가).
    if let Some(app) = APP.get().cloned() {
        let pid = pane_id.clone();
        let nav = NavigationCompletedEventHandler::create(Box::new(move |sender, _args| {
            let url = sender
                .and_then(|s: ICoreWebView2| {
                    let mut p = PWSTR::null();
                    unsafe { s.Source(&mut p) }.ok().map(|_| take_pwstr(p))
                })
                .unwrap_or_default();
            let _ = app.emit("preview-loaded", serde_json::json!({ "pane": pid, "url": url }));
            Ok(())
        }));
        let mut tok = 0i64;
        let _ = unsafe { core.add_NavigationCompleted(&nav, &mut tok) };
    }

    // 커서 모양 — WM_SETCURSOR 에서 SetCursor 로 반영.
    {
        let pid = pane_id.clone();
        let cur = CursorChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(c) = sender {
                let mut hc = HCURSOR::default();
                if unsafe { c.Cursor(&mut hc) }.is_ok() {
                    with_state(|st| {
                        if let Some(p) = st.panes.get_mut(&pid) {
                            p.cursor = hc;
                        }
                    });
                }
            }
            Ok(())
        }));
        let mut tok = 0i64;
        let _ = unsafe { comp.add_CursorChanged(&cur, &mut tok) };
    }

    // DComp 비주얼: 프리뷰 렌더 타깃 + 배경 위/앱 웹뷰 아래 z.
    let wired = with_state(|st| -> Result<(ICoreWebView2, String, i32, i32, i32, i32), String> {
        unsafe { ensure_dcomp(st) }?;
        let dc = st.dcomp.as_ref().ok_or("DComp 없음")?;
        let visual = unsafe { dc.dev.CreateVisual() }.map_err(|e| e.to_string())?;
        unsafe { comp.SetRootVisualTarget(&visual) }.map_err(|e| e.to_string())?;
        let _ = unsafe { dc.root.AddVisual(&visual, true, &dc.bg_visual) };
        let p = st.panes.get_mut(&pane_id).ok_or("pane 소멸")?;
        let _ = unsafe { visual.SetOffsetX2(p.px as f32) };
        let _ = unsafe { visual.SetOffsetY2(p.py as f32) };
        let _ = unsafe { ctrl.SetBounds(RECT { left: 0, top: 0, right: p.pw, bottom: p.ph }) };
        let _ = unsafe { ctrl.SetIsVisible(true) };
        let _ = unsafe { dc.dev.Commit() };
        // 입력 오버레이 — 이 pane 의 마우스 입구(위 "입력 오버레이" 절 참조).
        if p.overlay == 0 {
            p.overlay = unsafe { create_overlay(HWND(st.host_hwnd as _)) };
            eprintln!(
                "[preview_win] 입력 오버레이 pane={} host={:#x} hwnd={:#x}",
                pane_id, st.host_hwnd, p.overlay
            );
        }
        unsafe { place_overlay(p) };
        p.comp = Some(comp.clone());
        p.ctrl = Some(ctrl.clone());
        p.core = Some(core.clone());
        p.visual = Some(visual);
        Ok((core.clone(), p.url.clone(), p.px, p.py, p.pw, p.ph))
    })
    .unwrap_or(Err("상태 없음".into()));

    match wired {
        Ok((core, url, ..)) => {
            if !url.is_empty() {
                let _ = unsafe { core.Navigate(&HSTRING::from(url.as_str())) };
            }
        }
        Err(_) => {
            // 비주얼 배선 실패 — 컨트롤러 정리.
            with_state(|st| st.panes.remove(&pane_id));
            let _ = unsafe { ctrl.Close() };
        }
    }
}

// ── 나머지 커맨드 구현 ───────────────────────────────────────────────────────

pub fn shield(on: bool) {
    SHIELD.store(on, Ordering::Relaxed);
    // 오버레이는 "보이면 삼킨다" 이므로 shield 중에는 반드시 숨겨야 DOM(모달·메뉴)이 입력을 받는다.
    //  다음 sync 를 기다리면 그 사이 클릭이 사라지므로 즉시 반영한다.
    let _ = on_main(move || {
        with_state(|st| {
            for p in st.panes.values() {
                unsafe { place_overlay(p) };
            }
        });
    });
}

pub fn navigate(pane_id: &str, url: &str) -> Result<(), String> {
    let pane = pane_id.to_string();
    let url = url.to_string();
    on_main(move || {
        let core = with_state(|st| {
            st.panes.get_mut(&pane).and_then(|p| {
                p.url = url.clone();
                p.core.clone()
            })
        })
        .flatten();
        if let Some(core) = core {
            let _ = unsafe { core.Navigate(&HSTRING::from(url.as_str())) };
        }
        Ok(())
    })?
}

// 페이지 줌(디바이스 에뮬레이션) — WKWebView.pageZoom 등가 = WebView2 ZoomFactor
//  (레이아웃 뷰포트 = rect폭÷zoom, 프론트 수식 그대로 동작).
pub fn zoom(pane_id: &str, zoom: f64) -> Result<(), String> {
    let pane = pane_id.to_string();
    on_main(move || {
        let ctrl = with_state(|st| st.panes.get(&pane).and_then(|p| p.ctrl.clone())).flatten();
        if let Some(ctrl) = ctrl {
            let _ = unsafe { ctrl.SetZoomFactor(zoom.clamp(0.05, 5.0)) };
        }
        Ok(())
    })?
}

pub fn window_set_bg(hex: &str) -> Result<(), String> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 {
        return Err("hex 형식(#rrggbb) 이어야 합니다".into());
    }
    let r = u8::from_str_radix(&h[0..2], 16).map_err(|e| e.to_string())?;
    let g = u8::from_str_radix(&h[2..4], 16).map_err(|e| e.to_string())?;
    let b = u8::from_str_radix(&h[4..6], 16).map_err(|e| e.to_string())?;
    on_main(move || {
        with_state(|st| {
            st.bg = (r, g, b);
            if let Some(dc) = &st.dcomp {
                let _ = unsafe { fill_bg(dc, (r, g, b)) };
                let _ = unsafe { dc.dev.Commit() };
            }
        });
        Ok(())
    })?
}

pub fn control(pane_id: &str, action: &str, dark_on: &'static str, dark_off: &'static str) -> Result<(), String> {
    let pane = pane_id.to_string();
    let action = action.to_string();
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else { return Err("프리뷰 없음".to_string()) };
        unsafe {
            match action.as_str() {
                "back" => { let _ = core.GoBack(); }
                "forward" => { let _ = core.GoForward(); }
                "reload" => { let _ = core.Reload(); }
                // 별도 창 데브툴(WebView2 는 인스펙터 in-pane 도킹 미제공 — chii 경로가 도킹 담당).
                "devtools" => { let _ = core.OpenDevToolsWindow(); }
                "devtools_fit" => {}
                other => {
                    let js = if other == "theme_on" { dark_on } else { dark_off };
                    let noop = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = core.ExecuteScript(&HSTRING::from(js), &noop);
                }
            }
        }
        Ok(())
    })?
}

pub fn info(pane_id: &str) -> Result<PreviewInfo, String> {
    let pane = pane_id.to_string();
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else { return Err("프리뷰 없음".to_string()) };
        unsafe {
            let mut url_p = PWSTR::null();
            let url = core.Source(&mut url_p).ok().map(|_| take_pwstr(url_p)).unwrap_or_default();
            let mut title_p = PWSTR::null();
            let title = core
                .DocumentTitle(&mut title_p)
                .ok()
                .map(|_| take_pwstr(title_p))
                .unwrap_or_default();
            let mut back = BOOL(0);
            let mut fwd = BOOL(0);
            let _ = core.CanGoBack(&mut back);
            let _ = core.CanGoForward(&mut fwd);
            Ok(PreviewInfo { url, title, can_back: back.as_bool(), can_fwd: fwd.as_bool() })
        }
    })?
}

// JSON 문자열 반환 계약 정합: ExecuteScript 결과는 "결과값의 JSON"(문자열이면 따옴표 포함) —
//  macOS(evaluateJavaScript 는 NSString 원문)와 맞추기 위해 최상위 JSON string 은 벗겨서 돌려준다.
fn unwrap_json_string(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Null) => "null".to_string(),
        _ => raw.to_string(),
    }
}

pub fn eval(pane: String, js: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else {
            let _ = tx.send(Err("프리뷰 없음".into()));
            return;
        };
        let tx2 = tx.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(
            move |ec: windows::core::Result<()>, json: String| {
                let out = match ec {
                    Err(e) => Err(format!("JS 평가 오류: {e}")),
                    Ok(()) => Ok(unwrap_json_string(&json)),
                };
                let _ = tx2.send(out);
                Ok(())
            },
        ));
        if let Err(e) = unsafe { core.ExecuteScript(&HSTRING::from(js.as_str()), &handler) } {
            let _ = tx.send(Err(format!("JS 평가 시작 실패: {e}")));
        }
    })?;
    rx.recv_timeout(Duration::from_secs(25))
        .map_err(|_| "JS 평가 시간 초과".to_string())?
}

// IStream 전체 읽기(Seek 0 → EOF).
unsafe fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
    let _ = unsafe { stream.Seek(0, STREAM_SEEK_SET, None) };
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        let mut read = 0u32;
        let hr = unsafe {
            stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read))
        };
        if read == 0 {
            if hr.is_err() && out.is_empty() {
                return Err(format!("스트림 읽기 실패: {hr}"));
            }
            break;
        }
        out.extend_from_slice(&buf[..read as usize]);
    }
    Ok(out)
}

fn encode_jpeg(img: &image::DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    img.write_with_encoder(enc).map_err(|e| format!("JPEG 인코딩 실패: {e}"))?;
    Ok(buf)
}

// 보이는 영역 스크린샷 → JPEG base64 (PNG 캡처 후 0.8, 2MB 초과 시 0.4 재인코딩 — macOS 규칙).
pub fn screenshot(pane: String) -> Result<String, String> {
    use base64::Engine;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else {
            let _ = tx.send(Err("프리뷰 없음".into()));
            return;
        };
        let Some(stream) = (unsafe { SHCreateMemStream(None) }) else {
            let _ = tx.send(Err("메모리 스트림 생성 실패".into()));
            return;
        };
        let s2 = stream.clone();
        let tx2 = tx.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(
            move |ec: windows::core::Result<()>| {
                let out = ec
                    .map_err(|e| format!("스냅샷 오류: {e}"))
                    .and_then(|_| unsafe { read_stream(&s2) });
                let _ = tx2.send(out);
                Ok(())
            },
        ));
        if let Err(e) = unsafe {
            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
        } {
            let _ = tx.send(Err(format!("스냅샷 시작 실패: {e}")));
        }
    })?;
    let png = rx
        .recv_timeout(Duration::from_secs(25))
        .map_err(|_| "스크린샷 시간 초과".to_string())??;
    let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 디코드 실패: {e}"))?;
    let mut jpeg = encode_jpeg(&img, 80)?;
    if jpeg.len() > 2 * 1024 * 1024 {
        if let Ok(smaller) = encode_jpeg(&img, 40) {
            jpeg = smaller;
        }
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&jpeg))
}

// 쿠키 캡처(httpOnly 포함) — macOS cookies_to_json 과 동일 스키마.
pub fn cookies(pane: String) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else {
            let _ = tx.send(Err("프리뷰 없음".into()));
            return;
        };
        let Ok(w2) = core.cast::<ICoreWebView2_2>() else {
            let _ = tx.send(Err("CookieManager 미지원".into()));
            return;
        };
        let Ok(mgr) = (unsafe { w2.CookieManager() }) else {
            let _ = tx.send(Err("CookieManager 조회 실패".into()));
            return;
        };
        let tx2 = tx.clone();
        let handler = GetCookiesCompletedHandler::create(Box::new(
            move |ec: windows::core::Result<()>, list: Option<ICoreWebView2CookieList>| {
                let out = ec
                    .map_err(|e| format!("쿠키 조회 오류: {e}"))
                    .map(|_| unsafe { cookie_list_to_json(list) });
                let _ = tx2.send(out);
                Ok(())
            },
        ));
        // uri = null → 프로필 전체 쿠키.
        if let Err(e) = unsafe { mgr.GetCookies(PCWSTR::null(), &handler) } {
            let _ = tx.send(Err(format!("쿠키 조회 시작 실패: {e}")));
        }
    })?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "쿠키 조회 시간 초과".to_string())?
}

unsafe fn cookie_list_to_json(list: Option<ICoreWebView2CookieList>) -> String {
    let mut arr: Vec<serde_json::Value> = Vec::new();
    if let Some(list) = list {
        let mut n = 0u32;
        let _ = unsafe { list.Count(&mut n) };
        for i in 0..n {
            let Ok(c) = (unsafe { list.GetValueAtIndex(i) }) else { continue };
            let s = |get: &dyn Fn(*mut PWSTR) -> windows::core::Result<()>| -> String {
                let mut p = PWSTR::null();
                get(&mut p).ok().map(|_| take_pwstr(p)).unwrap_or_default()
            };
            let name = s(&|p| unsafe { c.Name(p) });
            let value = s(&|p| unsafe { c.Value(p) });
            let domain = s(&|p| unsafe { c.Domain(p) });
            let path = s(&|p| unsafe { c.Path(p) });
            let mut secure = BOOL(0);
            let mut http_only = BOOL(0);
            let mut session = BOOL(0);
            let _ = unsafe { c.IsSecure(&mut secure) };
            let _ = unsafe { c.IsHttpOnly(&mut http_only) };
            let _ = unsafe { c.IsSession(&mut session) };
            let mut expires = 0f64;
            let _ = unsafe { c.Expires(&mut expires) };
            let expires_at = if session.as_bool() {
                serde_json::Value::Null
            } else {
                serde_json::json!(expires)
            };
            let mut ss = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
            let same_site = if unsafe { c.SameSite(&mut ss) }.is_ok() {
                serde_json::json!(match ss {
                    x if x == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT => "Strict",
                    x if x == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE => "None",
                    _ => "Lax",
                })
            } else {
                serde_json::Value::Null
            };
            arr.push(serde_json::json!({
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
                "expiresAt": expires_at,
                "secure": secure.as_bool(),
                "httpOnly": http_only.as_bool(),
                "sameSite": same_site,
                "session": session.as_bool(),
            }));
        }
    }
    serde_json::Value::Array(arr).to_string()
}

#[derive(serde::Deserialize)]
struct CookieSpecWin {
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

// 쿠키 심기 — AddOrUpdateCookie 는 동기라 배리어 불요(macOS 는 completionHandler 직렬).
pub fn set_cookies(pane: String, cookies_json: String) -> Result<(), String> {
    let parsed: Vec<CookieSpecWin> =
        serde_json::from_str(&cookies_json).map_err(|e| format!("쿠키 JSON 파싱 실패: {e}"))?;
    on_main(move || {
        let core = with_state(|st| st.panes.get(&pane).and_then(|p| p.core.clone())).flatten();
        let Some(core) = core else { return Err("프리뷰 없음".to_string()) };
        let w2 = core
            .cast::<ICoreWebView2_2>()
            .map_err(|_| "CookieManager 미지원".to_string())?;
        let mgr = unsafe { w2.CookieManager() }.map_err(|e| e.to_string())?;
        for spec in &parsed {
            let cookie = unsafe {
                mgr.CreateCookie(
                    &HSTRING::from(spec.name.as_str()),
                    &HSTRING::from(spec.value.as_str()),
                    &HSTRING::from(spec.domain.as_str()),
                    &HSTRING::from(spec.path.as_deref().unwrap_or("/")),
                )
            };
            let Ok(cookie) = cookie else { continue };
            if let Some(secs) = spec.expires_at {
                let _ = unsafe { cookie.SetExpires(secs) };
            }
            if spec.secure.unwrap_or(false) {
                let _ = unsafe { cookie.SetIsSecure(true) };
            }
            let _ = unsafe { mgr.AddOrUpdateCookie(&cookie) };
        }
        Ok(())
    })?
}

pub fn close(pane_id: &str) {
    let pane = pane_id.to_string();
    let _ = on_main(move || {
        with_state(|st| {
            if st.hover.as_deref() == Some(pane.as_str()) {
                st.hover = None;
            }
            if st.capture.as_deref() == Some(pane.as_str()) {
                st.capture = None;
            }
            if let Some(mut p) = st.panes.remove(&pane) {
                p.closed = true;
                unsafe { destroy_overlay(&mut p) };
                if let Some(ctrl) = p.ctrl.take() {
                    let _ = unsafe { ctrl.Close() };
                }
                if let (Some(dc), Some(visual)) = (st.dcomp.as_ref(), p.visual.take()) {
                    let _ = unsafe { dc.root.RemoveVisual(&visual) };
                    let _ = unsafe { dc.dev.Commit() };
                }
            } else {
                // 생성 완료 전 close — 완료 핸들러가 파기하도록 마킹된 pending 이 없으니
                //  (remove 로 이미 사라짐) finish_create 의 alive 검사로 정리된다.
            }
        });
    });
}

// 앱 종료/정리 시 전부 닫기(best-effort — 루프가 죽어가는 중이면 조용히 무시).
pub fn close_all() {
    let _ = on_main(|| {
        with_state(|st| {
            let ids: Vec<String> = st.panes.keys().cloned().collect();
            for id in ids {
                if let Some(mut p) = st.panes.remove(&id) {
                    unsafe { destroy_overlay(&mut p) };
                    if let Some(ctrl) = p.ctrl.take() {
                        let _ = unsafe { ctrl.Close() };
                    }
                    if let (Some(dc), Some(visual)) = (st.dcomp.as_ref(), p.visual.take()) {
                        let _ = unsafe { dc.root.RemoveVisual(&visual) };
                    }
                }
            }
            if let Some(dc) = &st.dcomp {
                let _ = unsafe { dc.dev.Commit() };
            }
        });
    });
}
