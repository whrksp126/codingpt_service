# BYO-PC (내 PC 컴퓨팅) 설계 정본

> 2026-07 확정. 리서치 배경: 프로젝트 루트 `BYO-PC-RESEARCH.md`. 이 문서가 구현 기준.

## 0. 핵심 개념

사용자 PC에 **codingpt_daemon**("CodingPT PC 에이전트")을 설치하면 모바일 앱이
(a) PC의 tmux 터미널을 실시간 미러링/조작하고 (b) PC 파일을 읽고/쓰고(P1)
(c) PC의 dev 서버를 프리뷰(P2)할 수 있다.

**ToS 하드 경계 (절대 규칙)**: 비용 0은 "사용자가 자기 PC에서 자기 claude CLI를 직접
실행하고, 우리는 그 터미널 화면 바이트만 릴레이"하는 경로에서만 성립한다.
- ✅ 허용: PTY 바이트 미러링(SSH/tmux를 폰에서 보는 것과 동일). API 요청·자격증명은 PC→Anthropic 직결.
- ❌ 금지: 우리 제품(데몬 포함)이 사용자 구독 토큰/OAuth로 claude·Agent SDK를 헤드리스 구동하거나,
  자격증명을 우리 인프라로 라우팅하는 모든 형태 (2026-01 Anthropic ToS 금지·서버차단).
- 데몬 코드에는 AI 자격증명을 읽거나 다루는 코드가 **존재해서는 안 된다.**

## 1. 토폴로지

```
폰 앱 ──WSS/HTTPS──► nginx ──► back(:5100, 릴레이 내장) ◄──아웃바운드 WSS── PC 데몬
                              │  daemonRelayService (교환원)                node-pty + tmux
                              └──HTTP──► agent-worker(:5400) 클라우드 티어(기존, 무수정)
```

- 데몬은 **인바운드 포트 0**. 아웃바운드 WSS만 연다(공유기/방화벽 설정 불필요).
- 릴레이는 back 프로세스 내장(`services/daemonRelayService.js`) — 새 컨테이너/도메인/nginx 변경 없음.
  back 단일 프로세스 전제(인메모리 Map — agentService.pendingPermissions와 동일 전제).
- back 재배포 시 데몬은 지수백오프로 자동 재접속. 터미널 세션은 PC의 tmux 서버에 살아 있어 안 죽는다.

## 2. 와이어 프로토콜

### 2.1 제어 채널 — `GET /api/daemon/connect` (WS 업그레이드)
- 인증: `Authorization: Bearer <deviceToken>` → sha256 → `daemon_device.token_hash` 대조(revoked 제외).
- 같은 사용자의 기존 연결은 새 연결이 교체(close 4000 'replaced'). close 4001 'revoked' = 재페어링 필요.
- JSON 텍스트 메시지:
  - 데몬→back `{type:'hello', deviceName, platform, daemonVersion}` → back `{type:'hello_ack', serverTime}`
  - back→데몬 `{type:'stream_open', streamToken, kind:'pty', params:{cols,rows}}`
  - 데몬→back `{type:'stream_fail', streamToken, message}` (열기 실패 회신)
  - (P1 예약) `{type:'rpc', id, method, params}` / `{type:'rpc_result', id, ok, result|error}`
- keepalive: back이 30s 간격 protocol ping(Cloudflare 유휴 WS ~100s 컷 대비). 데몬은 90s 무신호 시 재접속.

### 2.2 dial-back 스트림 — `GET /api/daemon/stream/:streamToken` (데몬→back WS)
멀티플렉싱 대신 **스트림당 WS 1개**: back이 stream_open을 지시하면 데몬이 전용 아웃바운드
WS를 추가로 다이얼. TCP 백프레셔가 채널별로 자연 적용(PTY 파이어호스가 파일 RPC를 못 굶김).
streamToken은 일회용, 10s 내 미도착 시 타임아웃.

### 2.3 앱 터미널 — `POST /api/daemon/terminal/start`(JWT) → `GET /api/daemon/terminal/:token`(WS)
불투명 토큰 패턴(terminalProxyController와 동일 — WebView WS는 Authorization 헤더 불가).
back이 앱 WS 핸드셰이크 완료 → 데몬에 pty 스트림 open → **메시지 단위 양방향 릴레이**
(raw 소켓 pipe는 WS 마스킹 방향성 때문에 불가).

**PTY 와이어 계약(기존 termproxy와 동일 — 앱 TerminalWebView 무수정)**:
- 클라→PTY: 바이너리 = stdin, 텍스트 JSON `{type:'resize',cols,rows}` = 리사이즈, 그 외 텍스트 = 입력 폴백
- PTY→클라: raw 출력 그대로

## 3. 데몬 (codingpt_service/codingpt_daemon/)

- Node 스크립트(P0~P3, 본인 검증용). 메뉴바 앱 포장(Tauri+서명/공증)은 P4에서 별도 결정.
- CLI: `pair [--server URL]` / `run` / `status` / `unpair`. 설정 `~/.codingpt/daemon.json`(0600).
- tmux: **전용 소켓 `-L codingpt`**(사용자 개인 tmux 서버와 격리), 세션 `codingpt`, `-A`로 attach.
  - 로컬에서 같은 세션 보기: `tmux -L codingpt attach -t codingpt`
  - `window-size latest` + `aggressive-resize`: 마지막 조작 클라이언트 크기 기준(폰↔Mac 동시 attach).
  - 데몬이 tmux/cmux 안에서 실행돼도 되도록 자식 env에서 `TMUX` 제거(소켓이 달라 안전).
- 스트림 WS 끊김 → tmux 클라이언트만 종료(detach). 세션/실행 중 프로세스는 생존, 재접속 시 tmux가 화면 재그리기.

## 4. 페어링

1. 앱(JWT) `POST /api/daemon/pair/code` → 일회용 코드 `XXXX-XXXX`(10분, 헷갈리는 문자 제외)
2. PC `node index.js pair` → `POST /api/daemon/pair/claim {code, deviceName, ...}` (무인증 — 코드가 비밀)
3. back이 `daemon_device` 생성(토큰은 sha256 해시만 저장) → 데몬이 원문 토큰 로컬 보관
4. 상태: `GET /api/daemon/status`, 해제: `POST /api/daemon/devices/:id/revoke`

## 5. 단계 로드맵 (각각 에뮬레이터 E2E 수직 슬라이스)

- **P0 (완료 목표)**: 페어링 + 제어 WS + 터미널 미러. 앱 `LocalAgentScreen`(터미널 기반 에이전트 환경 —
  로컬 CLI 모드에선 채팅 UI 대신 풀 터미널이 에이전트 표면). 진입: 마이페이지 "내 PC" 행.
- **P1**: 제어 채널 RPC(fs.list/read/write/watch) + IDE 파일 연동. 디렉토리 **allowlist**(기본 deny,
  `..`/심링크 탈출 거부)를 데몬 측에서 강제.
- **P2**: 프리뷰 — dial-back http 스트림, `127.0.0.1:<선언포트>`만(SSRF 방지), Host 재작성 + HMR.
- **P3**: 워크스페이스 통합(compute 필드) + git 체크포인트 동기화:
  - 허브 = GitHub 기존 repo의 `codingpt/sync` 브랜치(없으면 private repo 자동 생성)
  - 체크포인트는 사용자 HEAD/워킹트리/인덱스 불변(plumbing: 임시 index → write-tree → commit-tree)
  - 어떤 파괴적 연산(reset --hard) 전에도 rescue 브랜치(`codingpt/rescue/<ts>`) 커밋 선행 — 조용한 유실 금지
  - single-active lease는 back이 소유(서버 권위). PC 오프라인 폴백은 **제안형**(자동 전환 금지)
  - 시크릿(.env*)·gitignore 바이너리 → objectstore 사이드카(git 미포함), node_modules/dist 제외
- **P4**: 트랜스크립트 관찰 재렌더(비공식 포맷 — 버전 감지+조용한 비활성), 패키징, 플랜 게이트.

## 6. 보안 원칙

- 계정 경계: 릴레이는 같은 userId의 앱↔데몬만 연결. 디바이스 토큰은 원격 revoke 가능.
- P1부터 디렉토리 allowlist(워크스페이스별 opt-in 절대경로) 없이는 fs RPC 금지.
- 프리뷰 프록시는 loopback+선언 포트만. exec류는 전부 로그.
- GA 전 Anthropic에 미러링 적법성 서면 확인 권고(상업 확장 시점).

## 7. 구현 파일 맵

| 위치 | 역할 |
|---|---|
| `codingpt_back/services/daemonRelayService.js` | 릴레이(레지스트리/제어/스트림/터미널 브리지) |
| `codingpt_back/controllers/daemonController.js` + `routes/daemonRoutes.js` | 페어링/상태/revoke/터미널 토큰 |
| `codingpt_back/models/daemon-device.js` + `migrations/*create-daemon-device*` | 기기 등록 |
| `codingpt_back/app.js` upgrade 핸들러 | `/api/daemon/connect`·`/stream/:t`·`/terminal/:t` 분기 |
| `codingpt_daemon/` | PC 데몬(CLI/제어/PTY) |
| `codingpt_app/src/services/daemonService.ts` | 앱 API 서비스 |
| `codingpt_app/src/screens/LocalAgent/LocalAgentScreen.tsx` | 터미널 기반 에이전트 환경 |
