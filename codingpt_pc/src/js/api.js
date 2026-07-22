// api.js — Tauri IPC 래퍼. Rust 커맨드/이벤트를 한 곳에서 노출한다.
//  Tauri v2 는 JS camelCase 인자를 Rust snake_case 로 자동 매핑한다.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export const api = {
  // ── 데몬 상태/페어링(기존 유지, 설정→연결에서 사용) ──
  daemonStatus: () => invoke("daemon_status"),
  pair: (code, server) => invoke("daemon_pair", { code, server: server || null }),
  pairSession: (server) => invoke("daemon_pair_session", { server: server || null }),
  pairPoll: (server, code, secret) =>
    invoke("daemon_pair_poll", { server: server || null, code, secret }),
  daemonStart: () => invoke("daemon_start"),
  daemonStop: () => invoke("daemon_stop"),
  unpair: () => invoke("daemon_unpair"),

  // ── 워크스페이스(백엔드, deviceToken 인증은 Rust 내부) ──
  fetchWorkspaces: () => invoke("fetch_workspaces"),
  // 로그인 계정 프로필(deviceToken→user). 미로그인이면 null.
  fetchMe: () => invoke("fetch_me"),
  // 계정의 모든 기기 목록(멀티기기 "내 기기"). 미로그인이면 null.
  fetchDevices: () => invoke("fetch_devices"),
  updateNickname: (nickname) => invoke("update_nickname", { nickname }),
  updateAppearance: (appearance) => invoke("update_appearance", { appearance }),
  deleteAccount: () => invoke("delete_account"),
  revokeDevice: (deviceId) => invoke("revoke_device", { deviceId }),
  // 로컬 워크스페이스를 이 기기(호스트)에 귀속(백필).
  claimWorkspace: (wsId) => invoke("claim_workspace", { wsId }),
  projectDetach: (wsId) => invoke("project_detach", { wsId }),
  projectAttach: (wsId, targetWsId) => invoke("project_attach", { wsId, targetWsId }),
  // 홈-상대 경로가 이 기기에 실재하는 디렉토리인지.
  pathExists: (rel) => invoke("path_exists", { rel }),
  // 웹 로그인 URL(프론트 /desktop-login?code=) — Rust 가 서버에서 프론트 주소 파생.
  desktopLoginUrl: (code) => invoke("desktop_login_url", { code }),
  // 워크스페이스 세션 상태(이어받기) — 열린 터미널/IDE/프리뷰 + 레이아웃.
  fetchWsSession: (wsId) => invoke("fetch_ws_session", { wsId }),
  saveWsSession: (wsId, session) => invoke("save_ws_session", { wsId, session }),
  createWorkspace: (absPath) => invoke("create_workspace", { absPath }),
  // 네이티브 폴더 피커(이 PC 로컬 워크스페이스). 취소 시 null.
  pickFolder: async (defaultPath) => {
    const d = window.__TAURI__?.dialog;
    if (d?.open) return await d.open({ directory: true, multiple: false, defaultPath });
    return null;
  },
  // ── 외부 PC(다른 기기) 폴더 브라우징/생성 — back 릴레이 fs API 를 hostDeviceId 로 라우팅 ──
  remoteFsList: (path, hostDeviceId) => invoke("remote_fs_list", { path: path || "", hostDeviceId: hostDeviceId ?? null }),
  remoteFsMkdir: (path, hostDeviceId) => invoke("remote_fs_mkdir", { path, hostDeviceId: hostDeviceId ?? null }),
  remoteWsCreate: (path, hostDeviceId) => invoke("remote_ws_create", { path: path || "", hostDeviceId: hostDeviceId ?? null }),

  // ── 로컬 터미널 pane (tmux) ──
  ptyOpen: (paneId, localPath, winIndex, cols, rows) =>
    invoke("pty_open", { paneId, localPath, winIndex, cols, rows }),
  ptyWrite: (paneId, data) => invoke("pty_write", { paneId, data }),
  ptyResize: (paneId, cols, rows) => invoke("pty_resize", { paneId, cols, rows }),
  // 크기 주장 — 창이 다른 기기 크기면 클라이언트 nudge 로 latest 획득(이미 내 크기면 no-op).
  ptyClaim: (paneId) => invoke("pty_claim", { paneId }),
  // 채널 실제 생존 여부 — 리컨실러 워치독이 스테일 낙관 상태를 바로잡는 진실 원천.
  ptyAlive: (paneId) => invoke("pty_alive", { paneId }),
  // 진단 로그(stderr) — 터미널 탭 소거/편입 등 상태 변화 사후 추적용.
  debugLog: (msg) => invoke("debug_log", { msg: String(msg) }).catch(() => {}),
  ptyClose: (paneId) => invoke("pty_close", { paneId }),

  // ── tmux 제어(터미널=전용 세션/포트) — index 자리의 숫자는 안정 터미널 ID(tid) ──
  listWindows: (localPath) => invoke("tmux_list_windows", { localPath }),
  newWindow: (localPath, paneId) => invoke("tmux_new_window", { localPath, paneId: paneId || null }),
  killWindow: (localPath, index) => invoke("tmux_kill_window", { localPath, index }),
  listenPorts: (localPath = "") => invoke("tmux_listen_ports", { localPath }),

  // ── 클라우드 터미널(relay) ──
  // 원격 터미널(back 릴레이) — hostDeviceId 지정=다른 PC 의 워크스페이스(활성 러너 무변경).
  cloudTerminalStart: (cwd, hostDeviceId, paneId) =>
    invoke("cloud_terminal_start", { cwd, hostDeviceId: hostDeviceId ?? null, paneId: paneId ?? null }),

  // ── 내장 IDE 파일 접근(로컬, 홈 jail) ──
  fsTree: (rel, depth) => invoke("fs_tree", { rel, depth: depth ?? 2 }),
  fsSearch: (rel, query, max) => invoke("fs_search", { rel, query, max: max ?? 500 }),
  fsRead: (rel) => invoke("fs_read", { rel }),
  fsWrite: (rel, content) => invoke("fs_write", { rel, content }),
  fsMkdir: (rel) => invoke("fs_mkdir", { rel }),
  fsCreateFile: (rel) => invoke("fs_create_file", { rel }),
  fsRename: (rel, dest) => invoke("fs_rename", { rel, dest }),
  fsDelete: (rel) => invoke("fs_delete", { rel }),

  // ── UI 레이아웃 영속화 ──
  uiLoad: () => invoke("ui_state_load"),
  uiSave: (state) => invoke("ui_state_save", { state }),

  // ── 외부 브라우저 열기 ──
  openExternal: (url) => invoke("open_external", { url }),
  openPrivacySettings: () => invoke("open_privacy_settings"), // macOS 전체 디스크 접근 설정(온보딩)
  notifPermission: () => invoke("notification_permission"), // 알림 권한 요청(온보딩) → granted 여부
  probeFolder: (folder) => invoke("probe_folder_access", { folder }), // downloads|desktop|documents → 허용 여부(최초엔 macOS 팝업)
  openFilesPrivacy: () => invoke("open_files_privacy_settings"), // '파일 및 폴더' 설정(거부 복구용)

  // ── 프리뷰(네이티브 임베디드 webview) ──
  previewSync: (paneId, url, x, y, w, h, visible, raised) =>
    invoke("preview_sync", { paneId, url: url || "", x, y, w, h, visible, raised: !!raised }),
  previewNavigate: (paneId, url) => invoke("preview_navigate", { paneId, url }),
  previewControl: (paneId, action) => invoke("preview_control", { paneId, action }),
  previewInfo: (paneId) => invoke("preview_info", { paneId }),
  // 프리뷰 페이지 JS 평가(결과 회수) — 호출측이 JSON.stringify 문자열 반환을 보장할 것.
  previewEval: (paneId, js) => invoke("preview_eval", { pane: paneId, js }),
  // 크롬 데브툴 별도 창(Undock) 열기/닫기 — devtools.js 전용.
  devtoolsWindow: (pv, open) => invoke("devtools_window", { pv, open }),
  // 프리뷰 보이는 영역 스크린샷 — JPEG base64 문자열.
  previewScreenshot: (paneId) => invoke("preview_screenshot", { pane: paneId }),
  // 프리뷰 세션 핸드오프 — 쿠키 캡처/심기(httpOnly 포함, WKHTTPCookieStore). JSON 문자열 왕복.
  previewCookies: (paneId) => invoke("preview_cookies", { pane: paneId }),
  previewSetCookies: (paneId, cookiesJson) => invoke("preview_set_cookies", { pane: paneId, cookiesJson }),
  onPreviewLoaded: (cb) => listen("preview-loaded", (e) => cb(e.payload)),
  previewClose: (paneId) => invoke("preview_close", { paneId }),

  // ── 네이티브 알림 ──
  notify: (title, body) => invoke("notify", { title, body: body || "" }),

  // ── 범용 오버레이 창(프리뷰 웹뷰 위에 뜨는 메뉴·패널·토스트) — punch-through 전환으로 비활성 ──
  overlayEnsure: () => invoke("overlay_ensure"),
  overlayHide: () => invoke("overlay_hide"),

  // ── punch-through(프리뷰=앱 UI 아래층) ──
  previewShield: (on) => invoke("preview_shield", { on: !!on }), // DOM 오버레이 동안 프리뷰 이벤트 차단
  windowSetBg: (hex) => invoke("window_set_bg", { hex }), // 창 배경 = 테마 base(투명 누수 영역 커버)

  // ── 자동 업데이트(번들 앱 전용 — tauri dev 에선 updateCheck 가 error 반환) ──
  appVersion: () => invoke("app_version"),
  updateCheck: () => invoke("update_check"),
  updateInstall: () => invoke("update_install"),
  onUpdateProgress: (cb) => listen("cpt-update-progress", (e) => cb(e.payload)),

  // ── 앱 종료 가드 — IDE 전역 dirty 를 Rust 에 미러, 가드 이벤트 수신, 종료 확정 ──
  setIdeDirty: (dirty) => invoke("set_ide_dirty", { dirty }),
  quitApp: () => invoke("quit_app"),
  onQuitGuard: (cb) => listen("cpt-quit-guard", (e) => cb(e.payload)),

  // ── 서버 동기화 알림(deviceToken 은 Rust 내부) ──
  notifList: (limit, beforeId) => invoke("notif_list", { limit: limit ?? 50, beforeId: beforeId ?? null }),
  notifCreate: (payload) => invoke("notif_create", { payload }),
  notifRead: (payload) => invoke("notif_read", { payload }),
  notifReadAll: () => invoke("notif_read_all"),
  // UI 실시간 채널(WS) 접속 URL — 티켓 발급 포함(완성된 ws URL 문자열).
  uiStreamUrl: () => invoke("ui_stream_url"),

  // ── 원격 PC 릴레이(back REST, deviceToken 은 Rust 내부) — /api/daemon/* 전용 ──
  backApi: (method, path, body, timeoutSecs) =>
    invoke("back_api", { method, path, body: body ?? null, timeoutSecs: timeoutSecs ?? null }),
  backBase: () => invoke("back_base"),

  // ── 작업 스냅샷(자동 체크포인트) — back sync 채널(데몬 오프라인이면 409) ──
  //  background: HTTP 는 즉시 accepted 응답(대형 번들은 분 단위 — 동기 대기는 CF 524).
  //  실제 작업·manifest 등록은 back-데몬 사이에서 계속 진행(RPC 600s).
  syncCheckpoint: (workspaceId, reason, cwd) =>
    invoke("back_api", {
      method: "POST", path: "/api/daemon/sync/checkpoint",
      body: { workspaceId, reason: reason || "periodic", background: true, ...(cwd ? { cwd } : {}) },
      timeoutSecs: 30,
    }),

  // ── 자동 실행(로그인 아이템) ──
  autostartEnabled: () => invoke("plugin:autostart|is_enabled"),
  autostartEnable: () => invoke("plugin:autostart|enable"),
  autostartDisable: () => invoke("plugin:autostart|disable"),

  // ── 이벤트 구독 ──
  onPtyData: (cb) => listen("pty://data", (e) => cb(e.payload)),
  onPtyExit: (cb) => listen("pty://exit", (e) => cb(e.payload)),
  onDaemonChanged: (cb) => listen("daemon-changed", () => cb()),
  onDeepLinkPair: (cb) => listen("deep-link-pair", (e) => cb(e.payload)),
};
