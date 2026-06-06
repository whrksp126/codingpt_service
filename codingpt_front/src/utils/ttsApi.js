import { backendUrl } from './common.js';

/**
 * TTS API 유틸리티 함수들
 */

// 인증 토큰 가져오기 (localStorage 또는 다른 저장소에서)
const getAuthToken = () => {
  return localStorage.getItem('auth_token') || '';
};

// API 요청 헤더 생성
const getHeaders = () => {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
  };
};

// 모듈 레벨 캐시 — 목소리/모델은 거의 안 바뀌므로 최초 1회만 호출하고 재사용.
let _modelsCache = null;
let _voicesCache = null;

/**
 * ElevenLabs 모델 목록 조회 (인증 불필요). 성공 결과는 캐시.
 */
export const getModels = async ({ force = false } = {}) => {
  if (_modelsCache && !force) return _modelsCache;
  try {
    const response = await fetch(`${backendUrl}/api/tts/models`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '모델 목록 조회에 실패했습니다.');
    }
    _modelsCache = await response.json();
    return _modelsCache;
  } catch (error) {
    console.error('모델 목록 조회 실패:', error);
    throw error;
  }
};

/**
 * ElevenLabs 목소리 목록 조회. 성공 결과는 캐시(force 로 갱신).
 */
export const getVoices = async ({ force = false } = {}) => {
  if (_voicesCache && !force) return _voicesCache;
  try {
    const response = await fetch(`${backendUrl}/api/tts/voices`, {
      method: 'GET',
      headers: getHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '목소리 목록 조회에 실패했습니다.');
    }
    _voicesCache = await response.json();
    return _voicesCache;
  } catch (error) {
    console.error('목소리 목록 조회 실패:', error);
    throw error;
  }
};

/**
 * 음성 생성 요청
 * 문서 업데이트: sessionId 파라미터 제거됨
 */
export const generateTTS = async (voiceId, modelId, text, settings) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/generate`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        voiceId,
        modelId,
        text,
        settings,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '음성 생성에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('음성 생성 실패:', error);
    throw error;
  }
};

/**
 * 세션별 생성 목록 조회
 * 문서 업데이트: 세션 관리가 제거되어 더 이상 사용되지 않음
 * 여러 생성 결과는 컴포넌트 상태로 관리
 * @deprecated 세션 기반 API가 제거됨
 */
/*
export const getSessionRequests = async (sessionId) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/session/${sessionId}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (!response.ok) {
      // 400 에러는 세션이 존재하지 않는 경우이므로 빈 배열 반환 (에러 아님)
      if (response.status === 400) {
        console.log('세션이 존재하지 않습니다. 빈 배열로 시작합니다.');
        return {
          success: true,
          data: {
            sessionId,
            requests: [],
          },
        };
      }
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '생성 목록 조회에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    // 네트워크 에러인 경우에도 빈 배열 반환 (에러를 던지지 않음)
    if (error.message && error.message.includes('Failed to fetch')) {
      console.log('네트워크 에러 발생. 빈 배열로 시작합니다.');
      return {
        success: true,
        data: {
          sessionId,
          requests: [],
        },
      };
    }
    // 기타 에러는 그대로 던짐
    console.error('생성 목록 조회 실패:', error);
    throw error;
  }
};
*/

/**
 * 임시 생성 데이터 삭제
 */
export const deleteRequest = async (requestId) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/request/${requestId}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '삭제에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('삭제 실패:', error);
    throw error;
  }
};

/**
 * 최종 저장
 */
export const saveTTS = async (requestId, s3Path, customFileName = null) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/save`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        requestId,
        s3Path,
        ...(customFileName && { customFileName }),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '저장에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('저장 실패:', error);
    throw error;
  }
};

/**
 * 저장된 파일 목록 조회
 */
export const getSavedFiles = async (page = 1, limit = 20) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/saved?page=${page}&limit=${limit}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '저장된 파일 목록 조회에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('저장된 파일 목록 조회 실패:', error);
    throw error;
  }
};

// ───────────────────────────────────────────────
// 중앙 관리형 TTS 자산 라이브러리 (/api/tts/assets)
// ───────────────────────────────────────────────

/** 자산 생성 (생성 + objectstore 영구저장 1단계) */
export const createAsset = async ({ text, voiceId, modelId, settings, folder }) => {
  const response = await fetch(`${backendUrl}/api/tts/assets`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ text, voiceId, modelId, settings, folder }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '자산 생성에 실패했습니다.');
  return data;
};

/** 자산 목록 (사용처 포함) */
export const listAssets = async ({ search = '', page = 1, limit = 50 } = {}) => {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  params.set('page', page);
  params.set('limit', limit);
  const response = await fetch(`${backendUrl}/api/tts/assets?${params.toString()}`, {
    method: 'GET',
    headers: getHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '자산 목록 조회에 실패했습니다.');
  return data;
};

/** 자산 단건 조회 */
export const getAsset = async (id) => {
  const response = await fetch(`${backendUrl}/api/tts/assets/${id}`, {
    method: 'GET',
    headers: getHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '자산 조회에 실패했습니다.');
  return data;
};

/** 자산 수정 (재생성 → 같은 키 덮어쓰기 → 참조 레슨 자동 반영) */
export const updateAsset = async (id, { text, voiceId, modelId, settings }) => {
  const response = await fetch(`${backendUrl}/api/tts/assets/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ text, voiceId, modelId, settings }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '자산 수정에 실패했습니다.');
  return data;
};

/** 자산 삭제 (force=true 면 사용 중이어도 강제). 사용 중(409) 시 { conflict:true, usage } 반환 */
export const deleteAsset = async (id, force = false) => {
  const response = await fetch(`${backendUrl}/api/tts/assets/${id}${force ? '?force=1' : ''}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409) {
    return { conflict: true, message: data.message, usage: data.usage || [] };
  }
  if (!response.ok) throw new Error(data.message || '삭제에 실패했습니다.');
  return data;
};

/**
 * 모델별 설정 정보 조회 (인증 불필요)
 */
export const getModelSettings = async (modelId) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/models/${modelId}/settings`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '모델 설정 조회에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('모델 설정 조회 실패:', error);
    throw error;
  }
};

/**
 * 저장된 파일 삭제
 */
export const deleteSavedFile = async (savedFileId) => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/saved/${savedFileId}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '삭제에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('삭제 실패:', error);
    throw error;
  }
};

