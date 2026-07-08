# BYO-PC — 현재 구현 상태 (as-built)

> 이 문서는 **"지금까지 실제로 만들어진 것"**을 정리한 핸드오프 문서다.
> 원래 설계/로드맵 정본은 [`byo-pc-design.md`](./byo-pc-design.md), 단계 계획은 `.claude/plans/`.
> 기획 고도화 시 이 문서를 "현재 토대"로 삼고, 새 기획안이 로드맵을 대체한다.
> 최종 갱신: 2026-07-08.

---

## 1. 개념 / 하드 경계

사용자 PC에 얇은 **데몬**을 두고, 모바일 앱이 PC의 **터미널 / 파일 / dev 서버 프리뷰**를 미러링한다.
- **비용 0 원칙**: 로컬(PC) 경로의 AI는 *사용자가 자기 claude를 자기 구독으로* 실행(사용자 PC에서). 우리 인프라로 사용자 자격증명/구독이 흐르지 않는다.
- **ToS 경계(절대 규칙)** — *2026-07-09 M1 갱신*: 데몬은 AI 자격증명(Keychain·`~/.claude` OAuth)을 **읽지도 옮기지도 않는다.** 경계의 핵심은 실행 위치·자격증명 소유. M1부터 데몬이 **사용자 자신의 로컬 claude를 구조화 모드로 spawn**(`claude -p --output-format stream-json`)하는 것은 허용 — 사용자 PC·사용자 구독으로 돌고 API는 PC→Anthropic 직결(`lib/agent.js`). 금지는 *우리 키/서버 구동*과 *크레덴셜을 우리 인프라로 라우팅*. 세션 재개용 `~/.claude/projects/*.jsonl` 대화 로그 읽기는 허용(크레덴셜 아님).

## 2. 아키텍처

```
폰 앱 ──WSS/HTTPS──► nginx ──► back(:5300 local, 릴레이 내장) ◄──아웃바운드 WSS── Mac 데몬
                              · daemonRegistry: userId→제어WS                node-pty + tmux(-L codingpt)
                              · 제어 WS 1개 + dial-back 스트림(pty|tcp)      fs RPC + ws RPC + dev프록시
```
- **제어 WS**(`/api/daemon/connect`): 데몬↔back 상시 1개. JSON — hello_ack / stream_open / rpc / fs_event.
- **dial-back 스트림**: 앱이 터미널/프리뷰를 열면 back이 제어 채널로 `stream_open{streamToken,kind}` 지시 → 데몬이 `/api/daemon/stream/:token`으로 전용 WS를 **아웃바운드**로 다이얼 → back이 앱 소켓과 파이프. (인바운드 포트 0.)
  - `kind:'pty'` = 터미널, `kind:'tcp'` = 프리뷰 터널.
- **와이어 계약**: PTY 스트림은 기존 termproxy 계약(바이너리=stdin, JSON resize, raw out) 그대로 → 앱 `TerminalWebView` 무수정.

## 3. 구현된 기능 (capability별, 전부 에뮬 E2E 검증됨)

| 기능 | 내용 |
|---|---|
| **페어링 + 터미널 미러(P0)** | 앱 페어링코드 → 데몬 `pair`. 데몬 tmux 세션을 폰/Mac 실시간 공유. WS 끊겨도 세션 생존 |
| **파일 IDE 연동(P1)** | fs RPC(list/tree/read/write/watch). 모바일 IDE가 데몬 폴더를 프로젝트로 소비. claude가 PC 파일 고치면 폰에 라이브 반영 |
| **프리뷰(P2)** | PC dev 서버를 폰 웹뷰로. 포트 감지(lsof) + tcp 터널 + `dpv` 쿠키 루트 라우팅(base='/' dev서버 대응). HMR 브리지 |
| **진입 UX 전환(Slice1)** | 워크스페이스 목록 우상단 **연결 인디케이터**(내PC↔가상서버) → 탭 시 **PC 터미널 진입**. `내정보>연결>내PC`는 **상태 표시만** |
| **PC 워크스페이스 스캐폴드(Slice2)** | `내 PC 워크스페이스(+)` → 폴더 피커(최초1회 루트) → 이름 → **결정적 스캐폴드**(mkdir+git init+README/.gitignore) → 데몬 IDE 진입. 비용 0 |
| **권한(macOS TCC)** | 권장 루트 `~/CodingPT/workspaces`(보호폴더 밖→프롬프트 없음) 원탭 + `node index.js setup`(FDA 설정창 안내) |
| **목록 통합 + 재진입(Slice2b)** | PC 워크스페이스도 objectstore 메타(compute='local', localPath)로 등록 → 목록에 `내 PC` 배지+경로로 노출, 탭 시 재진입. 삭제는 목록에서만(PC 폴더 보존) |
| **워크스페이스별 터미널 cwd** | 워크스페이스 진입 시 터미널이 **그 폴더에서 시작**(전용 tmux 세션 `cpt-<path>`). 홈 인디케이터는 홈 세션 유지 |

## 4. 핵심 파일

**데몬 `codingpt_daemon/`** (의존성: ws, node-pty, chokidar만)
- `index.js` — CLI: `pair | run | setup | status | unpair`
- `lib/control.js` — 제어 WS(재접속 백오프), stream_open/rpc 디스패치(fs.*, net.ports, ws.*)
- `lib/pty.js` — dial-back PTY. `sessionForCwd(cwdRel)`로 워크스페이스별 tmux 세션 @ 그 폴더
- `lib/proxy.js` — `net.ports`(lsof) + tcp 터널(loopback 전용, SSRF 방지)
- `lib/fs.js` — fs RPC(홈 jail: safeResolve/realpath, 점파일/무거운dir 필터). `ROOT=os.homedir()`
- `lib/workspace.js` — `ws.getRoot/setRoot/useDefaultRoot/create`(slug·git init·템플릿). `DEFAULT_ROOT_REL='CodingPT/workspaces'`
- `lib/config.js` — `~/.codingpt/daemon.json`(0600, load→merge→save). 필드: serverUrl/deviceId/deviceToken/deviceName/**workspaceRoot**

**백엔드 `codingpt_back/`** (릴레이 = back 프로세스 내장, 새 컨테이너 0)
- `services/daemonRelayService.js` — daemonRegistry, openStream(pty/tcp), callRpc, 터미널토큰(+cwd), proxyHttp/proxyWs(프리뷰)
- `controllers/daemonController.js` — 페어링/상태/터미널/fs.*/ws.*/프리뷰 + previewCookieMiddleware
- `routes/daemonRoutes.js` — `/api/daemon/*`
- `app.js` — 단일 WS upgrade 핸들러에 `/connect`·`/stream/:token`·`/terminal/:token`·프리뷰 분기
- `services/workspaceService.js` + `controllers/workspaceController.js` — WorkspaceMeta(compute/localPath 포함) objectstore CRUD

**앱 `codingpt_app/`**
- `services/daemonService.ts` — 상태/페어링/터미널(cwd)/fs/ws(getRoot·setRoot·useDefaultRoot·create)/프리뷰
- `services/ideSource.ts` — `pc:<homeRelPath>` 인코딩/판별(daemonProjectId/daemonRootOf). **홈 루트('')는 빈 프로젝트로**(fsTree 타임아웃 회피)
- `services/ideService.ts` — getIdeProject(데몬은 fsTree로 트리 구성)
- `services/workspaceService.ts` — WorkspaceMeta/CreateWorkspaceInput(compute/localPath)
- `hooks/useDaemonStatus.ts` — 데몬 연결 상태 폴링
- `components/ComputeStatusButton.tsx` — 목록 우상단 인디케이터
- `components/PcWorkspaceSheet.tsx` — 루트 피커 + 스캐폴드 생성 시트
- `contexts/IdeProjectContext.tsx` — IDE 오버레이(상주, openIde/openTerminal), 프로젝트 로드/저장. pc:는 stopDevPreview 스킵
- `contexts/WorkspaceStoreContext.tsx` — 워크스페이스/세션 프리로드(local은 세션 스킵)
- `contexts/AgentSessionContext.tsx` — activeWorkspace, 세션
- `screens/MobileIDE/*` — 모바일 IDE(에디터/탐색기/터미널/브라우저). isDaemon 분기
- `screens/Projects/ProjectsScreen.tsx` — 워크스페이스 목록(+PC 버튼, local 배지/라우팅)
- `screens/LocalAgent/LocalAgentScreen.tsx` — (레거시성) 폴더 피커 진입. 페어링 코드 발급 UI

## 5. 데이터 모델 / 프로토콜

- **projectId 규약**: `pc:<홈기준 상대경로>` = 데몬 소스(홈='pc:'). 접두사 없으면 cloud.
- **WorkspaceMeta**(objectstore `workspace/<uid>/projects/<id>/project.json`): id, name, description, stack, thumb, kind('chat'|'project'), **compute('cloud'|'local')**, **localPath**(local일 때 데몬 홈기준 상대), unread, createdAt, updatedAt.
  - PC 워크스페이스의 메타는 **"포인터/북마크"** — 실제 파일은 PC에, 메타는 목록·재진입용. 삭제해도 PC 폴더 안 지움.
- **제어 WS 메시지**: `hello_ack` / `stream_open{streamToken,kind,params}` / `rpc{id,method,params}`→`rpc_result{id,ok,result|error}` / `fs_event`.
  - RPC method: `fs.list/tree/read/write/watch/unwatch`, `net.ports`, `ws.getRoot/setRoot/useDefaultRoot/create`.
- **터미널 토큰**: `{userId, cwd}` — cwd로 워크스페이스 폴더에서 터미널 시작.
- **프리뷰**: HMAC 토큰 + `dpv` 쿠키로 base='/' dev서버 루트 라우팅.

## 6. 확정된 제품 결정

- 워크스페이스 생성 = **결정적 스캐폴드**(우리 AI 안 씀, 비용 0). 루트는 **사용자 최초 1회 지정**(권장 위치 원탭 or 폴더 피커).
- 생성 시 **로컬+클라우드 메타 둘 다** 세팅(현재: PC 스캐폴드 + 클라우드 메타 등록. 파일 동기화는 미구현=Slice3).
- `내 PC 워크스페이스(+)`(로컬)와 채팅 composer(클라우드 AI)는 **분리 유지** — cloud=우리 에이전트(우리 비용), local=사용자 claude(본인 구독)로 실행 모델이 근본적으로 다름.
- **사용자 관점**: "로컬/서버"를 의식·전환하지 않고 알아서 처리되는 게 목표. → 이를 위해선 **양방향 동기화(Slice3) + 자동 라우팅**이 필요(미구현). 단, **AI 실행 지점**만은 완전 투명화 불가(자격증명/ToS 경계).

## 7. 로컬을 쓰기 위한 PC 세팅 (사용자 준비물)

- **설치**: Node.js, tmux(`brew install tmux`), git(macOS 기본), **본인 claude CLI + 로그인**(← 로컬 AI의 핵심, 우리가 대신 못 넣음).
- **최초 1회**: 데몬 설치+`npm install` → `node index.js setup`(권장폴더+권한) → `node index.js pair`(앱 코드).
- **상시**: `node index.js run` 실행 중이어야 함(현재 수동 → 추후 LaunchAgent/메뉴바 앱으로 자동화 = P4).

## 8. 미구현 / 다음 후보

- **Slice 3 — 로컬↔ghmate 양방향 git 체크포인트 동기화**: rescue 브랜치(파괴 연산 전 보존), 제안형 오프라인 폴백. **sync 허브 미확정**: GitHub `codingpt/sync`(OAuth 필요, 현재 비활성) vs **objectstore git-bundle**(항상 가용·단순, 추천).
- **자동 라우팅**: 워크스페이스 열 때 PC연결+로컬이면 PC, 아니면 클라우드 — 전환 버튼 없이.
- **온보딩 체크리스트**: claude 설치/로그인·tmux·데몬 실행 상태를 앱에서 점검·안내.
- **배포**: 현재 **로컬 전용**(로컬 back=Docker `Dockerfile.local` nodemon+바인드마운트). dev/prod 릴레이 미배포. nginx WS 타임아웃 실측 필요.
- **패키징(P4)**: LaunchAgent/메뉴바 앱 + Apple 서명·공증 → "상시 실행" 자동화, FDA를 signed app에 부여.
- 기타: 오래된 tmux 세션 정리, HMR 자동설정, 데몬 정적 프리뷰, 포트 목록 노이즈, 클라우드 파일 영속화(현재 샌드박스 볼륨만).
- **GA 전**: Anthropic에 미러링 적법성 서면 확인 권고.

## 9. 함정 / 교훈 (재발 방지)

- **홈 루트 fsTree 타임아웃**: 홈 전체 순회는 RPC 타임아웃 → 홈 루트('')는 빈 프로젝트로 열고 터미널만. 워크스페이스 루트는 bounded라 정상.
- **macOS TCC**: 앱이 권한 자가승인 **불가**(Apple). 보호폴더(Documents/Desktop/…) 밖(`~/CodingPT/workspaces`)에 두거나 FDA 1회.
- **데몬 재시작 필요**: 데몬은 nodemon이 아님 → 데몬 코드 바꾸면 `node index.js run` 재실행해야 반영. (로컬 back은 Docker nodemon+바인드마운트라 자동반영.)
- **daemon.json**: 항상 load→merge→save(deviceToken 등 보존). 0600.
- **stopDevPreview**: pc: 프로젝트엔 스킵(사용자 PC dev 서버 절대 종료 금지 + userId 기준이라 오종료 위험).
- **git 커밋 메시지**: Claude 관련 문구/Co-Authored-By 금지(사용자 규칙).
- **에뮬 검증**: Fast Refresh 누적 상태 artifact → 이상하면 콜드스타트. WebView 화면에선 uiautomator dump 행 → screencap 사용.

## 10. 운영/환경 상태 (2026-07-08, 세션 종료 시 변동 주의)

- **커밋 브랜치**: app `feat/agent-panel-vertical-slice`(HEAD 9c0a1ff), service `feat/agent-engine-vertical-slice`(HEAD d658867). BYO-PC 변경 전부 커밋됨. (service의 `codingpt_front/package*.json` 변경은 BYO-PC와 무관 — 손대지 않음.)
- **데몬**: 이 작업 세션이 백그라운드로 최신 코드 실행 중 → **세션 종료 시 멈춤**. 사용자가 자기 환경(cmux)에서 `node index.js run` 재실행 필요. tmux(`-L codingpt`) 세션은 별도 생존.
- **daemon.json**: `workspaceRoot=CodingPT/workspaces`(테스트로 설정됨, 권장 위치라 그대로 둬도 무방).
- **테스트 잔여물**: 워크스페이스 목록에 `list-demo`(`~/CodingPT/workspaces/list-demo`, 스캐폴드된 실제 폴더) 남아있음 — 동작하는 워크스페이스, 무해. 불필요하면 앱 ⋯→삭제(목록에서만 제거, PC 폴더 유지).
- **BYO-PC 배포 상태**: 로컬만 검증. dev/prod 미배포.
