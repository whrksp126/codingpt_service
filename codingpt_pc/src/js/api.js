// api.js — Tauri IPC 래퍼. Rust 커맨드/이벤트를 한 곳에서 노출한다.
//  Tauri v2 는 JS camelCase 인자를 Rust snake_case 로 자동 매핑한다.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// GET 쿼리 조립 — null/undefined/'' 는 생략(back 이 기본값을 쓰게).
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === "") continue;
    p.set(k, String(v));
  }
  return p.toString();
}

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
  // 주소창 검색어 추천(Google Suggest, 네이티브 호출 — CORS 무관).
  previewSuggest: (q) => invoke("preview_suggest", { q }),
  // 계정의 모든 기기 목록(멀티기기 "내 기기"). 미로그인이면 null.
  fetchDevices: () => invoke("fetch_devices"),
  fetchUiClients: () => invoke("fetch_ui_clients"), // 지금 접속 중인 화면(원격 시청자 판정)
  updateNickname: (nickname) => invoke("update_nickname", { nickname }),
  updateAppearance: (appearance) => invoke("update_appearance", { appearance }),
  deleteAccount: () => invoke("delete_account"),
  revokeDevice: (deviceId) => invoke("revoke_device", { deviceId }),
  renameOwnDevice: (deviceId, name) => invoke("back_api", {
    method: "PATCH", path: `/api/daemon/devices/${encodeURIComponent(deviceId)}/name`,
    body: { name }, timeoutSecs: 12,
  }),
  // 로컬 워크스페이스를 이 기기(호스트)에 귀속(백필).
  claimWorkspace: (wsId) => invoke("claim_workspace", { wsId }),
  // 워크스페이스 삭제 — 서버 목록 메타만(로컬 폴더/파일은 유지).
  wsDelete: (wsId) => invoke("ws_delete", { wsId }),
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
  // 드롭 파일 미리보기(채팅 첨부 썸네일) — 절대경로 base64. 8MB 초과/비파일이면 reject.
  filePreviewB64: (path) => invoke("file_preview_b64", { path }),
  fsAbs: (rel) => invoke("fs_abs", { rel }), // 홈-상대 → 절대경로(파일트리→터미널 삽입용)
  fsWrite: (rel, content) => invoke("fs_write", { rel, content }),
  // base64 바이너리 저장(Design Mode 크롭샷 등) — 부모 mkdir 포함, 절대경로 문자열 반환.
  fsWriteB64: (rel, b64) => invoke("fs_write_b64", { rel, b64 }),
  fsMkdir: (rel) => invoke("fs_mkdir", { rel }),
  fsCreateFile: (rel) => invoke("fs_create_file", { rel }),
  fsRename: (rel, dest) => invoke("fs_rename", { rel, dest }),
  fsDelete: (rel) => invoke("fs_delete", { rel }),

  // ── UI 레이아웃 영속화 ──
  uiLoad: () => invoke("ui_state_load"),
  uiSave: (state) => invoke("ui_state_save", { state }),

  // ── 외부 브라우저 열기 ──
  openExternal: (url) => invoke("open_external", { url }),
  openPath: (path) => invoke("open_path", { path }),
  clipboardPaths: () => invoke("clipboard_paths"),
  clipboardImagePng: () => invoke("clipboard_image_png"),
  openPrivacySettings: () => invoke("open_privacy_settings"), // macOS 전체 디스크 접근 설정(온보딩)
  notifPermission: () => invoke("notification_permission"), // 알림 권한 요청(온보딩) → granted 여부
  notifPermissionState: () => invoke("notification_permission_state"), // 요청 없이 현재 OS 권한만 조회
  openNotificationSettings: () => invoke("open_notification_settings"), // macOS CodingPT 알림 설정
  probeFolder: (folder) => invoke("probe_folder_access", { folder }), // downloads|desktop|documents → 허용 여부(최초엔 macOS 팝업)
  openFilesPrivacy: () => invoke("open_files_privacy_settings"), // '파일 및 폴더' 설정(거부 복구용)

  // ── 프리뷰(네이티브 임베디드 webview) ──
  previewSync: (paneId, url, x, y, w, h, visible) =>
    invoke("preview_sync", { paneId, url: url || "", x, y, w, h, visible }),
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
  // 데브툴 디바이스 툴바 — 페이지 줌(WKWebView pageZoom). 1=복원.
  previewZoom: (paneId, zoom) => invoke("preview_zoom", { pane: paneId, zoom }),

  // ── 네이티브 알림 ──
  notify: (title, body, sound = "default") => invoke("notify", { title, body: body || "", sound }),

  // ── punch-through(프리뷰=앱 UI 아래층) ──
  previewShield: (on) => invoke("preview_shield", { on: !!on }), // DOM 오버레이 동안 프리뷰 이벤트 차단
  windowSetBg: (hex) => invoke("window_set_bg", { hex }), // 창 배경 = 테마 base(투명 누수 영역 커버)

  // ── 자동 업데이트(번들 앱 전용 — tauri dev 에선 updateCheck 가 error 반환) ──
  appVersion: () => invoke("app_version"),
  updateCheck: () => invoke("update_check"),
  updateDownload: () => invoke("update_download"), // 받아만 둔다(설치 X) — 적용은 조용한 순간에
  updateStaged: () => invoke("update_staged"), // 준비된 버전(없으면 null)
  updateInstall: () => invoke("update_install"), // 준비돼 있으면 즉시 설치+재시작
  consumeInstallOnboardingReset: () => invoke("consume_install_onboarding_reset"),
  onUpdateProgress: (cb) => listen("cpt-update-progress", (e) => cb(e.payload)),
  onOpenSettings: (cb) => listen("cpt-open-settings", () => cb()),
  onCheckUpdate: (cb) => listen("cpt-check-update", () => cb()),

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

  // ── 원격 프리뷰 로컬 포트 포워더 — 사이드카 데몬(cpt.sock)에 리스너 기동/정리 지시 ──
  //  결과 { ok:true } | { ok:false, error:'EADDRINUSE'… } (실패는 프록시 폴백 신호).
  // upstream(옵셔널) = LAN 직결 좌표(lan.js upstreamFor). 항상 token 도 함께 넘긴다(릴레이=폴백 전제).
  forwardStart: (port, token, upstream) => invoke("forward_start", { port, token, upstream: upstream ?? null }),
  forwardStop: (port) => invoke("forward_stop", { port }),
  // LAN 직결(기능4) — 사이드카 데몬 위임. 구 데몬/미지원이면 reject → 호출측이 조용히 릴레이 폴백.
  lanProbe: (hostDeviceId) => invoke("lan_probe", { hostDeviceId }),
  lanStatus: (hostDeviceId) => invoke("lan_status", { hostDeviceId }),
  lanRpc: (hostDeviceId, method, params) => invoke("lan_rpc", { hostDeviceId, method, params: params || {} }),

  // ── 종단간 암호화(기능2) — 사이드카 데몬 위임(cpt.sock, `e2ee.` 접두사만 Rust 가 통과) ──
  //  ★ 마스터키는 데몬의 ~/.codingpt/e2ee.json 에만 있다. PC UI JS 는 MK 를 보지 않고
  //    "봉인해서 보내줘/열어줘"만 지시한다(deviceToken 을 JS 에 노출하지 않는 것과 같은 원칙).
  e2eeLocal: (cmd, args) => invoke("e2ee_local", { cmd, args: args || {} }),

  // ── 에이전트 관리(이 PC 의 AI CLI) — 사이드카 데몬 위임(`agents.` 접두사만 Rust 가 통과) ──
  //  agents.list {refresh}  → { agents:[…], onboardedAt }
  //  agents.wire {id,on}    → 배선 토글 + shim 즉시 재생성(claude/codex 만)
  //  agents.rescan {markOnboarded} → 재감지 + shim 재생성(설치 시트 3단계가 부르는 것)
  //  agents.launch {cwd,index,id}  → 그 터미널에 명령을 타이핑(셸 준비 대기는 데몬이 판정)
  agentsLocal: (cmd, args) => invoke("agents_local", { cmd, args: args || {} }),

  // ── 에이전트 모드 즉시 확인 — 이 PC 의 터미널은 로컬 tmux 직결이라 shift+tab 이 데몬 입력 경로를
  //  지나가지 않는다. 그 키를 보낼 때 이걸 불러 주면 데몬이 그 터미널을 즉시 다시 읽어 이 PC 와
  //  폰의 모드 알약이 함께 갱신된다(폴링 3초 대기 없음). 실패는 무시해도 안전(폴링이 안전망).
  modePoke: (cwd, tid) => invoke("mode_poke", { cwd, tid }),
  // 채팅 조회/모드 **로컬 직결**(이 PC 터미널 전용) — back 왕복 150~285ms → 1~2ms(실측 2026-08-02).
  //  허용 명령: chat.open · chat.since · chat.mode. 원격 PC 터미널은 이 경로를 쓰면 안 된다
  //  (그 PC 의 데몬이어야 한다) → 호출측이 isLocal 로 가른다.
  chatLocal: (cmd, args) => invoke("chat_local", { cmd, args: args || {} }),

  // ── 로컬 UI 채널(cpt.sock 지속 연결) — 터미널의 cpt 명령이 back 을 왕복하지 않고 바로 이 앱에 온다 ──
  //  uiLocalStart: 멱등(args 갱신만) · onLocalUiCommand: 데몬 push 수신 · uiLocalSend: ui_result/presence 회신.
  uiLocalStart: (args) => invoke("ui_local_start", { args: args || {} }),
  uiLocalSend: (frame) => invoke("ui_local_send", { frame }),
  onLocalUiCommand: (cb) => listen("cpt-local-ui", (e) => cb(e.payload)),

  // ── 원격 승인 인박스(기능1) — back REST. 새 배관 없음: back_api(/api/daemon/*) 를 그대로 쓴다 ──
  //  · GET  /approvals            대기 목록(push 는 힌트, pull 이 정본 — 부팅/재접속마다 재조회)
  //  · POST /approvals/:id/respond { decision:'allow'|'deny'|'answer', answer?, message? }
  //  실패 문자열은 Rust back_api 가 `HTTP <code> <CODE>: <메시지>` 로 만들어 준다(detail.code 보존).
  approvalList: () => invoke("back_api", { method: "GET", path: "/api/daemon/approvals", body: null, timeoutSecs: 12 }),
  approvalRespond: (id, body) =>
    invoke("back_api", {
      method: "POST",
      path: `/api/daemon/approvals/${encodeURIComponent(id)}/respond`,
      body: body || {},
      timeoutSecs: 20,
    }),

  // ── 트랜스크립트 채팅(기능5) — 데몬 JSONL 리더 RPC 의 back 프록시 ──
  //  hostDeviceId 를 실으면 그 PC 로 라우팅(멀티 PC). 미지정이면 활성 러너.
  //  라이브 델타는 여기가 아니라 ui-channel WS 의 chat_event(팬아웃) 로 온다. 캐치업은 chatSince pull.
  // 후보 대화 목록 — `chat.open` 이 `noSession:'ambiguous'`(바인딩 없음 + 후보 2개 이상)를 줄 때
  //  사용자가 직접 고르는 경로. 어느 대화인지 단정할 수 없으면 **남의 대화를 보여주지 않는다**가 계약.
  chatSessions: (q) =>
    invoke("back_api", { method: "GET", path: "/api/daemon/chat/sessions?" + qs(q), body: null, timeoutSecs: 25 }),
  chatOpen: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/open", body: body || {}, timeoutSecs: 30 }),
  chatSince: (q) =>
    invoke("back_api", { method: "GET", path: "/api/daemon/chat/since?" + qs(q), body: null, timeoutSecs: 25 }),
  chatClose: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/close", body: body || {}, timeoutSecs: 10 }),
  chatDetail: (q) =>
    invoke("back_api", { method: "GET", path: "/api/daemon/chat/detail?" + qs(q), body: null, timeoutSecs: 20 }),
  chatAttachment: (q) =>
    invoke("back_api", { method: "GET", path: "/api/daemon/chat/attachment?" + qs(q), body: null, timeoutSecs: 25 }),
  // 채팅 전송 — 데몬이 그 터미널 세션에 bracketed paste + (지연) Enter 로 넣는다(새 세션/attach 금지).
  chatInput: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/input", body: body || {}, timeoutSecs: 20 }),
  // TUI 로 폴백된 질문에 원격 답변 — 데몬이 다이얼로그를 키 조작(직렬 + 화면 폴링이라 여유 타임아웃).
  chatAnswer: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/answer", body: body || {}, timeoutSecs: 35 }),
  // 에이전트 권한 모드 조회/전환 — 데몬이 TUI 를 shift+tab 으로 순환시키고 화면으로 검증한다.
  //  mode 를 빼면 현재 모드만 읽는다. 한 바퀴(최대 5회) 드라이브가 직렬이라 여유 타임아웃.
  chatMode: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/mode", body: body || {}, timeoutSecs: 25 }),
  // 대화가 참조한 파일 바이트(이미지/영상 인라인) — 권한 판정은 데몬(그 대화에 적힌 경로만).
  chatFile: (body) => invoke("back_api", { method: "POST", path: "/api/daemon/chat/file", body: body || {}, timeoutSecs: 40 }),

  // ── 작업 스냅샷(자동 체크포인트) ──
  //  1순위 = 사이드카 데몬 직결(cpt.sock). 같은 머신에서 나는 트리거인데 back → 제어 WS → 이 머신의
  //   데몬으로 되돌아오던 왕복을 없앤다(데몬이 back REST begin/commit 을 직접 호출).
  //  폴백 = 기존 back sync 채널. **반드시 남긴다**: ① back 이 아직 begin/commit 미배포 ② 개발 중
  //   스테일 사이드카 데몬(PC CLAUDE.md 경고) ③ 데몬 미기동. 어느 쪽이든 조용히 기존 경로로.
  //  background: HTTP 는 즉시 accepted 응답(대형 번들은 분 단위 — 동기 대기는 CF 524).
  syncCheckpoint: async (workspaceId, reason, cwd) => {
    try {
      return await invoke("sync_checkpoint", { wsId: workspaceId, reason: reason || "periodic", cwd: cwd || null });
    } catch (_) {
      return await invoke("back_api", {
        method: "POST", path: "/api/daemon/sync/checkpoint",
        body: { workspaceId, reason: reason || "periodic", background: true, ...(cwd ? { cwd } : {}) },
        timeoutSecs: 30,
      });
    }
  },

  // ── 자동 실행(로그인 아이템) ──
  autostartEnabled: () => invoke("plugin:autostart|is_enabled"),
  autostartEnable: () => invoke("plugin:autostart|enable"),
  autostartDisable: () => invoke("plugin:autostart|disable"),

  // ── 이벤트 구독 ──
  onPtyData: (cb) => listen("pty://data", (e) => cb(e.payload)),
  onPtyExit: (cb) => listen("pty://exit", (e) => cb(e.payload)),
  onDaemonChanged: (cb) => listen("daemon-changed", () => cb()),
  onDeepLinkPair: (cb) => listen("deep-link-pair", (e) => cb(e.payload)),
  // OS 파일 드래그앤드랍(Rust on_window_event 포워딩) — { kind:enter|over|drop|leave, paths?, x?, y?(물리 px) }
  onOsDrag: (cb) => listen("cpt-drag", (e) => cb(e.payload)),
};
