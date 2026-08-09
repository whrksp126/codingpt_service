# Windows 프리뷰 punch-through 구현 노트 (`preview_win.rs`)

> 워크스트림 B2 산출물. 정본 계약은 `design.md` 계약 3.
> macOS `preview.rs` 의 WKWebView punch-through 를 WebView2 + DirectComposition 으로 완전 재현한다.
> **프론트 무수정** — Tauri 커맨드 시그니처·페이로드·이벤트(`preview-loaded`/`preview-focus`) 전부 동일.

## 레이어 모델 (macOS 대응표)

```
macOS                                   Windows
─────────────────────────────────────   ─────────────────────────────────────────────
NSWindow backgroundColor (누수 색)       DComp 배경 비주얼(단색 서페이스, 가상 스크린 크기)
프리뷰 컨테이너 NSView (형제 최하단)      프리뷰 pane 비주얼 ← CompositionController 가 직접 렌더
앱 웹뷰 WKWebView (drawsBackground=NO)   앱 웹뷰 WebView2 (DefaultBackgroundColor alpha 0)
```

- DComp 타깃은 **메인 HWND 가 아니라 wry 의 앱 웹뷰 컨테이너 `WRY_WEBVIEW` HWND** 에
  `CreateTargetForHwnd(host, topmost=FALSE)` 로 건다. topmost=FALSE = "이 창의 자식 HWND 들
  (Chrome_WidgetWin_* = 앱 웹뷰) **아래**, 이 창 자체 표면 위" — WRY_WEBVIEW 의 미페인트
  redirection 표면 문제를 비주얼 트리가 덮어서 회피하는 효과도 있다.
- 앱 웹뷰 투명화는 **런타임**에 한다: `install_punch_through` → tauri
  `PlatformWebview::controller()` → `ICoreWebView2Controller2::SetDefaultBackgroundColor({A:0})`.
  → `tauri.conf` 의 `transparent` 옵션 불필요(창 자체는 불투명 유지 — 누수 색은 DComp 배경이 담당).
- 프리뷰 웹뷰는 **CompositionController** (`ICoreWebView2Environment3::
  CreateCoreWebView2CompositionController`, 앱 웹뷰와 같은 environment 재사용 = 같은 브라우저
  프로세스/프로필). `SetRootVisualTarget(비주얼)` 로 렌더만 우리 트리에 붙는다. 위치는 비주얼
  `SetOffsetX2/Y2`(물리 px), 크기는 `SetBounds({0,0,w,h})` + `COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS`
  + `SetRasterizationScale(dpi/96)`.

## 입력 라우팅 (macOS hitTest 스위즐 등가)

- `WRY_WEBVIEW` 서브트리 전체(HWND 전부)를 `SetWindowSubclass` — 마우스 메시지는 커서 아래
  Chrome_RenderWidgetHostHWND 로 오므로 어떤 자손이 받든 우리 proc 이 먼저 본다.
  Chrome_* HWND 는 재생성될 수 있어 **preview_sync(rAF) 마다 500ms 스로틀 재스캔** + `IsWindow` 프룬.
- 슬롯 rect(물리 px, `preview_sync` 가 매 프레임 갱신) 안 + shield off →
  `SendMouseInput(COREWEBVIEW2_MOUSE_EVENT_KIND(msg), LOWORD(wParam), mousedata, 슬롯상대좌표)`
  후 **스왈로우**(LRESULT 0). 밖이면 `DefSubclassProc` 통과(앱 웹뷰가 처리).
- 휠 메시지 lParam 은 화면좌표 → `ScreenToClient`; 그 외는 수신 HWND 좌표 → `MapWindowPoints`.
- 버튼 down: `SetCapture` + pane 캡처 마킹(슬롯 밖 드래그 추적), `MoveFocus(PROGRAMMATIC)`
  (키보드 포커스 이동 — macOS first responder 등가), 좌클릭이면 `preview-focus` emit (R4 동일).
- hover 전환/이탈 시 이전 pane 에 `WM_MOUSELEAVE` kind 합성.
- 커서: `CursorChanged` 이벤트로 pane 별 HCURSOR 저장 → 슬롯 위 `WM_SETCURSOR` 에서 `SetCursor`.
- shield on(`preview_shield`): 위 경로 전부 통과 = 모달/메뉴가 이벤트를 받는다(정적 AtomicBool).
- `WM_POINTER*`(터치/펜): 슬롯 위면 **스왈로우만**(앱 웹뷰 누수 차단). `SendPointerInput`
  포워딩은 1차 미구현 — 아래 리스크 7.

## 기능 API 매핑

| 커맨드 | macOS | Windows |
|---|---|---|
| `preview_eval` | evaluateJavaScript+completionHandler | `ExecuteScript` — 결과는 "값의 JSON"이라 최상위 JSON string 을 벗겨 macOS(원문 문자열) 계약에 정합 |
| `preview_screenshot` | takeSnapshot→JPEG 0.8→(>2MB)0.4 | `CapturePreview(PNG)`→`image` crate 로 JPEG 0.8→(>2MB)0.4 — 동일 규칙, base64 |
| `preview_cookies` | WKHTTPCookieStore.getAllCookies | `CookieManager.GetCookies(null)` = 프로필 전체(httpOnly 포함), JSON 스키마 동일(name/value/domain/path/expiresAt/secure/httpOnly/sameSite/session) |
| `preview_set_cookies` | setCookie FIFO+배리어 | `CreateCookie`→`AddOrUpdateCookie`(동기라 배리어 불요) |
| `preview_zoom` | WKWebView.pageZoom | `ICoreWebView2Controller.ZoomFactor` — 같은 의미론(레이아웃 뷰포트=rect폭÷zoom), 프론트 수식 무수정 |
| `preview_control` back/fwd/reload | WK 히스토리 | `GoBack/GoForward/Reload` |
| `preview_control` devtools | WKInspector(in-pane 도킹) | `OpenDevToolsWindow`(별도 창). `devtools_fit`=no-op. chii 데브툴 경로는 크로스플랫폼이라 그대로 |
| `preview_info` | title/URL/canGoBack/canGoForward | `DocumentTitle/Source/CanGoBack/CanGoForward` |
| `window_set_bg` | NSWindow.backgroundColor | DComp 배경 비주얼 단색 재도색(`ClearView` — BeginDraw 아틀라스 오프셋 반영) |
| 콘솔/네트워크 후크 | initialization_script | `AddScriptToExecuteOnDocumentCreated` — 같은 `CONSOLE_HOOK_JS` 를 preview.rs 에서 인자로 전달(중복 정의 없음) |
| `preview-loaded` | PageLoadEvent::Finished | `NavigationCompleted`(성공/실패 불문 — mac 과 동일) |

## 스레딩

- WebView2/DComp 는 UI 스레드 강제 → COM 상태 전부 **메인 스레드 `thread_local`** (`STATE`).
  Send 우회 없음.
- 커맨드 스레드는 `on_main()` 으로 마샬링. **tauri v2 sync 커맨드는 메인 스레드에서 돌 수 있어**
  현재 스레드가 메인이면 인라인 실행(큐잉하면 자기 자신 대기 데드락).
- 비동기 완료(ExecuteScript/CapturePreview/GetCookies/컨트롤러 생성)는 메시지 펌프가 메인
  스레드로 배달 → 커맨드(async, tokio 스레드)는 mpsc `recv_timeout` 으로 회수(맥의
  completionHandler+recv_timeout 패턴과 동일 구조). 컨트롤러 생성만 fire-and-forget
  (pane 을 pending 으로 넣고 완료 핸들러가 채움 — rAF sync 가 계속 들어오므로 자연 수렴).
- 재진입 규율: 서브클래스 proc 은 borrow 짧게(판정/부기) → **COM 호출·emit 은 borrow 밖**.

## 파일/빌드

- 신규: `codingpt_pc/src-tauri/src/preview_win.rs` (preview.rs 의 `#[cfg(windows)] #[path] mod` 자식
  모듈 — lib.rs 무수정으로 등록. 커맨드 등록도 기존 preview::* 그대로라 **lib.rs 변경 불요**).
- `preview.rs`: 각 커맨드의 비-mac 자리에 `#[cfg(target_os="windows")]` 위임 분기만 추가
  (mac 블록 무수정, 기존 타 플랫폼 폴백은 `not(any(macos, windows))` 로 조정).
- `Cargo.toml` win32 타깃 deps: `webview2-com 0.38` / `windows 0.61`(wry 와 동일 계열 — 다르면
  tauri PlatformWebview 의 COM 타입과 불일치로 컴파일 불가), `image`(jpeg 추가). B1 의 기존
  win32 섹션과 병합됨(동일 테이블 중복 금지).

## 검증 상태 (2026-08-10, mac 크로스체크)

- `cargo check`(mac): 통과 — 무회귀(기존 경고 1건만: preview.rs mac 블록의 중첩 unsafe, 종전과 동일).
- `cargo check --target x86_64-pc-windows-msvc`: **통과**. mac 에서 돌리는 정확한 명령
  (brew `llvm`+`mingw-w64` 필요 — `ring` 빌드스크립트 C 컴파일과 `tauri-winres` 의 `llvm-rc`,
  MSVC 스타일 아카이버 `llvm-lib` 때문):
  ```
  PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
  CC_x86_64_pc_windows_msvc=x86_64-w64-mingw32-gcc \
  AR_x86_64_pc_windows_msvc=/opt/homebrew/opt/llvm/bin/llvm-lib \
  cargo check --target x86_64-pc-windows-msvc
  ```
- `cargo check --target x86_64-pc-windows-gnu` (`CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc`):
  역시 통과(mingw-w64 만으로 됨 — 더 간단한 로컬 사전검증 경로).
- 두 타깃 모두 경고 6건 = 전부 "mac 전용 코드가 windows 타깃에서 미사용"
  (sanitize/webview_of/Entry 필드 등) — 무해.
- 실기 동작 검증은 웨이브 3(Windows 머신) — 아래 리스크가 그 체크리스트다.

## 실기에서 확인할 리스크 (중요도순)

1. **투명 합성 체인**: "DComp 비주얼(WRY_WEBVIEW 타깃, topmost=FALSE) 이 투명 앱 웹뷰
   (Chrome_WidgetWin, WS_EX_NOREDIRECTIONBITMAP 계열) 뒤로 비치는가"가 이 설계의 근간.
   DWM 합성 의미론상 성립해야 하나 실측 전 확신 불가. 실패 시 폴백: ① 타깃을 메인 HWND 로
   옮기고 topmost=FALSE ② 메인 창 `transparent:true`(B1 오버레이) + WS_EX_NOREDIRECTIONBITMAP.
2. **SendMouseInput 좌표계**: Bounds 를 {0,0,w,h} 로 두고 슬롯 상대좌표를 보낸다(공식 샘플의
   visual hosting 패턴). 클릭 오프셋이 틀어지면 여기부터 본다. 부작용 후보: `<select>` 드롭다운
   등 팝업 위치가 슬롯 원점만큼 어긋날 수 있음(Bounds 가 화면 배치 힌트로도 쓰이는 경우) —
   어긋나면 Bounds 를 실제 슬롯 rect 로 두고 입력 좌표를 호스트 좌표로 바꾸는 변형과 비교.
3. **키보드/IME**: 클릭 시 `MoveFocus(PROGRAMMATIC)` 로 포커스 이동 — composition 모드에서
   키보드가 WebView2 의 숨은 입력 HWND 로 자연 유입되는지, 한글 IME 조합창 위치가 맞는지 실측.
   앱 UI 클릭 시 포커스 복귀(앱 웹뷰가 스스로 가져감)도 확인.
4. **서브클래스 대상 재생성**: 렌더러 크래시/복구·site isolation 으로 Chrome_* HWND 가 바뀌는
   시나리오에서 500ms 재스캔이 충분한지(입력 데드존이 순간 생길 수 있음).
5. **드래그 캡처**: down 시 `SetCapture(수신 hwnd)` 가 chromium 자체 캡처 로직과 충돌하지 않는지
   (우리는 슬롯 안 메시지를 스왈로우하므로 chromium 은 그 클릭을 모른다). `WM_CAPTURECHANGED`
   로 캡처 소실은 방어해 둠.
6. **preview_sync 핫패스 비용**: rAF 마다 `on_main`(메인 스레드면 인라인) — sync 커맨드가
   비-메인에서 돌 경우 초당 60회 run_on_main_thread 큐잉이 되는데 문제 없는지(맥 with_webview 도
   동일 구조라 예상 무해).
7. **터치/펜**: WM_POINTER 는 슬롯 위에서 스왈로우만 — 프리뷰 터치 조작은 아직 안 됨(마우스는
   완전). 필요 시 `CreateCoreWebView2PointerInfo`+`SendPointerInput` 이식(2차).
8. **가림/절전**: macOS 의 occlusion 공백(빈 창) 등가 증상이 있는지 — WebView2 는
   `TrySuspend` 를 우리가 안 부르므로 이론상 없음. 최소화→복귀·다른 가상 데스크톱 전환 확인.
9. **DPI 혼합 모니터**: `ShouldDetectMonitorScaleChanges(false)` + 매 sync `GetDpiForWindow`
   재적용 — 창을 다른 배율 모니터로 옮겼을 때 흐림/크기 오류 확인.
10. **배경 서페이스 메모리**: 가상 스크린 크기 B8G8R8A8 1장(4K≈33MB GPU). 과하면 1×1+transform
    (windows-numerics)으로 교체.
11. **`GetCookies(null)` 범위**: 프로필 전체 쿠키 반환(문서상). 세션 핸드오프 매니페스트가
    현재 사이트 외 쿠키를 과다 포함하지 않는지 확인(맥은 웹뷰 스토어 전체 — 의미상 동일).

## B1/E 에 전달할 요구사항

- **B1 (lib.rs / tauri conf)**: 추가 요구 **없음**. 커맨드 등록·`install_punch_through` 호출·
  `close_all` 호출 전부 기존 것 재사용, 모듈 등록은 preview.rs 내부 `#[path] mod` 로 해결.
  메인 창 `transparent` 옵션도 현재 불요(런타임 투명화). 단, 리스크 1 폴백 ② 가 필요해지면
  `tauri.windows.conf.json` 에 main 창 `"transparent": true` 를 넣어야 하니 그때 요청 예정.
  Cargo.toml 은 B1 win32 섹션에 병합 완료(중복 테이블 금지 — 이후 추가 시 같은 섹션에).
- **E (CI)**: windows-latest `cargo check --target x86_64-pc-windows-msvc` 는 추가 준비물 없이
  통과해야 정상(러너에 MSVC/rc 존재). mac 로컬 사전검증 명령은 위 "검증 상태" 절 참조
  (msvc = llvm+mingw-w64, gnu = mingw-w64 만).
  WebView2 Runtime 은 NSIS `webviewInstallMode=downloadBootstrapper`(계약 6)로 충족 —
  CompositionController 는 런타임 기본 기능이라 추가 요구 없음.
