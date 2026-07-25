# Backend (`codingpt_back/`)

Express.js MVC-S 패턴: `routes/ → controllers/ → services/ → models/ → PostgreSQL`

## 응답 포맷

`utils/response.js` 헬퍼 반드시 사용. `res.json()` 직접 작성 금지.

```js
successResponse(res, data)
errorResponse(res, error, statusCode)  // { success: false, message, error, timestamp }
paginatedResponse(res, data, page, limit, total)
```

## 서비스 레이어

- 컨트롤러: 요청/응답 처리만. 비즈니스 로직: 서비스로 분리(throw → 컨트롤러 try/catch)

## 데이터베이스

- Sequelize 모델 — snake_case 컬럼 (`underscored: true`), 새 모델은 `models/index.js`에 연관관계 등록
- **스키마 변경은 반드시 마이그레이션으로** — `sequelize.sync()` 금지. 절차: `../.claude/rules/db-migration.md`
- 환경별 설정 `config/database.js` — local/dev SSL 없음

## 인증 (이중 체계 — 혼동 주의)

- **유저 JWT**: `middlewares/authMiddleware.js` — 모바일/웹이 호출하는 라우트
- **데몬 deviceToken**: `daemonController.resolveAccount` — PC 데몬/PC 앱이 호출하는 라우트(JWT도 겸용)
- 어느 쪽인지는 `routes/daemonRoutes.js` 주석 확인. 프리뷰 시작 등 일부는 JWT 전용.

## BYO-PC 데몬 허브 (현재 제품의 중심)

정본 문서: `docs/byo-pc-design.md`(설계) / `docs/byo-pc-status.md`(as-built).

| 구성요소 | 역할 |
|----------|------|
| `services/daemonRelayService.js` | 데몬 제어 WS 종단 + dial-back 스트림(pty/tcp) + ui_command 팬아웃 + `proxyHttp/proxyWs`(프리뷰 터널) |
| `services/workspaceService.js` | 워크스페이스 메타 CRUD — **DB 아님, objectstore project.json**. projectId 그룹핑(normalizeRemote·이름/remote 자동연결)·enrichHosts |
| `services/notificationService.js` | 알림 생성→WSS/SSE 팬아웃→미접속 시 FCM. pane 단위 읽음(cwd,win) |
| `controllers/daemonController.js` | 페어링·터미널·fs·프리뷰·프로젝트 detach/attach |
| `config/runner.js` | `CLOUD_RUNNER_ENABLED`(기본 false) — 클라우드 러너 게이팅 스위치 |
| `services/approvalService.js` | 원격 승인 인박스(기능1) 인메모리 인덱스 — **정본은 데몬**(back 재시작은 데몬 resync 로 복구). REST `/api/daemon/approvals/*`, 해소 시 `markRead` 로 기존 크로스기기 dismiss 재사용 |
| `services/deviceTrustService.js` | E2EE 열쇠 배포(기능2 A단계) — 기기 승인/봉인문 중계. **서버는 암호문만 저장**(평문 MK 필드 없음). 저장=objectstore `workspace/<uid>/e2ee/keyring.json`(DB 무추가), 대기 enrollment=인메모리. REST `/api/daemon/e2ee/*` + `device_approval_event` 팬아웃 + 페어링 grant(`/pair/grant`) |
| `config/caps.js` | capability 협상 사전(`SERVER_CAPS`) — 서버에 처리 코드가 있는 능력만 선언. 킬스위치로 회수 가능 |
| `app.js` server.on('upgrade') | **WS 업그레이드 단일 핸들러** — 데몬 연결/에이전트 스트림/프리뷰 HMR 라우팅. 새 WS 경로는 여기 추가 |

- 승인/트랜스크립트 env 스위치(전부 미설정=켜짐, `0|false|off|no`=끔):
  `APPROVAL_ENABLED`(끄면 approval.v1 미선언 + create 가 즉시 `{defer:true}` → 데몬은 TUI 폴백),
  `TRANSCRIPT_ENABLED`, `APPROVAL_TTL_MS`(600000), `APPROVAL_MAX_PENDING_PER_USER`(20),
  `APPROVAL_ESCALATE_MS`(60000), `APPROVAL_PUSH_POLICY`(`escalate`기본|`present`|`always`),
  `APPROVAL_ANDROID_CHANNEL`(기본 `codingpt_default` — 앱이 `codingpt_approval` 채널을 만든 뒤 전환).
  데몬측 킬스위치는 `CPT_APPROVAL=0`(훅이 즉시 무출력 종료 = 기존 TUI 동작).
- E2EE 열쇠 배포 env: `E2EE_ENABLED`(끄면 `e2ee.keys.v1` 미선언 + `/e2ee/*` 503 = 평문 그대로),
  `E2EE_VERIFY_SIG`(기본 켜짐 — 서버가 grant Ed25519 서명 자체검증), `E2EE_ENROLL_TTL_MS`(600000),
  `E2EE_MAX_PENDING`(5), `E2EE_ENROLL_MAX_PER_MIN`(10), `E2EE_DECIDE_MAX_PER_MIN`(30),
  `E2EE_ANDROID_CHANNEL`. 데몬측 킬스위치는 `CPT_E2EE=0`.
- 프리뷰 프록시: `POST /api/daemon/preview/start` → 불투명 토큰 → `ALL /preview/:token(/*)` 무인증 진입
  → 데몬 loopback 터널. 토큰 발급은 JWT 전용, 터널은 loopback 한정(SSRF 방지).
- 알림·ui_command 등 클라이언트 팬아웃은 기존 `agentWsClients` 채널 재사용 — 새 이벤트 타입 추가 시
  구 클라이언트가 무시해도 안전하게(하위호환) 설계할 것.

## 주요 파일 (레거시 포함)

- `app.js` — 진입점, 라우트 `/api/*` 마운트
- `executor-server.js` — Docker 코드 실행 서버(레슨 레거시)
- TTS 4서비스(`ttsService/ttsRequestService/ttsFileService/ttsStorageService`) — 어드민 TTS 라이브러리용

## 외부 서비스

Google OAuth(웹+안드로이드 클라이언트 ID 별도) · MinIO objectstore(`OBJECTSTORE_*`) · ElevenLabs TTS ·
FCM 푸시(Firebase codingpt-65f11) · PortOne V2 결제(현재 판매 OFF)
