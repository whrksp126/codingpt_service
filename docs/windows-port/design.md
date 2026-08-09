# Windows 포팅 — 설계·계약 정본

> 목표: macOS 앱과 **완전 동일한 UI/UX·기능**의 Windows 버전. 축소 모델 금지.
> 유일한 제외: iOS 시뮬레이터(serve-sim) — Apple 제약으로 Windows 호스트에서 원리적 불가(기존 darwin+arm64 게이트 유지).
> 원칙: **macOS 경로는 무수정 보존**(회귀 0), Windows는 분기/신규 모듈로 추가. 이 문서의 계약을 어기는 구현 금지 — 계약 변경이 필요하면 이 문서를 먼저 수정.

## 워크스트림과 파일 소유권 (병렬 개발 충돌 방지)

| WS | 범위 | 소유 파일 |
|----|------|-----------|
| A | 세션 호스트(tmux 등가물) | `codingpt_daemon/packages/term-host/**`(신규), `packages/runner-core/term-backend*.js`(신규), `packages/runner-core/test/term-host*` |
| B1 | Rust 크로스플랫폼 스위프 | `codingpt_pc/src-tauri/src/{cptsock.rs,bridge.rs,lib.rs,fsapi.rs}`, `tauri.conf*.json`, `Cargo.toml` |
| B2 | Windows 프리뷰(punch-through) | `codingpt_pc/src-tauri/src/preview_win.rs`(신규), `preview.rs`(cfg 분기 추가만), `docs/windows-port/preview-win.md` |
| C | 프론트(입력층·바인딩·온보딩·창틀) | `codingpt_pc/src/**` (js/css/html) |
| D | 데몬 크로스플랫폼 스위프 + shim | `packages/runner-core/{agents,proxy,emulator,shim,statusline-relay,config,agent}.js`, `packages/cpt-cli/**`, `packages/daemon/**` |
| E | 빌드·CI·릴리스 | `.github/workflows/**`, `codingpt_pc/scripts/**`, `codingpt_service/scripts/**` |

pty.js / cpt-server.js / status-line.js / agent-watch.js / question-revive.js 의 tmux 호출부 재배선은 **A의 term-backend 완성 후 2차 웨이브**에서 A가 수행한다(1차에서는 아무도 수정 금지).

## 계약 1 — 세션 호스트 (`@codingpt/term-host`)

tmux 서버의 Windows 등가물. **별도 상주 프로세스**(데몬이 죽어도 터미널 생존).

- 프로세스: 데몬이 최초 필요 시 `spawn(node, [term-host entry], {detached:true, windowsHide:true})`. 단일 인스턴스 보장 = named pipe 서버 점유가 곧 락.
- 파이프: `\\.\pipe\cpt-termhost-<sha256(homedir) 앞 8자>` (테스트/macOS 개발 시 `<stateDir>/termhost.sock` 유닉스 소켓 폴백 — 프로토콜 로직은 플랫폼 중립으로 작성해 mac에서 유닛테스트).
- 세션 모델: 세션명 = 기존 tmux와 동일한 `cpt-<ws>--t-<tid>` 문자열을 그대로 사용(상위 계층 무수정을 위해). 세션 = ConPTY 1개(`node-pty` win32 prebuild) + 서버사이드 스크린 버퍼(`@xterm/headless` + serialize addon) + env맵 + title.
- 프로토콜: 접속당 1개 NDJSON 채널. 첫 줄 `{op, ...}`.
  - 단발 op: `create{name,cwd,env,cols,rows,shell}`, `list` → `[{name,title,panePid,createdAt}]`, `has{name}`, `kill{name}`, `killServer`, `sendKeys{name,data|keys[]}`(keys는 tmux 키 표기 `C-c`,`Enter`,`BSpace`,`S-Tab`,`Escape` 등을 호스트가 바이트로 변환), `capture{name,escapes,lines}` → SGR 포함/미포함 스크린 텍스트, `resize{name,cols,rows}`, `setEnv{name,k,v}`, `getEnv{name,k}`, `rename{name,title}`, `respawn{name}`.
  - 스트림 op: `attach{name}` → 이후 해당 커넥션은 양방향 스트림. 프레임 = NDJSON `{t:"o",d:<base64>}`(출력) / `{t:"i",d:<base64>}`(입력) / `{t:"r",cols,rows}`(리사이즈 요청) / `{t:"bell"}` 등.
  - 미러 = 다중 attach 전원에게 출력 브로드캐스트, 입력은 전원 허용, 리사이즈는 **latest wins**(tmux `window-size latest` 동일 의미론).
- 셸 선택(win32): `pwsh.exe` → `powershell.exe` → `cmd.exe` 순 탐색. 프로필 주입은 계약 4.
- 자동 rename: 포그라운드 프로세스명 기반, tmux `automatic-rename-format`과 동일 규칙(셸이름이면 디렉토리명, 아니면 명령이름).
- 내구성: 호스트는 클라이언트 0이어도 상주. `killServer`로만 종료. 크래시 대비 세션 메타를 `<stateDir>/termhost/sessions.json`에 저널링(복원은 respawn 정책).

`packages/runner-core/term-backend.js`(신규)가 유일한 진입점: darwin → 기존 `runTmux` 경로 위임, win32 → term-host 파이프 클라이언트. 시그니처는 위 op 목록과 1:1.

### 계약 1 — 웨이브 2 확정 사항 (2026-08-10)

- **재배선 완료**: pty.js/cpt-server.js/status-line.js/agent-watch.js/question-revive.js 의 tmux 호출은 전부 term-backend op 경유. darwin 구현은 `term-backend-tmux.js` — 종전 호출부와 같은 tmux 인자를 조립하고 실행은 `pty.runTmux`(저수준 단일 실행기, 테스트 몽키패치 지점) 경유. tmux 전용 유지보수(레거시 풀 마이그레이션·뷰 리퍼·zdot 자가치유·automatic-rename 옵션 주입)만 pty.js 에 남고 호스트 백엔드에선 no-op.
- **listSessionNames**(백엔드 op 추가): 모든 세션 이름 — darwin `list-sessions -F`, win32 는 list 의 이름 사상(컨텍스트 게이트 소비자).
- **win32 호스트 스폰 = WMI 1차**: PC 앱(Rust)이 데몬을 Job Object(KILL_ON_JOB_CLOSE)에 넣으므로 평범한 spawn 은 자식이 Job 에 상속돼 앱 종료 시 터미널이 죽는다. `powershell Invoke-CimMethod Win32_Process.Create`(생성 프로세스 = WmiPrvSE 자식 = Job 밖, ShowWindow=0)로 스폰하고, env(CPT_TERMHOST_SOCK/CODINGPT_STATE_DIR)는 `cmd /d /s /c "set … && node … run"` 체인으로 전달(WMI 는 부모 env 미상속). 실패 시 기존 detached 스폰 폴백(Job 상속 감수). 조립은 순수 함수 `_buildWmiSpawnSpec`(유닛테스트).
- **win32 파이프 정규화**: `CPT_TERMHOST_SOCK` 에 파이프 형식이 아닌 파일 경로가 오면 `\\.\pipe\cpt-termhost-test-<sha8(경로)>` 로 접는다(클라 term-backend·호스트 paths 동일 규칙 — win32 net.listen 은 파이프 외 경로 불가).
- **win32 기본 셸 = 프로필 내장(계약 4 연결)**: 세션 생성 주체가 둘(데몬 create·PC 앱 create op)이므로 PowerShell 프로필 주입(`pwsh -NoLogo -NoExit -Command ". <stateDir>\shim\ps\cpt-profile.ps1"`, cmd 폴백 `/K cpt-init.cmd`)은 term-host `session.defaultShellSpec()` **한 곳**의 기본값이다. create 가 shell/args 를 명시하면 그것이 우선, 프로필 파일 부재 시 민짜 셸(터미널은 항상 열린다). 저널은 args 포함(크래시 복원 후에도 프로필 유지).
- **win32 데몬 create env 최소셋**: `CPT_WS`·`CPT_SOCK`(계약 2 파이프)·`CPT_TID`/`CPT_TSESSION`(cpt CLI 좌표 — win32 는 tmux 자기조회가 없어 필수)·`PATH`(`<stateDir>\bin;` prepend). ZDOTDIR/CPT_TMUX 는 win32 제외 — PC 앱 create 규칙과 정합.
- **cpt CLI win32 위임**: CPT_WS env 유실 시 CPT_TSESSION 좌표로 term-host 파이프에 getEnv op 를 직접 물어 복원(darwin show-environment 폴백 등가).

## 계약 2 — cpt 컨트롤 플레인 파이프

- win32 경로: `\\.\pipe\codingpt-cpt-<sha256(homedir) 앞 8자>`. `CPT_SOCK` env에 이 문자열을 그대로 넣는다(기존 소비자들은 문자열을 `net.connect`/파일 open에 그대로 사용).
- Node 측: `net.createServer().listen(pipeName)` 그대로 동작. `existsSync/unlinkSync/chmodSync` 정리 로직은 win32에서 스킵(파이프는 자동 소멸). sockPath 로직 복제 3벌(`cpt-server.js`, `cpt-cli/bin/cpt.js`, `statusline-relay.js`)을 runner-core 단일 함수로 통합 후 재사용.
- Rust 측(`cptsock.rs`): win32는 `std::fs::OpenOptions::new().read(true).write(true).open(r"\\.\pipe\...")` 로 파일 핸들 통신(named pipe byte mode). 기존 read/write 코드 공유, 커넥션 열기만 분기.
- 승인 소켓(`agent.js` `cpt-approval-<pid>.sock`)도 동일 규칙: win32 → `\\.\pipe\cpt-approval-<pid>`.

## 계약 3 — Windows 프리뷰 (punch-through 완전 재현)

- 목표 동작 = macOS와 동일: 프리뷰 웹뷰가 앱 UI **아래** 레이어, 앱 웹뷰는 투명, 슬롯 rect 안 입력은 프리뷰로, shield 시 앱으로.
- 구현: `preview_win.rs` — WebView2 **CompositionController**(`CreateCoreWebView2CompositionController`, `webview2-com` crate) + DirectComposition 비주얼 트리를 메인 HWND에 구성. 앱 웹뷰(wry, windowed)는 `with_transparent` 배경.
- 입력 라우팅: wry 웹뷰의 입력 HWND(Chrome_WidgetWin 계열)를 `SetWindowSubclass`로 서브클래스 → 슬롯 rect 내 마우스/휠/포인터 메시지를 `SendMouseInput/SendPointerInput`으로 프리뷰에 전달하고 스왈로우. shield on이면 전달 중단. (macOS hitTest 스위즐의 등가물 — 커서 모양은 `SetCursor` 위임.)
- 기능 API 매핑: eval=`ExecuteScriptAsync`(반환값 회수), screenshot=`CapturePreviewAsync`(PNG→JPEG 재인코딩 동일 규칙), cookies=`CoreWebView2CookieManager`(httpOnly 포함), zoom=`ZoomFactor`+`SetVirtualHostNameToFolderMapping` 불요·CDP `Emulation.setDeviceMetricsOverride`(`CallDevToolsProtocolMethodAsync`) 사용 가능, devtools=`OpenDevToolsWindow`(chii 데브툴 경로는 그대로 크로스플랫폼), back/fwd/reload/URL/title/canGoBack = 전부 공식 API.
- Tauri 커맨드 시그니처는 preview.rs 기존 것과 완전 동일(프론트 무수정 원칙). `preview.rs`의 `#[cfg(target_os="macos")]` 본체는 무수정, 비-mac 폴백 자리를 `#[cfg(target_os="windows")] preview_win::…` 위임으로 교체.

## 계약 4 — 셸 shim (win32)

- 터미널 기본 셸 = PowerShell. 스폰: `pwsh -NoLogo -NoExit -Command ". '<stateDir>\shim\ps\cpt-profile.ps1'"`. `cpt-profile.ps1`은 ① 사용자 `$PROFILE` 존재 시 dot-source ② PATH prepend(`<stateDir>\bin`) ③ `claude`/`codex`/`cpt` **PowerShell 함수** 정의(zsh 함수의 등가물 — 원본 바이너리를 `Get-Command -Type Application`으로 재탐색해 래핑). 사용자 프로필 파일 무수정 원칙 유지.
- cmd.exe 선택 시: `cmd /K "<stateDir>\shim\cmd\cpt-init.cmd"`.
- 래퍼 실체: `<stateDir>\bin\{cpt.cmd, claude.cmd, codex.cmd, cpt-statusline.cmd}` (sh 래퍼의 등가물). claude 훅 주입은 동일하게 `--settings <claude-hooks.json>`, 훅 command 문자열은 `"<abs>\cpt.cmd" claude-hook <event>` — **claude CLI가 Windows에서 훅을 어느 셸로 실행하는지 실측 후 문법 확정**(D 담당, cmd/sh 양쪽 안전한 형태 권장).
- codex `~/.codex/hooks.json` 병합 명령의 sh 조건문은 win32에서 `cmd /c if defined CPT_SOCK (…) else (…)` 등가 또는 Node 원라이너(`node -e`)로 치환 — **Node 원라이너 권장**(셸 문법 의존 제거, 양 플랫폼 동일 코드).
- PATH 구분자는 전부 `path.delimiter`. 바이너리 탐색은 X_OK 대신 win32에서 `PATHEXT`(.exe/.cmd/.bat) 확장자 매칭. `spawn`/`execFile`로 `.cmd`를 실행할 땐 절대경로 + `{shell:false}` 불가 → `spawn(cmd.exe, ['/c', …])` 또는 `shell:true` 명시.

## 계약 5 — 프론트 입력층·키바인딩 (win32)

- 터미널 입력: win32에서는 pane.js의 WKWebView IME 우회 인터셉트를 **끄고 xterm 표준 키 경로** 사용(`attachCustomKeyEventHandler`가 앱 예약 조합만 false→앱으로, 나머지 true). Chromium(WebView2) IME는 표준 경로로 한글 정상.
- 키바인딩: `commands.js`에 플랫폼별 기본값 테이블 도입. win32 기본값은 터미널 제어문자와 충돌하지 않는 조합(팔레트 `Ctrl+Shift+P`, 분할 `Ctrl+Shift+D`, 사이드바 `Ctrl+Shift+B`, 검색 `Ctrl+Shift+F` 등 — Windows Terminal/VS Code 관용). 비-Apple에서 Ctrl을 Mod로 흡수하던 규칙 폐지: combo 저장 포맷에 `Ctrl` 명시 수식어 허용(기존 mac 저장값과 호환 유지). 표기는 기존 `formatCombo` 확장.
- 터미널 포커스 중 라우팅 규칙: 예약 조합(현재 바인딩 테이블에 등록된 것)만 앱, 나머지 Ctrl+*는 셸로. AltGr(ctrl+alt 동시)는 항상 문자 입력으로 통과.
- 창틀: win32는 `decorations:false` + DOM 우측 상단 min/max/close 버튼(신규 컴포넌트, 무채색·이모지 금지·기존 디자인 토큰) + `data-tauri-drag-region` 유지 + 더블클릭 최대화. 좌측 72px 트래픽라이트 여백은 CSS 변수화해 win32에서 0.
- 온보딩: TCC 폴더 권한·macOS 알림 슬라이드는 win32에서 스킵(단계 자체 미노출). 문구 분기(`"Mac에 로그인하면…"` 등).
- 경로 표시: `~` 표기 유지(내부 정규화는 홈-상대 그대로), 파일명/디렉토리 조작은 신규 `path-utils.js` 헬퍼(`/`·`\` 양쪽 인식)로 통일. `shq`는 win32에서 대상 셸별 인용으로 분기.

## 계약 6 — 빌드·CI·릴리스

- CI: `.github/workflows/windows-port.yml` — `windows-latest`에서 ① `cargo check`(src-tauri, `--target x86_64-pc-windows-msvc`) ② 데몬 `npm ci` + win32 실행 가능한 테스트(`node --test`, tmux 의존 테스트는 스킵 태그) ③ term-host 자체 테스트. push 트리거(브랜치 `windows-port`).
- 로컬(mac) 사전 검증: `rustup target add x86_64-pc-windows-msvc` 후 `cargo check --target …`(링크 없이 타입체크). JS는 플랫폼 중립 로직을 mac에서 `node --test`.
- 번들: `tauri.windows.conf.json` 오버레이(`bundle.targets: ["nsis"]`, webviewInstallMode=downloadBootstrapper). `bundle-sidecar.sh` win32 경로 완성(tmux 블록은 win32에서 term-host 동봉으로 대체 — term-host는 데몬 워크스페이스에 포함되므로 별도 바이너리 불요). `node-datachannel`/`node-pty`는 win32 prebuild 사용, **Windows 러너에서 `npm ci`한 node_modules로 번들**.
- latest.json: `_release-upload.cjs`에 **기존 매니페스트 읽어 platforms 병합** 로직 추가(타깃 인자화). 공개 다운로드 별칭 `common/downloads/CodingPT.exe`(no-store) + 버전 파일(immutable). 백엔드는 무수정(`${target}-${arch}` 키), `CodingPT.dmg` no-store 특례에 `.exe` 추가만.
- 서명: 코드서명 인증서 확보 전까지 CI는 미서명 아티팩트(테스트 전용). 릴리스 게이트에 서명 필수화는 인증서 확보 후.

## 검증 전략

1. mac에서: cargo check(win 타깃) + 플랫폼 중립 유닛테스트 통과.
2. GitHub Actions windows-latest: 컴파일 + 테스트 + NSIS 번들 산출.
3. 실기 Windows PC: 최종 브링업(프리뷰 입력 라우팅·IME·세션 내구성은 실기에서만 확정 가능).
   → **실기 검증 전에는 어떤 기능도 "완료" 선언 금지.**
