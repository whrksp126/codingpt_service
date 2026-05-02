# TTS 기능 구현 완료 요약

## 구현 완료 항목

### ✅ 1. 데이터베이스 모델
- `models/tts-request.js` - TTS 요청 모델
- `models/tts-saved-file.js` - 저장된 파일 모델

### ✅ 2. 서비스 레이어
- `services/ttsService.js` - ElevenLabs API 통합
- `services/ttsFileService.js` - 파일명 생성 유틸리티
- `services/ttsStorageService.js` - S3 저장/삭제 로직
- `services/ttsRequestService.js` - 요청 관리 (CRUD)

### ✅ 3. 컨트롤러
- `controllers/ttsController.js` - API 엔드포인트 핸들러

### ✅ 4. 라우트
- `routes/ttsRoutes.js` - 라우트 정의
- `routes/index.js` - 라우트 등록 완료

## 필요한 패키지 설치

다음 패키지들을 설치해야 합니다:

```bash
npm install axios @aws-sdk/s3-request-presigner
```

## 데이터베이스 테이블 생성

다음 SQL을 실행하여 테이블을 생성하세요:

```sql
-- TTS 요청 테이블
CREATE TABLE tts_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  voice_id VARCHAR(100),
  model_id VARCHAR(50),
  text TEXT NOT NULL,
  text_with_emotions TEXT,
  settings JSONB,
  audio_url TEXT,
  audio_s3_path TEXT,
  timestamps JSONB,
  file_name VARCHAR(500),
  file_size INTEGER,
  duration FLOAT,
  status VARCHAR(50) DEFAULT 'pending',
  is_saved BOOLEAN DEFAULT FALSE,
  s3_save_path TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tts_requests_user_id ON tts_requests(user_id);
CREATE INDEX idx_tts_requests_status ON tts_requests(status);
CREATE INDEX idx_tts_requests_is_saved ON tts_requests(is_saved);

-- TTS 저장 파일 테이블
CREATE TABLE tts_saved_files (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  tts_request_id INTEGER REFERENCES tts_requests(id),
  s3_path TEXT NOT NULL,
  file_name VARCHAR(500) NOT NULL,
  original_text TEXT NOT NULL,
  voice_id VARCHAR(100),
  model_id VARCHAR(50),
  settings JSONB,
  timestamps JSONB,
  file_size INTEGER,
  duration FLOAT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tts_saved_files_user_id ON tts_saved_files(user_id);
CREATE INDEX idx_tts_saved_files_s3_path ON tts_saved_files(s3_path);
```

## 환경 변수 설정

`.env.local` 파일에 다음 환경 변수를 추가하세요:

```env
# ElevenLabs API 설정
ELEVENLABS_API_KEY=your_api_key_here
ELEVENLABS_API_URL=https://api.elevenlabs.io/v1
```

자세한 설정 방법은 `docs/tts-design.md`의 "8. 환경 변수 설정 안내" 섹션을 참고하세요.

## API 엔드포인트

모든 엔드포인트는 `/api/tts`로 시작하며, 인증이 필요합니다.

### 1. 목소리 목록 조회
```
GET /api/tts/voices
```

### 2. 음성 생성
```
POST /api/tts/generate
Body: {
  voiceId: string,
  modelId?: string,
  text: string,
  settings?: object
}
```

### 3. 임시 생성 데이터 삭제
```
DELETE /api/tts/request/:requestId
```

### 4. 최종 저장
```
POST /api/tts/save
Body: {
  requestId: number,
  s3Path: string,
  customFileName?: string
}
```

### 5. 저장된 파일 목록 조회
```
GET /api/tts/saved?page=1&limit=20
```

### 6. 저장된 파일 삭제
```
DELETE /api/tts/saved/:savedFileId
```

## 다음 단계

1. **패키지 설치**: `npm install axios @aws-sdk/s3-request-presigner`
2. **데이터베이스 테이블 생성**: 위의 SQL 실행
3. **환경 변수 설정**: `.env.local`에 ElevenLabs API 키 추가
4. **서버 재시작**: 변경사항 적용
5. **테스트**: API 엔드포인트 테스트

## 주의사항

1. **ElevenLabs API 키**: 반드시 환경 변수로 관리하고 코드에 하드코딩하지 마세요.
2. **S3 경로 검증**: 사용자 입력 경로는 자동으로 검증되지만, 추가 보안 검증이 필요할 수 있습니다.
3. **타임스탬프**: 현재 ElevenLabs API의 타임스탬프 응답 형식에 맞춰 구현되어 있습니다. 실제 API 응답에 따라 조정이 필요할 수 있습니다.
4. **Presigned URL**: `@aws-sdk/s3-request-presigner` 패키지가 없으면 CloudFront URL 또는 직접 S3 URL을 사용합니다.

## 문제 해결

### Presigned URL 생성 실패 시
- `@aws-sdk/s3-request-presigner` 패키지가 설치되어 있는지 확인하세요.
- 설치되지 않은 경우, CloudFront URL 또는 직접 S3 URL이 자동으로 사용됩니다.

### ElevenLabs API 에러
- API 키가 올바르게 설정되었는지 확인하세요.
- API 할당량을 초과했는지 확인하세요.
- 네트워크 연결을 확인하세요.

### S3 저장 실패
- AWS 자격 증명이 올바르게 설정되었는지 확인하세요.
- S3 버킷 권한을 확인하세요.
- 파일 크기 제한을 확인하세요 (현재 10MB).

---

구현이 완료되었습니다! 🎉

