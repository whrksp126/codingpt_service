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
| `app.js` server.on('upgrade') | **WS 업그레이드 단일 핸들러** — 데몬 연결/에이전트 스트림/프리뷰 HMR 라우팅. 새 WS 경로는 여기 추가 |

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
