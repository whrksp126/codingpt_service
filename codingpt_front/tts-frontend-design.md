# ElevenLabs TTS 프론트엔드 설계 문서

## 1. 개요

ElevenLabs API를 이용한 AI 음성 생성 및 관리 시스템의 프론트엔드 구현 가이드입니다.
이 문서를 기반으로 프론트엔드 개발을 진행하세요.

## 2. 기능 요구사항

### 2.1 음성 생성 기능
- 목소리(Voice) 선택 UI
- 모델 선택 UI (v3 알파 모델 포함)
- 텍스트 입력 및 수정 (감정 표현 지원: `[점점 화나면서]`)
- 상세 설정 UI (stability, similarity_boost, style, use_speaker_boost 등)
- 생성 버튼

### 2.2 생성 결과 표시
- 오디오 플레이어 인터페이스
- 음향 파형(Waveform) 시각화
- 타임스탬프 기반 워드 하이라이팅 (재생 시 현재 구간 강조)
- 재생/일시정지/볼륨 조절 기능

### 2.3 여러 생성 결과 비교
- 여러 생성 결과를 리스트로 표시
- 각 결과를 개별적으로 재생 가능
- 비교를 위해 여러 결과를 동시에 볼 수 있도록 UI 구성

### 2.4 저장 기능
- S3 경로 입력 필드
- 저장 버튼
- 저장 성공/실패 피드백

### 2.5 삭제 기능
- 임시 생성 데이터 삭제 버튼
- 저장된 파일 삭제 기능

## 3. API 엔드포인트 스펙

### 3.1 Base URL
```
https://your-backend-domain.com/api/tts
```

### 3.2 인증
모든 API 요청에 인증 토큰 필요:
```
Authorization: Bearer {token}
```

### 3.3 API 목록

#### 3.3.1 ElevenLabs 모델 목록 조회
```
GET /api/tts/models
```

**설명:**
- 사용 가능한 TTS 모델 목록을 조회합니다.
- 인증 불필요 (로그인 없이 사용 가능)

**Response:**
```json
{
  "success": true,
  "data": {
    "models": [
      {
        "model_id": "eleven_multilingual_v2",
        "name": "Multilingual v2",
        "description": "다국어 지원, 고품질 음성 생성",
        "language_support": "다국어",
        "quality": "높음",
        "speed": "보통",
        "can_use_style": false,
        "can_use_speaker_boost": true,
        "supported_settings": {
          "stability": {
            "supported": true,
            "default": 0.5,
            "min": 0.0,
            "max": 1.0,
            "description": "음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)"
          },
          "similarity_boost": {
            "supported": true,
            "default": 0.75,
            "min": 0.0,
            "max": 1.0,
            "description": "원본 목소리와의 유사도 (높을수록 유사)"
          },
          "style": {
            "supported": false,
            "description": "이 모델에서는 지원하지 않습니다"
          },
          "use_speaker_boost": {
            "supported": true,
            "default": true,
            "type": "boolean",
            "description": "화자 부스트 활성화"
          },
          "speed": {
            "supported": true,
            "default": 1.0,
            "min": 0.25,
            "max": 4.0,
            "description": "음성 속도 (높을수록 빠름)"
          }
        },
        "default_settings": {
          "stability": 0.5,
          "similarity_boost": 0.75,
          "use_speaker_boost": true,
          "speed": 1.0
        }
      },
      {
        "model_id": "eleven_v3",
        "name": "Eleven v3",
        "description": "최신 고급 음성 합성 모델, 높은 감정 범위와 컨텍스트 이해력",
        "language_support": "70개 이상",
        "quality": "매우 높음",
        "speed": "보통",
        "can_use_style": true,
        "can_use_speaker_boost": true,
        "supported_settings": {
          "stability": {
            "supported": true,
            "default": 0.5,
            "min": 0.0,
            "max": 1.0,
            "description": "음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)"
          },
          "similarity_boost": {
            "supported": true,
            "default": 0.75,
            "min": 0.0,
            "max": 1.0,
            "description": "원본 목소리와의 유사도 (높을수록 유사)"
          },
          "style": {
            "supported": true,
            "default": 0.0,
            "min": 0.0,
            "max": 1.0,
            "description": "음성의 스타일 강도 (v3 모델 전용)"
          },
          "use_speaker_boost": {
            "supported": true,
            "default": true,
            "type": "boolean",
            "description": "화자 부스트 활성화"
          },
          "speed": {
            "supported": true,
            "default": 1.0,
            "min": 0.25,
            "max": 4.0,
            "description": "음성 속도 (높을수록 빠름)"
          }
        },
        "default_settings": {
          "stability": 0.5,
          "similarity_boost": 0.75,
          "style": 0.0,
          "use_speaker_boost": true,
          "speed": 1.0
        }
      }
    ]
  }
}
```

**사용 시점:**
- 컴포넌트 마운트 시 또는 모델 선택 UI 진입 시 호출
- 모델 선택 드롭다운/리스트에 표시
- **중요**: 모델 선택 시 해당 모델의 `supported_settings`와 `default_settings`를 사용하여 상세 설정 UI를 동적으로 생성/업데이트

**핵심 사용 방법:**
1. 모델 목록 조회 시 각 모델에 `supported_settings`와 `default_settings`가 포함됨
2. 사용자가 모델을 선택하면:
   - 선택된 모델의 `supported_settings`를 확인하여 지원하는 설정만 UI에 표시
   - 선택된 모델의 `default_settings`로 설정값 초기화
   - 예: `eleven_v3` 모델 선택 시 `style` 설정이 표시되지만, `eleven_multilingual_v2` 선택 시에는 숨김

**구현 예시:**
```javascript
const fetchModels = async () => {
  try {
    const response = await fetch('/api/tts/models');
    const data = await response.json();
    
    if (data.success) {
      setModels(data.data.models);
      // 첫 번째 모델의 기본 설정으로 초기화
      if (data.data.models.length > 0) {
        setSelectedModel(data.data.models[0].model_id);
        setSettings(data.data.models[0].default_settings);
      }
    }
  } catch (error) {
    console.error('모델 목록 조회 실패:', error);
  }
};
```

#### 3.3.2 모델별 설정 정보 조회
```
GET /api/tts/models/:modelId/settings
```

**설명:**
- 특정 모델의 지원 설정 정보를 조회합니다.
- 모델 변경 시 해당 모델이 지원하는 설정만 UI에 표시하기 위해 사용합니다.
- 인증 불필요 (로그인 없이 사용 가능)

**Path Parameters:**
- `modelId` (required): 모델 ID (예: "eleven_multilingual_v2", "eleven_v3")

**Response:**
```json
{
  "success": true,
  "data": {
    "modelId": "eleven_v3",
    "modelName": "Eleven v3",
    "settingsSchema": {
      "stability": {
        "supported": true,
        "default": 0.5,
        "min": 0.0,
        "max": 1.0,
        "description": "음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)"
      },
      "similarity_boost": {
        "supported": true,
        "default": 0.75,
        "min": 0.0,
        "max": 1.0,
        "description": "원본 목소리와의 유사도 (높을수록 유사)"
      },
      "style": {
        "supported": true,
        "default": 0.0,
        "min": 0.0,
        "max": 1.0,
        "description": "음성의 스타일 강도 (v3 모델 전용)"
      },
      "use_speaker_boost": {
        "supported": true,
        "default": true,
        "type": "boolean",
        "description": "화자 부스트 활성화"
      },
      "speed": {
        "supported": true,
        "default": 1.0,
        "min": 0.25,
        "max": 4.0,
        "description": "음성 속도 (높을수록 빠름)"
      }
    },
    "defaultSettings": {
      "stability": 0.5,
      "similarity_boost": 0.75,
      "style": 0.0,
      "use_speaker_boost": true,
      "speed": 1.0
    }
  }
}
```

**에러 Response:**
```json
{
  "success": false,
  "message": "모델 'invalid_model'를 찾을 수 없습니다.",
  "error": "ModelNotFound"
}
```

**사용 시점:**
- 모델 선택 변경 시 해당 모델의 설정 정보 조회
- 상세 설정 UI를 동적으로 업데이트하기 위해 사용
- 모델 목록 조회 시 이미 `supported_settings`가 포함되어 있으므로, 별도 호출 없이도 사용 가능
- 필요시 모델별 설정 정보만 따로 조회할 때 사용

**구현 예시:**
```javascript
const fetchModelSettings = async (modelId) => {
  try {
    const response = await fetch(`/api/tts/models/${modelId}/settings`);
    const data = await response.json();
    
    if (data.success) {
      return {
        settingsSchema: data.data.settingsSchema,
        defaultSettings: data.data.defaultSettings
      };
    } else {
      throw new Error(data.message || '모델 설정 조회 실패');
    }
  } catch (error) {
    console.error('모델 설정 조회 실패:', error);
    throw error;
  }
};
```

#### 3.3.3 ElevenLabs 목소리 목록 조회
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
        "description": "Calm and soothing female voice",
        "preview_url": "https://..."
      },
      {
        "voice_id": "pNInz6obpgDQGcFmaJgB",
        "name": "Adam",
        "category": "premade",
        "description": "Deep male voice",
        "preview_url": "https://..."
      }
    ]
  }
}
```

**사용 시점:**
- 컴포넌트 마운트 시 또는 목소리 선택 UI 진입 시 호출
- 목소리 선택 드롭다운/리스트에 표시

#### 3.3.4 음성 생성 요청
```
POST /api/tts/generate
```

**Request Body:**
```json
{
  "voiceId": "21m00Tcm4TlvDq8ikWAM",
  "modelId": "eleven_multilingual_v2", // 또는 "eleven_turbo_v2_5", "eleven_monolingual_v1" 등
  "text": "안녕하세요 [점점 화나면서] 반갑습니다",
  "settings": {
    "stability": 0.5,           // 0.0 ~ 1.0
    "similarity_boost": 0.75,   // 0.0 ~ 1.0
    "style": 0.0,               // 0.0 ~ 1.0 (v3 알파 모델에서만 사용)
    "use_speaker_boost": true   // boolean
  }
}
```


**Response:**
```json
{
  "success": true,
  "data": {
    "requestId": 123,
    "audioUrl": "https://s3.amazonaws.com/bucket/codingpt/tts/temp/123.mp3?presigned=...",
    "timestamps": {
      "version": "1.0",
      "alignment": {
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
        ]
      }
    },
    "duration": 3.5,
    "fileName": "안녕하세요_반갑습니다.mp3",
    "text": "안녕하세요 [점점 화나면서] 반갑습니다",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "modelId": "eleven_multilingual_v2",
    "settings": {
      "stability": 0.5,
      "similarity_boost": 0.75,
      "style": 0.0,
      "use_speaker_boost": true
    },
    "createdAt": "2024-01-01T00:00:00Z"
  }
}
```

**에러 Response:**
```json
{
  "success": false,
  "message": "음성 생성에 실패했습니다.",
  "error": "ElevenLabsAPIError"
}
```

**사용 시점:**
- 사용자가 생성 버튼 클릭 시
- 로딩 상태 표시 필요
- 성공 시 생성 결과 리스트에 추가

**주의사항:**
- `settings` 객체에 포함된 설정 중 모델이 지원하지 않는 설정은 자동으로 필터링됩니다.
- 예: `eleven_multilingual_v2` 모델에서 `style` 파라미터를 전달해도 무시됩니다.
- 모델이 지원하는 설정만 전달하는 것이 권장됩니다.

#### 3.3.5 임시 생성 데이터 삭제
```
DELETE /api/tts/request/:requestId
```

**Response:**
```json
{
  "success": true,
  "message": "임시 생성 데이터가 삭제되었습니다.",
  "data": {
    "requestId": 123
  }
}
```

**사용 시점:**
- 각 생성 결과 카드에 삭제 버튼 제공
- 삭제 확인 다이얼로그 표시 후 삭제

#### 3.3.7 최종 저장
```
POST /api/tts/save
```

**Request Body:**
```json
{
  "requestId": 123,
  "s3Path": "user-123/audio/", // codingpt/tts/static/ 제외한 경로만 입력
  "customFileName": "optional-custom-name" // 선택적, 없으면 자동 생성된 파일명 사용
}
```

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

**사용 시점:**
- 사용자가 저장 버튼 클릭 시
- S3 경로 입력 필드에서 경로 입력 받음
- 저장 성공 시 해당 항목을 "저장됨" 상태로 표시

#### 3.3.8 저장된 파일 목록 조회
```
GET /api/tts/saved?page=1&limit=20
```

**Query Parameters:**
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
        "voiceId": "21m00Tcm4TlvDq8ikWAM",
        "modelId": "eleven_multilingual_v2",
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

#### 3.3.7 저장된 파일 삭제
```
DELETE /api/tts/saved/:savedFileId
```

**Response:**
```json
{
  "success": true,
  "message": "저장된 파일이 삭제되었습니다.",
  "data": {
    "savedFileId": 456
  }
}
```

## 4. UI/UX 설계

### 4.1 페이지 구조

```
┌─────────────────────────────────────────┐
│  TTS 음성 생성 페이지                    │
├─────────────────────────────────────────┤
│                                         │
│  [설정 패널]                            │
│  - 목소리 선택: [드롭다운]              │
│  - 모델 선택: [드롭다운]                │
│  - 텍스트 입력: [텍스트 영역]           │
│  - 상세 설정: [슬라이더/토글]          │
│  - [생성 버튼]                          │
│                                         │
│  [생성 결과 리스트]                     │
│  ┌─────────────────────────────────┐   │
│  │ [오디오 플레이어]                │   │
│  │ [파형 시각화]                    │   │
│  │ [워드 하이라이팅]                │   │
│  │ S3 경로: [입력 필드]             │   │
│  │ [저장 버튼] [삭제 버튼]          │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ [다른 생성 결과...]              │   │
│  └─────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
```

### 4.2 주요 컴포넌트

#### 4.2.1 목소리 선택 컴포넌트
- 드롭다운 또는 카드 형태의 목소리 리스트
- 각 목소리별 미리보기 재생 버튼
- 목소리 이름, 설명 표시

#### 4.2.2 모델 선택 컴포넌트
- 라디오 버튼 또는 드롭다운
- 모델별 설명 표시:
  - `eleven_multilingual_v2`: 다국어 지원, 고품질
  - `eleven_turbo_v2_5`: 빠른 생성 속도
  - `eleven_monolingual_v1`: 단일 언어, 최고 품질
  - `eleven_turbo_v2`: 빠른 생성 (구버전)

#### 4.2.3 텍스트 입력 컴포넌트
- 텍스트 영역 (Textarea)
- 감정 표현 안내: `[점점 화나면서]` 형식 사용 가능
- 글자 수 표시
- 실시간 미리보기 (감정 표현 제거된 텍스트)

#### 4.2.4 상세 설정 컴포넌트
- **동적 설정 표시**: 선택된 모델의 `supported_settings`를 기반으로 UI 동적 생성
- Stability 슬라이더 (0.0 ~ 1.0) - 모든 모델에서 지원
- Similarity Boost 슬라이더 (0.0 ~ 1.0) - 모든 모델에서 지원
- Style 슬라이더 (0.0 ~ 1.0) - `can_use_style: true`인 모델에서만 표시
- Use Speaker Boost 토글 - `can_use_speaker_boost: true`인 모델에서만 표시
- Speed 슬라이더 (0.25 ~ 4.0) - 모든 모델에서 지원
- 모델 변경 시 지원하지 않는 설정은 자동으로 숨김 처리
- 각 설정 옆에 설명 툴팁 표시 (설정 스키마의 `description` 사용)

#### 4.2.5 오디오 플레이어 컴포넌트
- 재생/일시정지 버튼
- 진행 바 (Seek 가능)
- 볼륨 조절
- 재생 시간 표시 (현재 시간 / 전체 시간)

#### 4.2.6 파형 시각화 컴포넌트
- 오디오 파일을 분석하여 파형 표시
- 라이브러리 추천: `wavesurfer.js`, `waveform-playlist`, `audiowaveform`
- 재생 시 현재 위치 표시

#### 4.2.7 워드 하이라이팅 컴포넌트
- 타임스탬프 데이터를 이용하여 현재 재생 중인 단어 강조
- 텍스트를 단어별로 분리하여 표시
- 재생 시간에 따라 자동으로 하이라이트 변경

**구현 예시:**
```javascript
// 타임스탬프 기반 워드 하이라이팅
const highlightWord = (currentTime, timestamps) => {
  const currentWord = timestamps.words.find(
    word => currentTime >= word.start && currentTime <= word.end
  );
  return currentWord?.word || null;
};
```

#### 4.2.8 생성 결과 카드 컴포넌트
- 각 생성 결과를 카드 형태로 표시
- 오디오 플레이어 포함
- 파형 시각화 포함
- 워드 하이라이팅 포함
- S3 경로 입력 필드
- 저장 버튼
- 삭제 버튼
- 생성 정보 표시 (목소리, 모델, 설정 등)

### 4.3 상태 관리

#### 4.3.1 생성 결과 상태
```typescript
interface TTSRequest {
  requestId: number;
  audioUrl: string;
  timestamps: TimestampData;
  duration: number;
  fileName: string;
  text: string;
  voiceId: string;
  modelId: string;
  settings: Settings;
  isSaved: boolean;
  createdAt: string;
}

interface Model {
  model_id: string;
  name: string;
  description: string;
  can_use_style: boolean;
  can_use_speaker_boost: boolean;
  supported_settings: {
    [key: string]: {
      supported: boolean;
      default?: number | boolean;
      min?: number;
      max?: number;
      type?: 'boolean';
      description: string;
    };
  };
  default_settings: {
    [key: string]: number | boolean;
  };
}

interface Settings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}
```

#### 4.3.3 로딩 상태
- 생성 중: 로딩 스피너 표시
- 생성 완료: 결과 표시
- 에러 발생: 에러 메시지 표시

### 4.4 사용자 플로우

1. **음성 생성 플로우**
   ```
   사용자 입력 → 생성 버튼 클릭 → 로딩 표시 → 결과 표시 → 재생/비교
   ```

2. **비교 플로우**
   ```
   여러 번 생성 → 리스트에 표시 → 각각 재생하여 비교 → 원하는 것 선택
   ```

3. **저장 플로우**
   ```
   생성 결과 확인 → S3 경로 입력 → 저장 버튼 클릭 → 저장 완료 피드백
   ```

4. **삭제 플로우**
   ```
   삭제 버튼 클릭 → 확인 다이얼로그 → 확인 → 삭제 완료 → 리스트에서 제거
   ```

## 5. 기술 스택 제안

### 5.1 오디오 재생
- HTML5 Audio API 또는 `react-audio-player`, `react-h5-audio-player`

### 5.2 파형 시각화
- `wavesurfer.js` (가장 인기)
- `waveform-playlist`
- `audiowaveform`

### 5.3 상태 관리
- React: `useState`, `useContext` 또는 Redux/Zustand
- Vue: `Pinia` 또는 `Vuex`
- 기타 프레임워크: 해당 프레임워크의 상태 관리 솔루션

### 5.4 HTTP 클라이언트
- `axios` 또는 `fetch` API

## 6. 구현 예시 코드

### 6.1 모델 목록 조회 및 동적 설정 UI 업데이트

**핵심 개념:**
- 모델 목록 조회 시 각 모델에 `supported_settings`와 `default_settings`가 포함됨
- 모델 선택 시 `supported_settings`를 기반으로 UI를 동적으로 생성
- 지원하지 않는 설정은 UI에서 숨김 처리

**기본 사용 예시:**
```javascript
const fetchModels = async () => {
  try {
    const response = await axios.get('/api/tts/models');
    
    if (response.data.success) {
      // 각 모델에 supported_settings와 default_settings가 포함됨
      return response.data.data.models;
    } else {
      throw new Error(response.data.message || '모델 목록 조회 실패');
    }
  } catch (error) {
    console.error('모델 목록 조회 실패:', error);
    throw error;
  }
};
```

**React 사용 예시 (모델 선택 및 동적 설정 UI):**
```javascript
import { useState, useEffect } from 'react';
import axios from 'axios';

const TTSComponent = () => {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [settings, setSettings] = useState({});
  const [settingsSchema, setSettingsSchema] = useState({});

  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await axios.get('/api/tts/models');
        if (response.data.success) {
          const modelsList = response.data.data.models;
          setModels(modelsList);
          
          // 첫 번째 모델을 기본값으로 설정
          if (modelsList.length > 0) {
            const firstModel = modelsList[0];
            setSelectedModel(firstModel.model_id);
            // 모델의 default_settings로 초기화
            setSettings({ ...firstModel.default_settings });
            // 모델의 supported_settings로 UI 스키마 설정
            setSettingsSchema(firstModel.supported_settings);
          }
        }
      } catch (error) {
        console.error('모델 목록 조회 실패:', error);
      }
    };
    
    loadModels();
  }, []);

  // 모델 변경 시 설정 업데이트 (핵심 로직)
  const handleModelChange = (modelId) => {
    const model = models.find(m => m.model_id === modelId);
    if (model) {
      setSelectedModel(modelId);
      // 새 모델의 기본 설정으로 초기화
      setSettings({ ...model.default_settings });
      // 새 모델의 지원 설정 스키마로 UI 업데이트
      setSettingsSchema(model.supported_settings);
    }
  };

  return (
    <div>
      <label>모델 선택</label>
      <select 
        value={selectedModel} 
        onChange={(e) => handleModelChange(e.target.value)}
      >
        {models.map(model => (
          <option key={model.model_id} value={model.model_id}>
            {model.name} - {model.description}
          </option>
        ))}
      </select>
      
      {/* 동적 상세 설정 UI - supported_settings를 기반으로 자동 생성 */}
      <div className="settings-panel">
        <h3>상세 설정</h3>
        <p>선택된 모델: {models.find(m => m.model_id === selectedModel)?.name}</p>
        
        {/* 
          핵심: settingsSchema의 각 설정을 순회하며 
          supported가 true인 것만 UI에 표시
        */}
        {Object.keys(settingsSchema).map((settingKey) => {
          const setting = settingsSchema[settingKey];
          
          // 지원하지 않는 설정은 표시하지 않음
          if (!setting.supported) {
            return null;
          }
          
          // Boolean 타입 설정 (use_speaker_boost 등)
          if (setting.type === 'boolean') {
            return (
              <div key={settingKey} className="setting-item">
                <label>
                  {settingKey === 'use_speaker_boost' ? '화자 부스트 (Speaker Boost)' : settingKey}
                  <span className="tooltip" title={setting.description}>ℹ️</span>
                </label>
                <input
                  type="checkbox"
                  checked={settings[settingKey] ?? setting.default}
                  onChange={(e) => setSettings({
                    ...settings,
                    [settingKey]: e.target.checked
                  })}
                />
              </div>
            );
          }
          
          // Number 타입 설정 (stability, similarity_boost, style, speed 등)
          return (
            <div key={settingKey} className="setting-item">
              <label>
                {settingKey === 'stability' ? '안정성 (Stability)' :
                 settingKey === 'similarity_boost' ? '유사도 부스트 (Similarity Boost)' :
                 settingKey === 'style' ? '스타일 (Style) - v3 전용' :
                 settingKey === 'speed' ? '속도 (Speed)' : settingKey}
                <span className="tooltip" title={setting.description}>ℹ️</span>
              </label>
              <input
                type="range"
                min={setting.min}
                max={setting.max}
                step={settingKey === 'speed' ? '0.1' : '0.01'}
                value={settings[settingKey] ?? setting.default}
                onChange={(e) => setSettings({
                  ...settings,
                  [settingKey]: parseFloat(e.target.value)
                })}
              />
              <span>
                {settings[settingKey] ?? setting.default}
                {settingKey === 'speed' ? 'x' : ''}
              </span>
            </div>
          );
        })}
      </div>
      
      {/* 디버깅용: 현재 설정값 확인 */}
      <div style={{ marginTop: '20px', padding: '10px', background: '#f5f5f5' }}>
        <strong>현재 설정값:</strong>
        <pre>{JSON.stringify(settings, null, 2)}</pre>
      </div>
    </div>
  );
};
```

**동작 예시:**
1. **eleven_multilingual_v2 선택 시:**
   - `stability`, `similarity_boost`, `use_speaker_boost`, `speed` 표시
   - `style`은 `supported: false`이므로 숨김

2. **eleven_v3 선택 시:**
   - `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed` 모두 표시
   - `style`이 `supported: true`이므로 표시됨

**모델별 설정 조회 API 사용 예시 (선택적):**
```javascript
// 주의: 모델 목록 조회 시 이미 supported_settings와 default_settings가 포함되므로
// 별도 API 호출은 일반적으로 필요하지 않습니다.
// 하지만 필요시 사용할 수 있습니다:

const handleModelChangeWithAPI = async (modelId) => {
  try {
    // 방법 1: 모델 목록에서 이미 가져온 정보 사용 (권장, 네트워크 요청 없음)
    const model = models.find(m => m.model_id === modelId);
    if (model) {
      setSettings({ ...model.default_settings });
      setSettingsSchema(model.supported_settings);
      return;
    }
    
    // 방법 2: 별도 API 호출 (모델 목록에 없는 경우나 최신 정보가 필요한 경우)
    const response = await axios.get(`/api/tts/models/${modelId}/settings`);
    if (response.data.success) {
      setSettings({ ...response.data.data.defaultSettings });
      setSettingsSchema(response.data.data.settingsSchema);
    }
  } catch (error) {
    console.error('모델 설정 조회 실패:', error);
  }
};
```

**권장 사용 패턴:**
- ✅ 모델 목록 조회 시 `supported_settings`와 `default_settings`를 함께 받아서 사용
- ✅ 모델 변경 시 별도 API 호출 없이 이미 받은 데이터로 UI 업데이트
- ✅ 네트워크 요청 최소화로 성능 향상

**Vue 사용 예시 (모델 선택 및 동적 설정 UI):**
```javascript
<template>
  <div>
    <label>모델 선택</label>
    <select v-model="selectedModel" @change="handleModelChange">
      <option 
        v-for="model in models" 
        :key="model.model_id" 
        :value="model.model_id"
      >
        {{ model.name }} - {{ model.description }}
      </option>
    </select>
    
    <!-- 동적 상세 설정 UI - supported_settings를 기반으로 자동 생성 -->
    <div class="settings-panel">
      <h3>상세 설정</h3>
      <p>선택된 모델: {{ getSelectedModelName() }}</p>
      
      <!-- 
        핵심: settingsSchema의 각 설정을 순회하며 
        supported가 true인 것만 UI에 표시
      -->
      <div 
        v-for="(setting, settingKey) in settingsSchema" 
        :key="settingKey"
        v-show="setting.supported"
        class="setting-item"
      >
        <!-- Boolean 타입 설정 (use_speaker_boost 등) -->
        <template v-if="setting.type === 'boolean'">
          <label>
            {{ getSettingLabel(settingKey) }}
            <span class="tooltip" :title="setting.description">ℹ️</span>
          </label>
          <input
            type="checkbox"
            v-model="settings[settingKey]"
          />
        </template>
        
        <!-- Number 타입 설정 (stability, similarity_boost, style, speed 등) -->
        <template v-else>
          <label>
            {{ getSettingLabel(settingKey) }}
            <span class="tooltip" :title="setting.description">ℹ️</span>
          </label>
          <input
            type="range"
            :min="setting.min"
            :max="setting.max"
            :step="settingKey === 'speed' ? '0.1' : '0.01'"
            v-model.number="settings[settingKey]"
          />
          <span>
            {{ settings[settingKey] }}{{ settingKey === 'speed' ? 'x' : '' }}
          </span>
        </template>
      </div>
    </div>
    
    <!-- 디버깅용: 현재 설정값 확인 -->
    <div style="margin-top: 20px; padding: 10px; background: #f5f5f5;">
      <strong>현재 설정값:</strong>
      <pre>{{ JSON.stringify(settings, null, 2) }}</pre>
    </div>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      models: [],
      selectedModel: '',
      settings: {},
      settingsSchema: {}
    };
  },
  async mounted() {
    try {
      const response = await axios.get('/api/tts/models');
      if (response.data.success) {
        this.models = response.data.data.models;
        if (this.models.length > 0) {
          const firstModel = this.models[0];
          this.selectedModel = firstModel.model_id;
          // 모델의 default_settings로 초기화
          this.settings = { ...firstModel.default_settings };
          // 모델의 supported_settings로 UI 스키마 설정
          this.settingsSchema = firstModel.supported_settings;
        }
      }
    } catch (error) {
      console.error('모델 목록 조회 실패:', error);
    }
  },
  methods: {
    // 모델 변경 시 설정 업데이트 (핵심 로직)
    handleModelChange() {
      const model = this.models.find(m => m.model_id === this.selectedModel);
      if (model) {
        // 새 모델의 기본 설정으로 초기화
        this.settings = { ...model.default_settings };
        // 새 모델의 지원 설정 스키마로 UI 업데이트
        this.settingsSchema = model.supported_settings;
      }
    },
    // 선택된 모델 이름 가져오기
    getSelectedModelName() {
      const model = this.models.find(m => m.model_id === this.selectedModel);
      return model ? model.name : '';
    },
    // 설정 키를 한국어 라벨로 변환
    getSettingLabel(settingKey) {
      const labels = {
        'stability': '안정성 (Stability)',
        'similarity_boost': '유사도 부스트 (Similarity Boost)',
        'style': '스타일 (Style) - v3 전용',
        'use_speaker_boost': '화자 부스트 (Speaker Boost)',
        'speed': '속도 (Speed)'
      };
      return labels[settingKey] || settingKey;
    }
  }
};
</script>
```

**동작 예시:**
1. **eleven_multilingual_v2 선택 시:**
   - `stability`, `similarity_boost`, `use_speaker_boost`, `speed` 표시
   - `style`은 `supported: false`이므로 `v-show="setting.supported"`로 인해 숨김

2. **eleven_v3 선택 시:**
   - `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed` 모두 표시
   - `style`이 `supported: true`이므로 표시됨

### 6.2 음성 생성 API 호출
```javascript
const generateTTS = async (voiceId, modelId, text, settings) => {
  try {
    const response = await axios.post('/api/tts/generate', {
      voiceId,
      modelId,
      text,
      settings
    });
    
    return response.data;
  } catch (error) {
    console.error('음성 생성 실패:', error);
    throw error;
  }
};
```

### 6.3 오디오 재생 및 타임스탬프 동기화
```javascript
const [currentTime, setCurrentTime] = useState(0);
const audioRef = useRef(null);

useEffect(() => {
  const audio = audioRef.current;
  
  const updateTime = () => {
    setCurrentTime(audio.currentTime);
  };
  
  audio.addEventListener('timeupdate', updateTime);
  
  return () => {
    audio.removeEventListener('timeupdate', updateTime);
  };
}, []);

// 현재 재생 중인 단어 찾기
const currentWord = timestamps.words.find(
  word => currentTime >= word.start && currentTime <= word.end
);
```

### 6.4 워드 하이라이팅 렌더링
```javascript
const renderTextWithHighlight = (text, timestamps, currentTime) => {
  return timestamps.words.map((word, index) => {
    const isActive = currentTime >= word.start && currentTime <= word.end;
    return (
      <span
        key={index}
        style={{
          backgroundColor: isActive ? 'yellow' : 'transparent',
          transition: 'background-color 0.1s'
        }}
      >
        {word.word}{' '}
      </span>
    );
  });
};
```

## 7. 에러 처리

### 7.1 주요 에러 케이스
1. **네트워크 에러**: 재시도 버튼 제공
2. **인증 에러**: 로그인 페이지로 리다이렉트
3. **API 에러**: 사용자 친화적인 에러 메시지 표시
4. **오디오 로드 실패**: 재시도 또는 에러 메시지

### 7.2 에러 메시지 예시
- "음성 생성에 실패했습니다. 다시 시도해주세요."
- "인증이 만료되었습니다. 다시 로그인해주세요."
- "오디오 파일을 불러올 수 없습니다."

## 8. 성능 최적화

1. **오디오 파일 캐싱**: 생성된 오디오는 브라우저 캐시 활용
2. **파형 데이터 캐싱**: 한 번 분석한 파형 데이터는 메모리에 저장
3. **목소리 목록 캐싱**: 자주 조회되는 목소리 목록은 캐싱
4. **이미지/아이콘 최적화**: Lazy loading 적용

## 9. 접근성 (Accessibility)

1. **키보드 네비게이션**: 모든 인터랙티브 요소에 키보드 접근 가능
2. **스크린 리더 지원**: ARIA 라벨 추가
3. **색상 대비**: WCAG AA 기준 준수
4. **포커스 표시**: 명확한 포커스 인디케이터

## 10. 모델별 설정 동적 UI 구현 가이드

### 10.1 핵심 개념

**백엔드에서 제공하는 데이터:**
- `GET /api/tts/models` API 응답에 각 모델마다 다음 정보가 포함됨:
  - `supported_settings`: 각 설정의 지원 여부, 기본값, 범위, 설명
  - `default_settings`: 모델별 기본 설정값 객체
  - `can_use_style`: style 파라미터 지원 여부
  - `can_use_speaker_boost`: speaker boost 지원 여부

**프론트엔드 구현 원칙:**
- 모델 목록 조회 시 `supported_settings`와 `default_settings`를 함께 받아서 저장
- 모델 선택 시 해당 모델의 `supported_settings`를 기반으로 UI를 동적으로 생성/업데이트
- `supported: true`인 설정만 UI에 표시
- 모델 변경 시 `default_settings`로 설정값 초기화
- 지원하지 않는 설정은 UI에서 자동으로 숨김 처리

### 10.2 구현 단계

1. **모델 목록 조회 및 초기화**
   ```javascript
   // 모델 목록 조회 시 각 모델의 supported_settings와 default_settings 포함
   const models = await fetchModels();
   const firstModel = models[0];
   setSettings(firstModel.default_settings);
   setSettingsSchema(firstModel.supported_settings);
   ```

2. **모델 변경 시 설정 업데이트**
   ```javascript
   const handleModelChange = (modelId) => {
     const model = models.find(m => m.model_id === modelId);
     setSettings(model.default_settings);
     setSettingsSchema(model.supported_settings);
   };
   ```

3. **동적 설정 UI 렌더링**
   ```javascript
   // 각 설정을 조건부로 렌더링
   {settingsSchema.stability?.supported && (
     <Slider
       value={settings.stability}
       min={settingsSchema.stability.min}
       max={settingsSchema.stability.max}
       onChange={(value) => setSettings({...settings, stability: value})}
     />
   )}
   ```

### 10.3 주의사항
- 모델이 지원하지 않는 설정을 전달해도 백엔드에서 자동으로 필터링되지만, 프론트엔드에서도 필터링하는 것이 권장됩니다.
- `style` 파라미터는 `can_use_style: true`인 모델에서만 사용 가능합니다.
- `use_speaker_boost`는 `can_use_speaker_boost: true`인 모델에서만 사용 가능합니다.
- 모델 변경 시 이전 모델의 설정값을 그대로 사용하지 말고, 새 모델의 `default_settings`로 초기화하는 것이 좋습니다.

## 11. 테스트 체크리스트

- [ ] 목소리 선택 기능
- [ ] 모델 선택 기능
- [ ] 모델 변경 시 상세 설정 UI 동적 업데이트
- [ ] 모델별 지원 설정만 UI에 표시 (style, use_speaker_boost 등)
- [ ] 텍스트 입력 및 감정 표현 처리
- [ ] 상세 설정 변경
- [ ] 음성 생성 API 호출
- [ ] 생성 결과 표시
- [ ] 오디오 재생/일시정지
- [ ] 파형 시각화
- [ ] 워드 하이라이팅
- [ ] 여러 생성 결과 비교
- [ ] S3 경로 입력 및 저장
- [ ] 임시 데이터 삭제
- [ ] 저장된 파일 목록 조회
- [ ] 저장된 파일 삭제
- [ ] 에러 처리
- [ ] 로딩 상태 표시

---

## 12. 빠른 시작 가이드: 모델별 동적 설정 UI 구현

### 12.1 전체 흐름 요약

```
1. 모델 목록 조회
   GET /api/tts/models
   ↓
   각 모델에 supported_settings, default_settings 포함

2. 모델 선택
   사용자가 드롭다운에서 모델 선택
   ↓
   선택된 모델의 supported_settings 확인
   ↓
   지원하는 설정만 UI에 표시 (동적 생성)
   ↓
   default_settings로 설정값 초기화

3. 설정 변경
   사용자가 슬라이더/체크박스로 설정 변경
   ↓
   settings 객체 업데이트

4. 음성 생성
   POST /api/tts/generate
   ↓
   settings 객체 전달 (모델이 지원하는 설정만 자동 필터링)
```

### 12.2 최소 구현 코드 (React)

```javascript
import { useState, useEffect } from 'react';
import axios from 'axios';

function TTSComponent() {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [settings, setSettings] = useState({});
  const [settingsSchema, setSettingsSchema] = useState({});

  // 1. 모델 목록 조회
  useEffect(() => {
    axios.get('/api/tts/models').then(res => {
      if (res.data.success) {
        setModels(res.data.data.models);
        if (res.data.data.models.length > 0) {
          const first = res.data.data.models[0];
          setSelectedModel(first.model_id);
          setSettings(first.default_settings);
          setSettingsSchema(first.supported_settings);
        }
      }
    });
  }, []);

  // 2. 모델 변경 핸들러
  const handleModelChange = (modelId) => {
    const model = models.find(m => m.model_id === modelId);
    if (model) {
      setSelectedModel(modelId);
      setSettings({ ...model.default_settings });
      setSettingsSchema(model.supported_settings);
    }
  };

  // 3. 동적 설정 UI 렌더링
  return (
    <div>
      <select value={selectedModel} onChange={(e) => handleModelChange(e.target.value)}>
        {models.map(m => (
          <option key={m.model_id} value={m.model_id}>{m.name}</option>
        ))}
      </select>
      
      {/* 지원하는 설정만 동적으로 표시 */}
      {Object.keys(settingsSchema).map(key => {
        const setting = settingsSchema[key];
        if (!setting.supported) return null;
        
        return setting.type === 'boolean' ? (
          <label key={key}>
            <input type="checkbox" checked={settings[key]} 
              onChange={e => setSettings({...settings, [key]: e.target.checked})} />
            {key}
          </label>
        ) : (
          <div key={key}>
            <label>{key}: {settings[key]}</label>
            <input type="range" min={setting.min} max={setting.max} step="0.01"
              value={settings[key]} 
              onChange={e => setSettings({...settings, [key]: parseFloat(e.target.value)})} />
          </div>
        );
      })}
    </div>
  );
}
```

### 12.3 주요 포인트

✅ **백엔드가 제공하는 것:**
- 모델 목록 조회 시 각 모델의 `supported_settings` (설정 스키마)
- 모델 목록 조회 시 각 모델의 `default_settings` (기본값)

✅ **프론트엔드가 해야 할 것:**
- 모델 선택 시 `supported_settings`를 기반으로 UI 동적 생성
- 모델 선택 시 `default_settings`로 설정값 초기화
- `supported: false`인 설정은 UI에서 숨김

✅ **장점:**
- 모델별로 다른 설정 UI 자동 생성
- 새로운 모델 추가 시 프론트엔드 코드 수정 불필요
- 백엔드에서 모델 지원 정보를 중앙 관리

---

**이 문서를 기반으로 프론트엔드 개발을 진행하세요.**
**추가 질문이나 명확화가 필요한 부분이 있으면 백엔드 개발팀에 문의하세요.**

