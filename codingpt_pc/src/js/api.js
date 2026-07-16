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
  deleteAccount: () => invoke("delete_account"),
  revokeDevice: (deviceId) => invoke("revoke_device", { deviceId }),
  // 로컬 워크스페이스를 이 기기(호스트)에 귀속(백필).
  claimWorkspace: (wsId) => invoke("claim_workspace", { wsId }),
  // 홈-상대 경로가 이 기기에 실재하는 디렉토리인지.
  pathExists: (rel) => invoke("path_exists", { rel }),
  // 웹 로그인 URL(프론트 /desktop-login?code=) — Rust 가 서버에서 프론트 주소 파생.
  desktopLoginUrl: (code) => invoke("desktop_login_url", { code }),
  // 워크스페이스 세션 상태(이어받기) — 열린 터미널/IDE/프리뷰 + 레이아웃.
  fetchWsSession: (wsId) => invoke("fetch_ws_session", { wsId }),
  saveWsSession: (wsId, session) => invoke("save_ws_session", { wsId, session }),
  createWorkspace: (absPath) => invoke("create_workspace", { absPath }),
  // 네이티브 폴더 피커(새 워크스페이스). 취소 시 null.
  pickFolder: async (defaultPath) => {
    const d = window.__TAURI__?.dialog;
    if (d?.open) return await d.open({ directory: true, multiple: false, defaultPath });
    return null;
  },

  // ── 로컬 터미널 pane (tmux) ──
  ptyOpen: (paneId, localPath, winIndex, cols, rows) =>
    invoke("pty_open", { paneId, localPath, winIndex, cols, rows }),
  ptyWrite: (paneId, data) => invoke("pty_write", { paneId, data }),
  ptyResize: (paneId, cols, rows) => invoke("pty_resize", { paneId, cols, rows }),
  ptyClose: (paneId) => invoke("pty_close", { paneId }),

  // ── tmux 제어(서피스/브랜치/포트) ──
  listWindows: (localPath) => invoke("tmux_list_windows", { localPath }),
  newWindow: (localPath, paneId) => invoke("tmux_new_window", { localPath, paneId: paneId || null }),
  killWindow: (localPath, index) => invoke("tmux_kill_window", { localPath, index }),
  viewWindow: (localPath, paneId, index) => invoke("tmux_view_window", { localPath, paneId, index }),
  unviewWindow: (localPath, paneId, index) => invoke("tmux_unview_window", { localPath, paneId, index }),
  gitBranch: (localPath) => invoke("tmux_git_branch", { localPath }),
  listenPorts: (localPath = "") => invoke("tmux_listen_ports", { localPath }),

  // ── 클라우드 터미널(relay) ──
  cloudTerminalStart: (cwd) => invoke("cloud_terminal_start", { cwd }),

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

  // ── 프리뷰(네이티브 임베디드 webview) ──
  previewSync: (paneId, url, x, y, w, h, visible) =>
    invoke("preview_sync", { paneId, url: url || "", x, y, w, h, visible }),
  previewNavigate: (paneId, url) => invoke("preview_navigate", { paneId, url }),
  previewControl: (paneId, action) => invoke("preview_control", { paneId, action }),
  previewInfo: (paneId) => invoke("preview_info", { paneId }),
  // 프리뷰 페이지 JS 평가(결과 회수) — 호출측이 JSON.stringify 문자열 반환을 보장할 것.
  previewEval: (paneId, js) => invoke("preview_eval", { pane: paneId, js }),
  // 프리뷰 보이는 영역 스크린샷 — JPEG base64 문자열.
  previewScreenshot: (paneId) => invoke("preview_screenshot", { pane: paneId }),
  onPreviewLoaded: (cb) => listen("preview-loaded", (e) => cb(e.payload)),
  previewClose: (paneId) => invoke("preview_close", { paneId }),

  // ── 네이티브 알림 ──
  notify: (title, body) => invoke("notify", { title, body: body || "" }),

  // ── 서버 동기화 알림(deviceToken 은 Rust 내부) ──
  notifList: (limit, beforeId) => invoke("notif_list", { limit: limit ?? 50, beforeId: beforeId ?? null }),
  notifCreate: (payload) => invoke("notif_create", { payload }),
  notifRead: (payload) => invoke("notif_read", { payload }),
  notifReadAll: () => invoke("notif_read_all"),
  // UI 실시간 채널(WS) 접속 URL — 티켓 발급 포함(완성된 ws URL 문자열).
  uiStreamUrl: () => invoke("ui_stream_url"),

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
