# BYO-PC — 현재 구현 상태 (as-built)

> 이 문서는 **"지금 실제로 만들어져 동작하는 것"**을 정리한 핸드오프 문서다(로드맵 아님).
> 원래 설계 정본은 [`byo-pc-design.md`](./byo-pc-design.md)(2026-07 초기 설계 — 와이어 기초·ToS 경계).
> 영역별 상세 정본은 §4 "핵심 파일" 옆에 적은 설계 문서를 본다.
> 최종 갱신: 2026-09-29.

**현재 버전(2026-09-29)**: PC 앱 **0.1.369**(데몬 사이드카 포함) · Android **0.4.17** 게시 / 0.4.18(87) 심사 중 ·
iOS **0.4.4** 게시 / 0.4.5 핫픽스 심사 대기 / 0.4.6(build 50) 제출 대기 · back/front 는 버전 없음(항상 main HEAD 배포).

---

## 1. 개념 / 하드 경계

"내 PC 여러 대 ↔ 모바일/태블릿" 원격 바이브코딩. 사용자 PC 에 데몬(PC 앱 사이드카)을 두고, 폰·태블릿·다른 PC 가
그 PC 의 **터미널 / 파일(IDE) / dev 서버 프리뷰 / 에뮬레이터 / 에이전트 PC(VM)** 를 조작한다.

- **BYO(Bring Your Own)**: AI 는 **사용자 PC 에서, 사용자 자신의 CLI(claude·codex·gemini 등)·구독으로** 실행된다.
  우리 서버는 결과 바이트만 릴레이한다. 우리 키로 AI 를 구동하지 않는다(클라우드 AI 엔진은 M0 에서 철거).
- **자격증명 경계(절대 규칙)**: 데몬·PC 앱에 AI 자격증명(Keychain·`~/.claude` OAuth·구독 토큰)을
  **읽거나 옮기거나 우리 인프라로 보내는 코드가 존재해서는 안 된다.** 허용되는 것은 대화 로그 읽기
  (`~/.claude/projects/*.jsonl`, codex rollout — 채팅 미러·세션 동기화용)와, 에이전트 CLI 실행 시
  `--settings` 등으로 **우리 훅을 주입**하는 것뿐.
- **개인 설정 무수정 원칙**: 사용자의 `~/.claude/settings.json` 등은 고치지 않는다. 훅은 PATH shim 이 실행 인자로 주입.
  예외 두 가지만 있다 — codex `hooks.json` 비파괴 병합(자기-스코핑·가드형), `~/.claude/skills` 에 cpt 스킬 스텁 **추가**(opt-out `CPT_SKILL_INSTALL=0`).
- **제품명 규칙**: 우리 UI 에 벤더 제품명("Claude Code" 등)을 쓰지 않는다. 에이전트 표시 이름은 **Claude · Codex · Gemini** 처럼 모델/회사 이름만.
- **인바운드 포트 0**: 데몬은 아웃바운드 WSS 만 연다. 유일한 예외가 LAN 직결(사설 IP 에만 바인드, 서버 스위치로 기본 꺼짐).
- **tmux 격리**: tmux 는 항상 전용 소켓 `-L codingpt`, 타겟은 `=` 정확 일치. 사용자 개인 tmux 서버는 절대 건드리지 않는다.
- 클라우드 러너·과금·레슨은 게이팅 OFF/레거시(§6).

## 2. 아키텍처

```
 폰/태블릿 앱(RN) ─┐                                          ┌─ PC 앱(Tauri) ── 데몬 사이드카(Node, runner-core)
 다른 PC 앱 ───────┼─WSS/HTTPS─► CF ► nginx ► back(릴레이 허브) ◄┤      │   tmux -L codingpt (번들)
 웹(front) ───────┘                 · daemonRelayService       └─ 제어 WS 1개 + dial-back 스트림(스트림당 WS 1개)
                                    · caps 협상 / 팬아웃 / FCM          · cpt.sock(유닉스 소켓) ← cpt CLI·훅·PC UI
          같은 Wi-Fi 이면 ─────────── LAN 직결(tcp/rpc/pty/emu scope) ──────────►
          에뮬/에이전트 PC 영상 ─────── WebRTC(P2P, 안 되면 TURN) ──────────────►
```

- **back = 릴레이 허브**(`services/daemonRelayService.js`, back 프로세스 내장·인메모리). 데몬 제어 WS
  `/api/daemon/connect`, dial-back 스트림 `/api/daemon/stream/:token`(kind `pty`|`tcp`|…), UI 클라이언트 WSS 팬아웃
  (알림·승인·채팅·`ui_command`·`runner_status`). WS 업그레이드는 `app.js` 단일 핸들러.
- **capability 협상**: 게이팅 = 데몬 caps ∩ `SERVER_CAPS`(`config/caps.js`) ∩ 기기 caps. 버전 문자열은 표시용.
  현재 서버 능력: `caps.v1 approval.v1 transcript.v1 agentstate.v1 e2ee.keys.v1 e2ee.rpc.v1 e2ee.hint.v1 e2ee.snap.v1 e2ee.stream.v1 task.v1 lan.v1`
  (각각 env 킬스위치로 회수 가능 — `APPROVAL_ENABLED`·`TRANSCRIPT_ENABLED`·`E2EE_ENABLED`·`TASKS_ENABLED`·`LAN_DIRECT_ENABLED`).
  클라이언트는 `ui_hello.uiCmds` 로 실행 가능한 명령을 신고하고 서버는 그 기기에만 `ui_command` 를 보낸다(미신고=모름=가능).
- **E2EE**: 계정 마스터키를 기기 승인(안전코드 대조)으로 배포, RPC·스트림·스냅샷을 봉투로 봉인. 경로는
  `POST /api/daemon/rpc`(봉인 RPC, **서버는 봉투를 열지 않음**) 우선 + REST 평문 폴백. 열쇠 없는 PC 는
  호스트별 배지로 "평문" 을 정직하게 표시. 데몬은 계정 신뢰기점을 자동 생성하지 않는다.
- **LAN 직결**: 같은 사설망이면 폰↔PC 직접(`runner-core/lan.js`·`lan-local.js`, back `lanDirectService.js`).
  서버가 grant 에 scope(`tcp` 프리뷰 / `rpc` / `pty` / `emu` 에뮬 영상·조작)를 실어 단계 개방. 릴레이는 영구 폴백.
- **터미널 = 전용 tmux 세션**: 터미널 1개 = 세션 `cpt-<ws>--t-<tid>`(tid 는 랜덤 31비트 정수, 와이어의 `win` 자리).
  세션 부재 = 닫힘. 스테일 뷰 세션 리퍼는 `--t-\d+$` 불가침.
- **터미널 v3(CPT3, 소유자 1명 모델)**: 데몬이 tmux **control mode**(`tmux -C`)로 화면 정본을 들고(`terminal-host.js`
  데몬 VT == tmux 화면), 클라이언트는 스냅샷+seq 출력 스트림을 받는 뷰어. **크기 소유자는 1명**(`@cpt_owner`,
  `resize-window` 로 고정), 비소유자는 축소 표시 + "이 기기로 조작" 으로 소유권을 가져온다. 입력은 `send-keys -H`.
  PC 로컬 뷰어도 v3(데몬 `terminal-local.js` 127.0.0.1 루프백). v1/v2 코드는 2026-09-06 삭제.
- **재부팅 복원**: tmux 서버는 OS 재부팅을 못 넘긴다 → 데몬 매니페스트 `~/.codingpt/terminals.json`
  (`terminal-manifest.js`)이 살아 있던 터미널(tid·cwd·이름)을 기록하고, 기동 시 서버가 없으면 **같은 tid** 로 되살린다.
  사용자가 닫은 건 안 살아난다. 터미널 0개는 EXIT 프레임 `{reason:'no_terminal'}`.
- **공유 표면(surfaces)**: 터미널 외 pane(프리뷰·IDE·에뮬·에이전트 PC)도 모든 기기가 공유(2026-09-20).
  데몬 `surfaces.js`(`~/.codingpt/surfaces.json`, `surface.*` RPC, 변경 통지 `pool.changed`). 속성은 열 때 한 번만 넘기고 탐색은 기기별 독립.
- **PC 앱(Tauri)**: 데몬을 Node 사이드카로 번들(node·node-pty·tmux·dylib 자립, 사용자 설치물 불필요) + Lume(에이전트 PC).
  Developer ID 서명·공증 .dmg, 트레이·딥링크·자동시작. 데몬 버전 = PC 앱 버전.
- **모바일 앱(React Native)**: PC 와 같은 워크스페이스 셸(사이드바·타일링 pane·터미널 WebView·IDE·프리뷰·에뮬·채팅).
  뒤처지는 구성요소는 사실상 모바일 하나(스토어 심사) → caps 로 기능을 게이팅한다.
- **cpt 컨트롤 플레인**: 터미널 안 에이전트가 `cpt` CLI → `~/.codingpt/cpt.sock`(NDJSON) → 데몬 → (필요시) back
  `ui_command` 로 **활성 기기**의 UI 를 조작. 훅 수신(`cpt claude-hook` 등)도 같은 소켓.

## 3. 구현된 기능

### 3.1 터미널
| 기능 | 내용 |
|---|---|
| 다기기 공유 터미널 | 같은 tmux 세션을 PC·폰·태블릿이 동시에 본다(v3 소유자 모델, 스냅샷+seq 이어받기) |
| 탭 전환 | 스트림 유지한 채 `terminal.select` → `pty-v3.swapTo()`(스냅샷이 새 출력보다 먼저) |
| 스크롤백 | 스냅샷 ANSI 가 스크롤백을 통째로 담는 "라이브 버퍼 하나"(과거 오버레이 폐기) |
| 재시작/재부팅 | 앱·데몬 재시작은 tmux 가 별도 프로세스라 작업 유지. OS 재부팅은 매니페스트로 같은 tid 복원 |
| 모바일 입력 | 실물 키보드 특수키 패널, TUI 스와이프 스크롤(SGR 휠), IME 입력 |
| PC 입력 | 한글 IME input 델타, OS 파일 드롭, 클립보드 파일/이미지 ⌘V, ⌘F 검색, ⌘P 팔레트, 단축키 재바인딩 |

### 3.2 워크스페이스 / 멀티 PC
| 기능 | 내용 |
|---|---|
| 워크스페이스 메타 | objectstore `project.json`(DB 아님). compute `local`/`cloud`, 호스트별 사본, projectId 그룹핑(remote 정규화) |
| 멀티 PC | 한 계정에 여러 PC. 사이드바 `내 PC` 아래 PC 별 그룹, 오프라인 호스트 UX, 사본별 git 신선도 배지(`freshness.js` 60s) |
| 폴더 피커 | 3플랫폼 Finder 컬럼뷰식 원격 `fs.list`, 다중 PC 선택 시트. 위치는 항상 사용자가 고른다(권장 루트 개념 폐지) |
| 레이아웃 | 타일링 pane(분할/병합/혼합 탭), PC 레이아웃 `~/.codingpt/pc-ui.json`, 표면은 데몬 `surfaces.json` 공유 |
| 동기화 엔진 | `sync.js` — objectstore git-bundle 허브 shadow 체크포인트/복원/3-way 충돌. PC 자동 체크포인트 존재. **스냅샷 UI 는 MVP 에서 숨김** |

### 3.3 IDE / 리뷰
| 기능 | 내용 |
|---|---|
| 원격 IDE | fs RPC(list/tree/read/write/watch/grep, 홈 jail+realpath), 자동저장, 에이전트가 고친 파일 라이브 반영 |
| diff 보기 | `cpt ide diff` / 에이전트가 파일·줄로 IDE 열기(`cpt ide open --line`) |
| 코드 리뷰 | `cpt review` — 화면이 리뷰 모드로, 덩어리별 승인/거절+코멘트 → 결과가 에이전트 stdout 으로(`review.js`, 세션은 데몬 보관) |

### 3.4 프리뷰
| 기능 | 내용 |
|---|---|
| 포트 포워딩(기본) | 원격 기기에 로컬 리스너 → `POST /api/daemon/forward/start` + TCP 연결당 WS → 데몬 tcp 스트림. 페이지 오리진이 진짜 `http://localhost:<port>` |
| 경로형 프록시(폴백) | `/preview/:token` 불투명 랜덤 토큰 + loopback 터널(SSRF 방지). 외부 브라우저 열기용 |
| 포트 감지 | `net.ports`(lsof) 감지 포트 사전 포워딩 |
| 브라우저 기능 | PC 네이티브 WKWebView 프리뷰, 주소창 기록/추천, chii 데브툴, Design Mode(요소 선택→소스), `cpt browser`/`cpt preview` 자동화 |

### 3.5 에뮬레이터 (PC 에 붙은 기기)
| 기능 | 내용 |
|---|---|
| Android | scrcpy 서버(H.264 + 컨트롤 소켓, `scrcpy-session.js`) → 릴레이/LAN/WebRTC 로 폰·PC 에 라이브 화면·터치 |
| iOS 시뮬레이터 | serve-sim(Swift 프레임버퍼 H.264 + WS HID, `serve-sim-session.js`). idb 아님 |
| 전송 | GOP 보관 재생(검은 화면 방지), 배압, LAN 직결(같은 Wi-Fi), WebRTC(외부망, TURN 폴백) |
| 조작 | 회전·하드웨어 버튼, 에이전트용 `cpt emulator` — 접근성 트리(ax)·라벨로 탭(tap-label)·text·screenshot |

### 3.6 에이전트 PC (게스트 VM 데스크톱)
| 기능 | 내용 |
|---|---|
| 개념 | 에이전트가 GUI 를 써도 사용자 화면·마우스를 방해하지 않도록 **이 맥 안 게스트 VM** 을 에이전트 전용 데스크톱으로. 에이전트 자신은 호스트 tmux 에서 돌고 `cpt desktop` 으로 조작 |
| VM | Lume 0.5.3 동봉(virtualization entitlement 만 남겨 재서명). **macOS 게스트** + **Linux 게스트(Ubuntu 24.04 + XFCE, cloud-init CIDATA seed, ~5GB)** — 사용자 선택, **동시 실행 가능** |
| 화면 | RFB(VNC) 클라(`desktop-rfb.js`) → JPEG/H.264(`native/vt-h264.swift`) → 에뮬레이터 배관 재사용. 폰·PC 에서 `desktop:macos`/`desktop:linux` 기기로 표시 |
| 조작 | `cpt desktop --os macos|linux status|start|stop|open|run|screenshot|click|type|key|ax|tap|handoff|pause|resume|path|connect`. AX 트리 = macOS JXA / Linux AT-SPI(`desktop-atspi.py`) 동일 JSON 형식 |
| 폴더 공유 | 워크스페이스 폴더를 VirtioFS 로 연결(`~/.codingpt/desktop.json` sharedDirs) |

### 3.7 에이전트 연동
| 기능 | 내용 |
|---|---|
| 에이전트 카탈로그 | `agents.js` — claude·codex·gemini·cursor-agent·opencode 감지/배선 등급 표시. 없는 CLI 는 감싸지 않음 |
| 훅 주입 | PATH shim(`~/.codingpt/bin`)이 claude 에 `--settings` 로 훅 주입, codex 는 `hooks.json` 병합. 훅 → `cpt` → cpt.sock → 데몬 |
| 상태 감지 | 훅 기반 working/needsInput/idle(`agent-state.js`) + 훅 없는 에이전트는 process-exit 폴백(`agent-watch.js`). 에이전트 판정은 프로세스 이름이 아니라 화면 제목 글리프 |
| 원격 승인 | claude/codex `PermissionRequest` 훅 → `approval.v1` 인박스 → PC·폰 카드 + 푸시. 선택지는 TUI 와 같은 번호·순서, "항상 허용" 은 `updatedPermissions` 로 실제 기록, 코멘트 입력은 화면에 어포던스가 있을 때만 |
| TUI 폴백 화해 | 훅이 끊긴 뒤 TUI 에만 남은 질문/권한 다이얼로그를 화면 파싱으로 카드 복원(`question-revive.js`) |
| 채팅 | 채팅 = TUI 의 미러. claude jsonl / codex rollout 트랜스크립트 어댑터(`transcript.js`), GFM 표·도구행 접기, 컴포저=로컬 contenteditable+원자 칩, 이미지·파일 첨부(TUI `[Image #N]` 동기화), 슬래시 팔레트, 모드 알약(shift+tab 대행) |
| 상태줄 | claude statusLine stdin JSON / codex rollout `token_count` 공식 채널로 컨텍스트%·모델·레이트리밋 표시(`status-line.js`, 사용자 statusline 스크립트 체인) |
| cpt 스킬 | `~/.claude/skills`·`.agents/skills` 에 스텁 설치 → 에이전트가 `cpt` 를 스스로 사용. 워크스페이스 밖(OUT_OF_CONTEXT)에서는 무동작 |

### 3.8 에이전트 작업 (2026-09-29, PC 0.1.368~0.1.369)
| 기능 | 내용 |
|---|---|
| 작업(Task) | 워크스페이스 저장소의 **worktree+브랜치 복사본**(`~/.codingpt/worktrees`)에서 에이전트 실행 → diff → 머지/폐기. 데몬 `tasks.js`·`task-git.js`, 스토어 `tasks.json` |
| fan-out | 같은 지시를 여러 에이전트/실행 ×N 으로 병렬, 비교 후 하나 채택. 나머지 실행 자동 폐기 + 30일 복구 ref |
| git/PR | `gh` CLI 로 PR(서버 토큰 0). 원격이 없으면 로컬 머지(커밋 메시지 입력). 머지 후 자동 정리 |
| 폴더 신뢰 | claude/codex 신뢰 화면을 카드 1탭으로 대행(개인 설정 무수정) |
| 진행 현황 | 상태별 현황판 = **PC 안의 장소**(`내 PC` 아래 PC 머리 밑 한 줄, 그 PC 범위). 다른 PC 입력대기는 PC 행 배지. 폰도 WorkspaceView 형제 층 |
| 사이드바 트리 | 워크스페이스 그룹 ▸ "로컬 · 브랜치" + 열린 작업(fan-out 펼침) |
| 전송 | 봉인 RPC 우선 + back `POST /api/daemon/task` 평문 폴백(`TASK_RPC_OK` 허용 표). 정본 `codingpt_daemon/docs/agent-tasks-design.md`, `agent-tasks-sidebar.md` |

### 3.9 알림
| 기능 | 내용 |
|---|---|
| 자동 알림 | 에이전트 응답 종료/입력 대기 훅 → back `notificationService` → WSS 팬아웃 → 미접속 기기 FCM(Firebase codingpt-65f11, iOS/Android) |
| present-device 라우팅 | 소리 낼 기기 = 실제 포커스된 기기(PC 는 NSWindow key 기준). "PC 사용 중일 땐 이 폰 무음" 토글(`push_device.alert_when_pc_active`) |
| 크로스기기 정리 | pane 단위 읽음(cwd,win), FCM tag 로 다른 기기 배너 회수, 알림 테두리 링 |

### 3.10 인증 / 보안
| 기능 | 내용 |
|---|---|
| 로그인 | Google, Apple(JWKS crypto 직접 검증), 이메일(가입/로그인 — 앱은 웹으로 넘겨 `codingpt://email-auth?code=` 핸드오프), PC 웹로그인 |
| 기기 페어링 | 기기 연동 코드 방식, deviceToken(`cptd_`, 클라우드 러너 `cptc_`) sha256 저장. 딥링크/웹 페어링은 수동 확인 |
| 세션 | 기기별 refresh 세션 테이블(`refresh_session`), JWT HS256 고정, 시크릿 미설정 시 기동 중단(fail-closed) |
| E2EE | §2. 기기 승인 안전코드(60비트, 데몬·PC·앱 독립 계산 일치), 봉투 nonce 8B, 해제 epoch 거부 |
| 기타 | 레이트리밋(키 = `CF-Connecting-IP`), helmet, 무인증 라우트 락다운, 프리뷰 토큰 랜덤화, fs 홈 jail |

### 3.11 릴리스 / 업데이트
| 기능 | 내용 |
|---|---|
| PC 자동 업데이트 | objectstore `codingpt/pc-releases/` + back `/api/pc/update/...`. 24h 주기 확인, 다운로드/설치 분리, **조용한 순간**(에이전트 미작업·승인 없음·원격 화면 0·창 비포커스)에만 자동 적용, 아니면 배너(나중에=3일 유예) |
| 원격 업데이트 | 폰에서 PC 업데이트 요청(`POST /api/daemon/pc/update`), 재시작 중 "업데이트 중 · 곧 다시 연결" 오버레이(TTL 5분) |
| 모바일 업데이트 안내 | 스토어 버전 자동 감지(iOS 공개 lookup, Android env), `APP_MIN_*` 킬스위치 |
| 스토어 자동화 | `scripts/store/asc.mjs`·`play.mjs`(제출·심사 상태·출시·watch), `ios-signing.sh`(인증서·프로파일을 API 로 — Xcode GUI 불필요), `bump-version.sh`·`release-status.sh`·`verify-deploy.sh` |
| 서버 배포 | `deploy.sh dev|prod` = 서버가 main 을 git pull(푸시 선행). prod 는 명시 요청시만 |

### 3.12 Windows 포팅
| 항목 | 상태 |
|---|---|
| 코드 | main 에 병합. tmux 등가 `packages/term-host`(ConPTY+xterm-headless), `term-backend.js`(darwin=tmux / win32=term-host), Rust named pipe(`winpipe.rs`)·`termhost.rs`·`preview_win.rs`(WebView2 컴포지션) |
| CI | `.github/workflows/windows-port.yml` windows-latest 러너 그린(시점 기준), NSIS 미서명 아티팩트 수동 빌드 |
| 실기 | 앱 빌드·기동·온보딩까지 확인. 사이드카 조립·프리뷰 입력 라우팅(WebView2 가 별도 프로세스라 서브클래스 불가 → 계약 개정 필요) 등 **웨이브3 브링업 미완 — 공개 배포 없음**. 정본 `docs/windows-port/design.md` |

### 3.13 cpt CLI (터미널 안 에이전트용)
`codingpt_daemon/packages/cpt-cli/bin/cpt.js`(의존성 0). 주요 그룹: `identify` · `terminal`(list/send/read-screen) ·
`notify` · `layout` · `preview`/`browser` · `ide`(open/diff) · `review` · `emulator` · `desktop` · 훅 수신
(`claude-hook` 등). 가이드는 `cpt-cli/GUIDE.md`·`SKILL.md`(바이너리가 서빙 — 스텁에는 명령 목록을 넣지 않음).
`CPT_WS` 가 없는(CodingPT 터미널이 아닌) 곳에서는 쓰지 않는다.

## 4. 핵심 파일

**데몬 `codingpt_daemon/packages/`** (npm workspaces)
- `daemon/index.js` — CLI `pair | run | setup | status | unpair`(PC 앱이 사이드카로 `run`)
- `runner-core/` — 계약 구현 한 벌(로컬 데몬·클라우드 러너 공유)
  - 연결: `control.js`(제어 WS·RPC 디스패치) · `cpt-server.js`(cpt.sock) · `runtime.js` · `config.js`(`~/.codingpt/daemon.json` 0600)
  - 터미널: `terminal-host.js` · `tmux-control.js` · `pty-v3.js` · `terminal-stream-v3.js` · `terminal-local.js` · `terminal-manifest.js` · `term-backend*.js` · `pty.js`
  - 파일·워크스페이스: `fs.js` · `workspace.js` · `surfaces.js` · `freshness.js` · `sync.js`
  - 프리뷰·네트워크: `proxy.js` · `forward.js` · `lan.js` · `lan-local.js` · `webrtc.js`
  - 보안: `e2ee.js` · `e2ee-account.js` · `e2ee-gate.js` · `e2ee-local.js`
  - 에이전트: `agents.js` · `shim.js` · `skills.js` · `agent-state.js` · `agent-status.js` · `agent-watch.js` · `approvals.js` · `question-revive.js` · `transcript.js` · `status-line.js` · `statusline-relay.js` · `commands.js` · `review.js`
  - 작업: `tasks.js` · `task-git.js`
  - 에뮬·에이전트 PC: `emulator.js` · `emulator-stream.js` · `scrcpy-session.js` · `serve-sim-session.js` · `desktop.js` · `desktop-linux.js` · `desktop-rfb.js` · `desktop-ax.jxa.js` · `desktop-atspi.py` · `native/vt-h264.swift`
- `cpt-cli/` — `cpt` CLI · `term-host/` — Windows 세션 호스트 · `cloud-runner/` — 클라우드 컨테이너 부트스트랩(게이팅)
- 설계: `codingpt_daemon/docs/terminal-v3-design.md`(§6 재부팅 복원) · `agent-tasks-design.md` · `agent-tasks-sidebar.md`

**백엔드 `codingpt_back/`**
- `services/daemonRelayService.js` — 릴레이 허브(제어 WS·dial-back·forward·팬아웃·presence·updating 호스트)
- `controllers/daemonController.js` + `routes/daemonRoutes.js` — `/api/daemon/*`(페어링·터미널·fs·프리뷰·forward·rpc 봉인·task·approvals·e2ee·pc/update·surface)
- `config/caps.js`(SERVER_CAPS) · `config/lanDirect.js` · `config/runner.js`(CLOUD_RUNNER_ENABLED)
- `services/approvalService.js` · `deviceTrustService.js`(E2EE 열쇠 배포, objectstore keyring) · `lanDirectService.js` · `notificationService.js` · `pushService.js` · `workspaceService.js` · `appReleaseService.js` · `pcReleaseService.js` · `appleAuthService.js` · `cloudRunnerService.js`
- `app.js` — WS 업그레이드 단일 핸들러 · `models/refresh-session.js`·`daemon-device.js`·`push-device.js`
- 계약 문서: `docs/plumbing-contract.md`(E2EE·LAN·caps 배관 정본) · `docs/agent-hooks-findings.md`(훅 실측) · `docs/runner-contract.md`

**PC 앱 `codingpt_pc/`**
- `src/js/` — `main.js` · `state.js` · `tiling.js` · `workspace-view.js` · `pane.js` · `terminal-stream-v3.js` · `sidebar.js` · `sidebar-tasks.js` · `tasks-view.js`·`task-detail.js`·`new-task-sheet.js` · `ide.js` · `review-view.js` · `chat-view.js`·`chat-model.js` · `approvals.js` · `emulator-view.js`·`desktop-sheet.js` · `surface-sync.js` · `ui-channel.js` · `e2ee.js`·`lan.js` · `update-scheduler.js`·`update-policy.js` · `palette.js`·`shortcuts.js` · `devtools.js`
- `src-tauri/src/` — `lib.rs` · `bridge.rs` · `pty.rs`/`tmux.rs` · `preview.rs`(macOS) · `preview_win.rs` · `cptsock.rs` · `fsapi.rs` · `termhost.rs`/`winpipe.rs`(win32)
- `scripts/bundle-sidecar.sh`(node+tmux+Lume 번들) · `scripts/release-pc.sh`(서명·공증·발행)

**모바일 앱 `codingpt_app/src/`**
- `workspace/` — `WorkspaceView.tsx` · `PaneView.tsx` · `tiling.ts` · `EmulatorBody.tsx`·`EmulatorVideo.tsx` · `chat/` · `tasks/`(`TasksDashboardHost.tsx`·`useTasks.ts`·`tasksModel.ts`) · `hostUpdating.ts` · `UiCommandBridge.tsx`
- `components/module/ide/TerminalWebView.tsx`(+`terminalWebViewEngine.generated.ts`) · `components/approval/`
- `contexts/WorkspaceShellContext.tsx`(표면 리컨실) · `IdeProjectContext.tsx`
- `services/daemonService.ts` · `portForwarder.ts` · `lanLink.ts` · `e2ee/` · `taskService.ts` · `approvalService.ts` · `chatService.ts` · `pushService.ts` · `appUpdate.ts`
- `config/features.ts`(`SUBSCRIPTION_ENABLED`)

**리포 공통**: `codingpt_service/scripts/`(릴리스·스토어 자동화) · `codingpt_service/docs/windows-port/`

## 5. 확정된 제품 결정

- AI 실행은 전부 사용자 PC·사용자 CLI(BYO). 클라우드 AI 엔진 없음, 자격증명 무접촉.
- 터미널 = 전용 tmux 세션 + 안정 tid. "세션 없음 = 닫힘"(재부팅은 매니페스트로만 복원).
- 터미널 크기는 **소유자 1명**. 기기별 최적 크기 동시 제공은 하지 않는다(PTY 크기는 하나) — 사용자가 "이 기기로 조작" 으로 명시 전환.
- 모든 pane 은 기기 간 공유(2026-09-20, 이전 "표면 비공유" 결정 폐기). 각 기기 탐색 상태는 독립.
- 채팅 = TUI 화면의 미러. 입력 UX 정본은 로컬 컴포저(키 포워딩 미러 방식은 폐기).
- 상태 표시는 공식 채널(statusLine 훅·rollout)로만, 화면 스크랩 금지. "모름" 은 필드 제거로 표현.
- 프리뷰는 포트 포워딩이 기본, 경로형 프록시는 폴백.
- caps 교집합이 기능 게이트, 버전은 표시용. 미신고 = 모름 = 가능(구 클라 배제 금지).
- PC 업데이트는 조용한 순간에만 자동, 그 외엔 사용자 선택(강제 설치·재실행 금지).
- 데몬은 계정 E2EE 신뢰기점을 자동 생성하지 않는다. `lan.*` 은 cpt CAPABILITIES 에 비공개.
- 에이전트 PC = 맥 1대당 OS별 데스크톱, 에이전트는 호스트에서 `cpt desktop` 으로 조작(게스트 내 에이전트 실행은 범위 밖).
- 작업(Task) 저장소는 사람이 고른다, PR 은 `gh`(서버 토큰 0), 원격 없으면 로컬 머지.
- 워크스페이스 위치는 항상 사용자가 직접 고른다(권장 기본 루트 재도입 금지).
- 앱/웹 가격 차등은 의도(스토어 수수료). 현재는 판매 자체가 꺼져 있다.
- UI: 이모지 금지, 포인트 컬러는 상태 신호 전용, 벤더 제품명 미표시.

## 6. 미구현 / 알려진 한계

- **Windows**: 코드·CI 는 있으나 실기 브링업(웨이브3) 미완 — 사이드카 조립, 프리뷰 입력 라우팅 계약 개정, 서명 배포 없음.
- **Linux(호스트) PC 앱**: 없음(Linux 는 에이전트 PC 게스트로만).
- **에이전트 PC**: 게스트 안에서 에이전트를 돌리는 완전 격리는 미구현. macOS 게스트 이미지 ~21GB·첫 pull 이 길다.
- **구독/결제**: PortOne V2·RevenueCat IAP 코드 존재하지만 `SUBSCRIPTION_ENABLED` OFF, 판매 없음.
- **클라우드 러너**: `CLOUD_RUNNER_ENABLED` 기본 꺼짐. prod 에서는 스토어 심사 데모 계정(`demo@codingpt.app`) 워크스페이스용으로만 가동.
- **스냅샷/동기화 UI**: 엔진(`sync.js`)은 있으나 UI 잠정 숨김(MVP = 단일 PC + 모바일 안정화).
- **LAN 직결**: 서버 스위치 기본 꺼짐, scope 단계 개방. 같은 사설망에서만 동작, 외부는 릴레이(영상은 WebRTC).
- **surface REST**(`/api/daemon/surface`)는 dev 우선 배포 이력 — 폰은 봉인 RPC 우선이라 동작하지만 평문 폴백 경로는 환경별 확인 필요.
- **모바일 버전 스큐**: 스토어 심사로 모바일이 늘 뒤처진다(현재 iOS 가 Android 보다 뒤). 신기능은 caps 로 숨겨진다.
- **알려진 CI 실패**: 데몬 Windows 경로 테스트 일부, PC emulator-crossimpl 일부(기존 실패). PC i18n 번역 누락 일부.
- 레슨·TTS 는 레거시(어드민 전용), BYO 제품과 무관.

## 7. 함정 / 교훈 (재발 잦은 상위 10)

1. **tmux 에 UTF-8 강제 필수** — Finder 로 실행된 앱은 LANG 이 없어 tmux 가 탭 구분자까지 `_` 로 이스케이프 → list 파싱 전멸. 모든 tmux 호출 경로(`tmuxEnv()`)에 적용.
2. **크기 주장은 `resize-window`** — `refresh-client -C` 는 window-size manual 상태에서 조용히 무시된다.
3. **tmux 세션은 OS 재부팅을 못 넘긴다** — "세션 목록 = 영속" 전제 금지. 매니페스트가 정본.
4. **tmux 서버를 죽이지 말 것**(pkill·kill-server 금지) — 모든 기기의 터미널이 함께 사라진다. 이 Mac 에서 데몬을 추가 기동하지 말 것(PC 앱 번들 데몬과 상호 kill).
5. **앱이 띄운 데몬의 PATH 는 `/usr/bin:/bin` 뿐** — 외부 CLI(gh·adb·lume 등)가 또 PATH 로 찾는 바이너리는 조용히 실패. 절대경로/보강 PATH 로 실행.
6. **에이전트 판정은 프로세스 이름으로 하지 말 것** — claude 의 `pane_current_command` 가 버전 문자열(`2.1.x`)이다. 화면 제목 글리프 기준.
7. **"테스트 초록" ≠ 동작** — E2EE 는 데몬에 열쇠 취득 경로가 0건이라 caps 가 늘 비어 있었다. `gate.caps()`·`npm ls`·실기로 교집합 세 항을 모두 확인. 패키지 경계 계약 테스트는 "상대가 실제로 보내는 형태" 로.
8. **인라인 웹뷰 스크립트는 실행 회귀 필수** — 한 try 블록에서 정의 전 호출이 삼켜져 "초기화 오류" 배너만 남는다(tsc·lint 통과). 릴리스 설치본은 metro 리로드가 안 먹는다.
9. **배포 순서** — `deploy.sh` 는 서버 git pull 이라 push 선행. 데몬(runner-core) 수정은 PC 앱 재릴리스(버전 범프)로만 사용자에게 간다. 레이트리밋 키는 `CF-Connecting-IP`(req.ip 는 CF 엣지).
10. **Tauri 동기 커맨드는 메인 스레드** — 오래 걸리는 작업은 무지개 커서. 번들 바이너리는 `rm -f` 후 `cp`(같은 inode 덮어쓰기 = 서명 캐시 불일치로 SIGKILL). 새 Xcode 메이저는 최신 iOS 시뮬 실행 확인 후 제출(iOS 27 UIScene 강제 사고).
