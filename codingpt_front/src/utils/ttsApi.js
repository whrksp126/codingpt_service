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

/**
 * ElevenLabs 모델 목록 조회 (인증 불필요)
 */
export const getModels = async () => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/models`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '모델 목록 조회에 실패했습니다.');
    }

    return await response.json();
  } catch (error) {
    console.error('모델 목록 조회 실패:', error);
    throw error;
  }
};

/**
 * ElevenLabs 목소리 목록 조회
 */
export const getVoices = async () => {
  try {
    const response = await fetch(`${backendUrl}/api/tts/voices`, {
      method: 'GET',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || '목소리 목록 조회에 실패했습니다.');
    }

    return await response.json();
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

