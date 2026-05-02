# Backend Rules (`codingpt_back/`)

Express.js MVC-S 패턴: `routes/ → controllers/ → services/ → models/ → PostgreSQL`

---

## 응답 포맷

`utils/response.js` 헬퍼 반드시 사용. `res.json()` 직접 작성 금지.

```js
successResponse(res, data)           // 성공: data 직접 반환
errorResponse(res, error, statusCode) // 실패: { success: false, message, error, timestamp }
paginatedResponse(res, data, page, limit, total)
```

---

## 서비스 레이어

- 컨트롤러: 요청/응답 처리만
- 비즈니스 로직: 서비스로 분리
- 서비스 함수는 결과 반환 또는 에러 throw → 컨트롤러에서 try/catch

---

## 데이터베이스

- Sequelize 모델 — snake_case 컬럼 (`underscored: true`)
- 새 모델 추가 시 `models/index.js`에 연관관계 등록
- 환경별 DB 설정: `config/database.js` (local/development/staging/production/test)
- connection string 직접 하드코딩 금지

---

## 인증

- 보호 라우트: `middlewares/authMiddleware.js` (JWT 검증)
- Google OAuth → JWT 발급, 첫 로그인 시 자동 회원가입

---

## 주요 파일

| 파일 | 역할 |
|------|------|
| `app.js` | Express 진입점, 모든 라우트 `/api/*` 마운트 |
| `executor-server.js` | Docker 기반 코드 실행 전용 서버 (Dockerode) |
| `middlewares/authMiddleware.js` | JWT 검증 미들웨어 |
| `utils/response.js` | 응답 포맷 헬퍼 |
| `config/database.js` | Sequelize 5환경 설정 |

API 네임스페이스: `/api/users`, `/api/products`, `/api/classes`, `/api/lesson`,  
`/api/myclass`, `/api/executor`, `/api/tts`, `/api/s3`, `/api/hearts`, `/api/store`, `/api/reviews`

---

## TTS 서비스 구조

4개 서비스로 분리:
- `ttsService.js` — ElevenLabs API 통합
- `ttsRequestService.js` — 생성 요청 수명주기
- `ttsFileService.js` — 파일명 생성 유틸
- `ttsStorageService.js` — S3 저장/삭제

---

## 외부 서비스

| 서비스 | 용도 |
|--------|------|
| Google OAuth 2.0 | 인증 (Web + Android 클라이언트 ID 별도) |
| AWS S3 + CloudFront | presigned URL 기반 파일 저장소 |
| ElevenLabs | TTS 오디오 생성 |
| Docker (Dockerode) | 샌드박스 코드 실행 |
| PostgreSQL (RDS) | SSL 연결, 환경별 connection pool |
