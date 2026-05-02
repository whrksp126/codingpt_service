# ElevenLabs TTS 통합 설계 문서

## 1. 개요

ElevenLabs API를 이용한 AI 음성 생성 및 관리 시스템 설계 문서입니다.

**중요: 임시 데이터 관리 방식**
- TTS 시스템은 **섹션 ID 없이 `requestId`만 사용**하여 임시 파일을 관리합니다
- 단일 관리자 사용 시나리오에 최적화되어 있어 섹션별 구분이 불필요합니다
- 임시 파일 경로: `codingpt/tts/temp/{requestId}.mp3`

## 2. 요구사항 정리

### 2.1 사용자 기능
- 목소리(Voice) 선택
- 모델 선택 (v3 알파 모델 포함)
- 감정 표현 지원 (`[점점 화나면서]` 형식의 대괄호 감정 표현)
- 텍스트 입력 및 수정
- 상세 설정 (음성 속도, 안정성, 유사도 등)
- 생성 결과 시각화 (오디오 인터페이스, 파형, 타임스탬프)
- 재생 시 구간별 시각적 표현
- 여러 생성 결과 비교 기능
- 최종 선택 후 S3 저장

### 2.2 기술적 요구사항
- 생성된 음성 파일 S3 저장
- 타임스탬프 데이터 저장 및 관리
- 텍스트 기반 파일명 생성 (특수문자 제거)
- 임시 생성 데이터 관리

## 3. 아키텍처 설계

### 3.1 데이터베이스 설계

#### 3.1.1 TTS 생성 요청 테이블 (`tts-requests`)
임시 생성 데이터를 관리하기 위한 테이블

```sql
CREATE TABLE tts_requests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  voice_id VARCHAR(100), -- ElevenLabs Voice ID
  model_id VARCHAR(50), -- 모델 ID (예: "eleven_multilingual_v2", "eleven_turbo_v2_5")
  text TEXT NOT NULL, -- 입력 텍스트
  text_with_emotions TEXT, -- 감정 표현 포함 텍스트
  settings JSONB, -- 추가 설정 (stability, similarity_boost, style, use_speaker_boost 등)
  audio_url TEXT, -- 생성된 오디오 파일의 임시 URL 또는 S3 경로
  audio_s3_path TEXT, -- S3에 저장된 경우의 경로
  timestamps JSONB, -- 타임스탬프 데이터 (word-level 또는 character-level)
  file_name VARCHAR(500), -- 생성된 파일명
  file_size INTEGER, -- 파일 크기 (bytes)
  duration FLOAT, -- 오디오 길이 (초)
  status VARCHAR(50) DEFAULT 'pending', -- pending, completed, saved, failed
  is_saved BOOLEAN DEFAULT FALSE, -- 최종 저장 여부
  s3_save_path TEXT, -- 사용자가 지정한 최종 S3 저장 경로
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tts_requests_user_id ON tts_requests(user_id);
CREATE INDEX idx_tts_requests_status ON tts_requests(status);
CREATE INDEX idx_tts_requests_is_saved ON tts_requests(is_saved);
```

#### 3.1.2 TTS 저장 기록 테이블 (`tts-saved-files`)
최종 저장된 파일들의 메타데이터 관리

```sql
CREATE TABLE tts_saved_files (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  tts_request_id INTEGER REFERENCES tts_requests(id),
  s3_path TEXT NOT NULL, -- S3 저장 경로
  file_name VARCHAR(500) NOT NULL,
  original_text TEXT NOT NULL, -- 원본 텍스트
  voice_id VARCHAR(100),
  model_id VARCHAR(50),
  settings JSONB,
  timestamps JSONB, -- 타임스탬프 데이터
  file_size INTEGER,
  duration FLOAT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tts_saved_files_user_id ON tts_saved_files(user_id);
CREATE INDEX idx_tts_saved_files_s3_path ON tts_saved_files(s3_path);
```

### 3.2 타임스탬프 저장 방식 결정

**결론: 데이터베이스에 저장 (JSONB 타입 사용)**

**이유:**
1. **검색 및 쿼리 용이성**: DB에 저장하면 특정 텍스트나 구간을 검색하기 쉬움
2. **관계형 데이터 관리**: 사용자, 파일, 요청 등과의 관계를 쉽게 관리 가능
3. **일반적인 베스트 프랙티스**: 메타데이터는 DB, 실제 파일은 S3에 저장하는 것이 표준
4. **성능**: 타임스탬프는 작은 데이터이므로 DB 저장이 효율적
5. **백업 및 복구**: DB 백업에 포함되어 관리가 용이

**타임스탬프 데이터 구조 (예시):**
```json
{
  "version": "1.0",
  "words": [
    {
      "word": "안녕하세요",
      "start": 0.0,
      "end": 1.2,
      "confidence": 0.95
    },
    {
      "word": "반갑습니다",
      "start": 1.2,
      "end": 2.5,
      "confidence": 0.93
    }
  ],
  "characters": [
    {
      "char": "안",
      "start": 0.0,
      "end": 0.3
    }
    // ... 더 세밀한 단위가 필요한 경우
  ]
}
```

### 3.3 API 엔드포인트 설계

#### 3.3.1 음성 생성 요청
```
POST /api/tts/generate
```

**Request Body:**
```json
{
  "voiceId": "21m00Tcm4TlvDq8ikWAM", // ElevenLabs Voice ID
  "modelId": "eleven_multilingual_v2", // 모델 ID
  "text": "안녕하세요 [점점 화나면서] 반갑습니다",
  "settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "use_speaker_boost": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "requestId": 123,
    "audioUrl": "https://temp-storage.com/audio-123.mp3", // 임시 URL 또는 S3 presigned URL
    "timestamps": {
      "words": [...],
      "characters": [...]
    },
    "duration": 3.5,
    "fileName": "안녕하세요_반갑습니다.mp3",
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

#### 3.3.2 임시 생성 데이터 삭제
```
DELETE /api/tts/request/:requestId
```

**설명:**
- 사용자가 생성한 임시 음성 데이터를 삭제하는 API
- S3의 임시 파일과 DB 레코드를 모두 삭제
- 본인이 생성한 데이터만 삭제 가능 (인증 필요)

**Response:**
```json
{
  "success": true,
  "message": "임시 생성 데이터가 삭제되었습니다.",
  "data": {
    "requestId": 123,
    "deletedS3Path": "codingpt/tts/temp/123.mp3"
  }
}
```

**에러 응답:**
```json
{
  "success": false,
  "message": "삭제할 권한이 없거나 데이터를 찾을 수 없습니다.",
  "error": "NotFound"
}
```

#### 3.3.4 최종 저장
```
POST /api/tts/save
```

**Request Body:**
```json
{
  "requestId": 123,
  "s3Path": "user-123/audio/", // 사용자가 입력한 S3 경로 (codingpt/tts/static/ 제외)
  "customFileName": "optional-custom-name" // 선택적 커스텀 파일명
}
```

**설명:**
- 사용자가 입력한 `s3Path`는 `codingpt/tts/static/` 이후의 경로만 입력
- 최종 저장 경로: `codingpt/tts/static/{사용자 입력 경로}/{파일명}.mp3`
- 예: 사용자 입력 `"user-123/audio/"` → 최종 경로 `"codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3"`

**Response:**
```json
{
  "success": true,
  "data": {
    "savedFileId": 456,
    "s3Path": "codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3",
    "s3Url": "https://s3.amazonaws.com/bucket/codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3",
    "timestamps": {...},
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

#### 3.3.5 저장된 파일 목록 조회
```
GET /api/tts/saved?userId=123&page=1&limit=20
```

**Query Parameters:**
- `userId` (optional): 특정 사용자의 파일만 조회 (인증된 사용자는 자신의 파일만 조회)
- `page` (optional, default: 1): 페이지 번호
- `limit` (optional, default: 20): 페이지당 항목 수

**Response:**
```json
{
  "success": true,
  "data": {
    "files": [
      {
        "savedFileId": 456,
        "s3Path": "codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3",
        "s3Url": "https://...",
        "fileName": "안녕하세요_반갑습니다.mp3",
        "originalText": "안녕하세요 반갑습니다",
        "duration": 3.5,
        "createdAt": "2024-01-01T00:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

#### 3.3.6 저장된 파일 삭제
```
DELETE /api/tts/saved/:savedFileId
```

**설명:**
- 저장된 파일과 S3 파일을 모두 삭제
- 본인이 저장한 파일만 삭제 가능 (인증 필요)

**Response:**
```json
{
  "success": true,
  "message": "저장된 파일이 삭제되었습니다.",
  "data": {
    "savedFileId": 456,
    "deletedS3Path": "codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3"
  }
}
```

#### 3.3.7 ElevenLabs 목소리 목록 조회
```
GET /api/tts/voices
```

**Response:**
```json
{
  "success": true,
  "data": {
    "voices": [
      {
        "voice_id": "21m00Tcm4TlvDq8ikWAM",
        "name": "Rachel",
        "category": "premade",
        "description": "..."
      }
    ]
  }
}
```

### 3.4 파일명 생성 로직

**규칙:**
1. 입력 텍스트에서 감정 표현 제거 (`[점점 화나면서]` 같은 대괄호 내용 제거)
2. 특수문자 제거 또는 안전한 문자로 변환
3. 공백을 언더스코어(`_`)로 변환
4. 길이 제한 (예: 100자)
5. 파일명 중복 방지 (타임스탬프 추가 또는 숫자 suffix)

**예시:**
```
입력: "안녕하세요 [점점 화나면서] 반갑습니다!"
결과: "안녕하세요_반갑습니다.mp3"

입력: "Hello World!!!"
결과: "Hello_World.mp3"
```

**구현 예시:**
```javascript
function generateFileName(text) {
  // 1. 감정 표현 제거 (대괄호 내용 제거)
  let cleaned = text.replace(/\[.*?\]/g, '').trim();
  
  // 2. 특수문자 제거 (한글, 영문, 숫자, 공백만 허용)
  cleaned = cleaned.replace(/[^가-힣a-zA-Z0-9\s]/g, '');
  
  // 3. 연속된 공백을 하나로
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // 4. 공백을 언더스코어로 변환
  cleaned = cleaned.replace(/\s/g, '_');
  
  // 5. 길이 제한 (100자)
  if (cleaned.length > 100) {
    cleaned = cleaned.substring(0, 100);
  }
  
  // 6. 빈 문자열 처리
  if (!cleaned) {
    cleaned = 'tts_' + Date.now();
  }
  
  return cleaned + '.mp3';
}
```

### 3.5 임시 저장 전략

**중요:** `requestId`만 사용하여 임시 파일을 관리합니다.

**S3 임시 저장 경로:**
- 경로: `codingpt/tts/temp/{requestId}.mp3`
- 예: `codingpt/tts/temp/123.mp3`
- requestId만으로 파일을 식별하여 관리

**최종 저장 경로:**
- 경로: `codingpt/tts/static/{사용자 입력 경로}/{파일명}.mp3`
- 예: 사용자 입력 `"user-123/audio/"` → `codingpt/tts/static/user-123/audio/안녕하세요_반갑습니다.mp3`

**저장 프로세스:**
1. 음성 생성 시 → `codingpt/tts/temp/{requestId}.mp3`에 임시 저장
2. DB에 `is_saved=false`로 레코드 생성
3. 사용자가 저장 버튼 클릭 시:
   - S3 파일을 `codingpt/tts/static/{사용자 입력 경로}/{파일명}.mp3`로 복사
   - DB 레코드의 `is_saved=true`로 변경 및 `s3_save_path` 업데이트
   - `tts_saved_files` 테이블에 레코드 생성
   - 임시 파일은 유지 (사용자가 비교를 위해 필요할 수 있음)

**임시 파일 정리:**
- 사용자가 직접 삭제 API 호출 가능 (`DELETE /api/tts/request/:requestId`)
- 정기적으로 `is_saved=false`이고 24시간 이상 경과된 데이터는 자동 삭제 (크론 작업)

### 3.6 서비스 레이어 구조

```
services/
  ├── ttsService.js          # ElevenLabs API 통합
  ├── ttsRequestService.js   # 생성 요청 관리
  ├── ttsStorageService.js   # S3 저장 로직
  └── ttsFileService.js      # 파일명 생성 등 유틸리티

controllers/
  └── ttsController.js       # API 엔드포인트 핸들러

routes/
  └── ttsRoutes.js           # 라우트 정의

models/
  ├── tts-request.js         # TTS 요청 모델
  └── tts-saved-file.js      # 저장된 파일 모델
```

### 3.7 ElevenLabs API 통합

**필요한 API 엔드포인트:**
1. `GET /v1/voices` - 목소리 목록 조회
2. `POST /v1/text-to-speech/{voice_id}` - 음성 생성
   - `output_format`: "mp3_44100_128" (권장)
   - `enable_logging`: false (프로덕션)
   - `optimize_streaming_latency`: 0-4 (0이 가장 낮은 지연시간)

**환경 변수 사용:**
코드에서는 다음과 같이 환경 변수를 사용합니다:
```javascript
// services/ttsService.js
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1';
```

**참고:** 환경 변수 설정은 구현 완료 후 사용자에게 안내할 내용입니다. (문서 하단의 "환경 변수 설정 안내" 섹션 참고)

**에러 처리:**
- API 키 만료/무효
- 할당량 초과
- 네트워크 오류
- 잘못된 요청 파라미터

### 3.8 프론트엔드 연동 고려사항

**오디오 재생 및 시각화:**
- 타임스탬프 데이터를 이용한 워드 하이라이팅
- 오디오 파형 시각화를 위한 웨이브폼 데이터 (프론트엔드에서 오디오 파일 분석)

**Presigned URL:**
- S3에 저장된 파일의 경우, 보안을 위해 Presigned URL 생성
- 임시 URL은 만료 시간 설정 (예: 1시간)

## 4. 구현 가이드

### 4.1 구현 순서

1. **Phase 1: 기본 인프라**
   - DB 모델 생성 (`models/tts-request.js`, `models/tts-saved-file.js`)
   - 환경 변수 설정 (`.env.local`에 `ELEVENLABS_API_KEY`, `ELEVENLABS_API_URL` 추가)
   - ElevenLabs API 통합 서비스 (`services/ttsService.js`)
   - 기본 생성 API 구현 (`POST /api/tts/generate`)

2. **Phase 2: 저장 기능**
   - S3 저장 로직 (`services/ttsStorageService.js`)
   - 파일명 생성 로직 (`services/ttsFileService.js`)
   - 타임스탬프 저장
   - 최종 저장 API (`POST /api/tts/save`)

3. **Phase 3: 삭제 기능**
   - 임시 데이터 삭제 API (`DELETE /api/tts/request/:requestId`)
   - 저장된 파일 목록 조회 (`GET /api/tts/saved`)
   - 저장된 파일 삭제 API (`DELETE /api/tts/saved/:savedFileId`)

4. **Phase 4: 최적화**
   - 임시 파일 정리 크론 작업
   - 에러 처리 강화
   - 로깅 및 모니터링

### 4.2 파일 구조

```
models/
  ├── tts-request.js         # TTS 요청 모델
  └── tts-saved-file.js      # 저장된 파일 모델

services/
  ├── ttsService.js          # ElevenLabs API 통합
  ├── ttsRequestService.js   # 생성 요청 관리 (CRUD)
  ├── ttsStorageService.js   # S3 저장/삭제 로직
  └── ttsFileService.js      # 파일명 생성 등 유틸리티

controllers/
  └── ttsController.js       # API 엔드포인트 핸들러

routes/
  └── ttsRoutes.js           # 라우트 정의
```

### 4.3 주요 구현 포인트

#### 4.3.1 S3 경로 처리
```javascript
// 임시 저장 경로
const tempPath = `codingpt/tts/temp/${requestId}.mp3`;

// 최종 저장 경로 (사용자 입력 경로 검증 필요)
// 사용자 입력: "user-123/audio/" (앞뒤 슬래시 제거)
// 최종 경로: "codingpt/tts/static/user-123/audio/파일명.mp3"
const userPath = userInputPath.replace(/^\/+|\/+$/g, ''); // 앞뒤 슬래시 제거
const finalPath = `codingpt/tts/static/${userPath}/${fileName}`;
```

#### 4.3.2 파일명 생성
- 텍스트에서 감정 표현 제거 (`[점점 화나면서]` 같은 대괄호 내용)
- 특수문자 제거 (한글, 영문, 숫자, 공백만 허용)
- 공백을 언더스코어로 변환
- 길이 제한 100자
- 중복 방지 (타임스탬프 또는 숫자 suffix 추가)

#### 4.3.3 타임스탬프 데이터 구조
ElevenLabs API에서 반환하는 타임스탬프 형식에 맞춰 저장:
```json
{
  "version": "1.0",
  "alignment": {
    "characters": [
      {
        "char": "안",
        "start": 0.0,
        "end": 0.3
      }
    ],
    "words": [
      {
        "word": "안녕하세요",
        "start": 0.0,
        "end": 1.2,
        "confidence": 0.95
      }
    ]
  }
}
```

#### 4.3.4 인증 미들웨어 적용
모든 TTS 관련 엔드포인트에 인증 미들웨어 적용:
```javascript
const authMiddleware = require('../middlewares/authMiddleware');
router.post('/generate', authMiddleware, ttsController.generate);
router.delete('/request/:requestId', authMiddleware, ttsController.deleteRequest);
router.post('/save', authMiddleware, ttsController.save);
router.get('/saved', authMiddleware, ttsController.getSavedFiles);
router.delete('/saved/:savedFileId', authMiddleware, ttsController.deleteSavedFile);
```

#### 4.3.5 S3 파일 삭제
- 임시 파일 삭제: `s3Service.deleteFile(tempS3Path)`
- 저장된 파일 삭제: `s3Service.deleteFile(finalS3Path)`
- DB 레코드도 함께 삭제

#### 4.3.6 Presigned URL 생성
S3에 저장된 파일 접근을 위한 Presigned URL 생성:
```javascript
// 임시 파일: 1시간 유효
// 저장된 파일: 필요시 생성 (또는 CloudFront URL 사용)
```

### 4.4 라우트 등록

`routes/index.js`에 TTS 라우트 추가:
```javascript
const ttsRoutes = require('./ttsRoutes');
router.use('/tts', ttsRoutes);
```

### 4.5 에러 처리

**주요 에러 케이스:**
1. ElevenLabs API 에러
   - API 키 무효/만료
   - 할당량 초과
   - 네트워크 오류
   - 잘못된 요청 파라미터

2. S3 에러
   - 권한 없음
   - 버킷 없음
   - 파일 크기 제한 초과

3. DB 에러
   - 연결 실패
   - 제약 조건 위반

4. 사용자 권한 에러
   - 다른 사용자의 데이터 접근 시도
   - 인증되지 않은 요청

### 4.6 구현 체크리스트

- [ ] DB 모델 생성 (`tts-request.js`, `tts-saved-file.js`)
- [ ] Sequelize 마이그레이션 또는 수동 테이블 생성
- [ ] ElevenLabs API 통합 서비스 (`ttsService.js`)
- [ ] 파일명 생성 유틸리티 (`ttsFileService.js`)
- [ ] S3 저장 서비스 (`ttsStorageService.js`)
- [ ] 요청 관리 서비스 (`ttsRequestService.js`)
- [ ] 컨트롤러 구현 (`ttsController.js`)
- [ ] 라우트 정의 (`ttsRoutes.js`)
- [ ] 라우트 등록 (`routes/index.js`)
- [ ] 인증 미들웨어 적용
- [ ] 에러 처리
- [ ] 테스트

## 5. 보안 고려사항

1. **API 키 관리**: 환경 변수로 관리, 절대 코드에 하드코딩 금지
2. **사용자 인증**: 모든 엔드포인트에 인증 미들웨어 적용
3. **S3 경로 검증**: 사용자 입력 경로에 대한 검증 및 경로 탐색 공격 방지
4. **Rate Limiting**: ElevenLabs API 호출 제한 관리
5. **파일 크기 제한**: 생성된 오디오 파일 크기 제한

## 6. 성능 고려사항

1. **비동기 처리**: 음성 생성은 시간이 걸릴 수 있으므로 비동기 처리 고려
2. **캐싱**: 자주 조회되는 목소리 목록은 캐싱
3. **배치 처리**: 여러 생성 요청이 있을 경우 배치 처리 고려
4. **CDN**: S3 파일은 CloudFront를 통해 제공 (이미 구현되어 있음)

## 7. 모니터링 및 로깅

1. **생성 성공/실패율 추적**
2. **평균 생성 시간 측정**
3. **S3 저장 성공/실패 추적**
4. **API 호출 비용 모니터링**

## 8. 환경 변수 설정 안내

**구현 완료 후 사용자에게 안내할 내용:**

### 8.1 필요한 환경 변수

`.env.local` 파일에 다음 환경 변수를 추가해야 합니다:

```env
# ElevenLabs API 설정
ELEVENLABS_API_KEY=your_api_key_here
ELEVENLABS_API_URL=https://api.elevenlabs.io/v1
```

### 8.2 설정 방법

1. 프로젝트 루트 디렉토리의 `.env.local` 파일을 엽니다.
2. 파일 끝에 다음 내용을 추가합니다 (기존 환경 변수 패턴 참고, 34-35 라인 근처):
   ```env
   # ElevenLabs API 설정
   ELEVENLABS_API_KEY=your_actual_api_key_here
   ELEVENLABS_API_URL=https://api.elevenlabs.io/v1
   ```
3. `your_actual_api_key_here` 부분을 실제 ElevenLabs API 키로 교체합니다.
4. 파일을 저장합니다.
5. 서버를 재시작합니다.

### 8.3 ElevenLabs API 키 발급 방법

1. [ElevenLabs 웹사이트](https://elevenlabs.io)에 가입/로그인합니다.
2. 대시보드에서 API 키를 생성합니다.
3. 생성된 API 키를 복사하여 `.env.local` 파일에 붙여넣습니다.

### 8.4 확인 방법

환경 변수가 제대로 설정되었는지 확인하려면:
- 서버 시작 시 환경 변수 로딩 로그 확인
- API 호출 시 에러 메시지 확인 (API 키가 없으면 명확한 에러 메시지 표시)

---

**다음 단계:** 이 설계를 바탕으로 코드 구현을 진행합니다.

