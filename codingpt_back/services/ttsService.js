const axios = require('axios');

/**
 * ElevenLabs API 통합 서비스
 */
class TTSService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.apiUrl = process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io/v1';

    if (!this.apiKey) {
      console.warn('[TTSService] ELEVENLABS_API_KEY 환경 변수가 설정되지 않았습니다.');
    }
  }

  /**
   * ElevenLabs API 요청 헤더 생성
   */
  getHeaders() {
    return {
      'xi-api-key': this.apiKey,
      'Content-Type': 'application/json'
    };
  }

  /**
   * 모델별 지원 설정 정보를 동적으로 생성
   * @param {Object} model - 모델 객체 (can_use_style, can_use_speaker_boost 포함)
   * @returns {Object} - 모델별 설정 스키마
   */
  generateModelSettingsSchema(model) {
    const settings = {
      stability: {
        supported: true,
        default: 0.5,
        min: 0.0,
        max: 1.0,
        description: '음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)'
      },
      similarity_boost: {
        supported: true,
        default: 0.75,
        min: 0.0,
        max: 1.0,
        description: '원본 목소리와의 유사도 (높을수록 유사)'
      },
      use_speaker_boost: {
        supported: model.can_use_speaker_boost === true,
        default: true,
        type: 'boolean',
        description: '화자 부스트 활성화'
      },
      speed: {
        supported: true,
        default: 1.0,
        min: 0.25,
        max: 4.0,
        description: '음성 속도 (높을수록 빠름)'
      }
    };

    // style 파라미터는 can_use_style이 true인 모델에서만 지원
    if (model.can_use_style === true) {
      settings.style = {
        supported: true,
        default: 0.0,
        min: 0.0,
        max: 1.0,
        description: '음성의 스타일 강도 (v3 모델 전용)'
      };
    } else {
      settings.style = {
        supported: false,
        description: '이 모델에서는 지원하지 않습니다'
      };
    }

    return settings;
  }

  /**
   * 사용 가능한 모델 목록 조회 (eleven_v3 고정값 반환)
   * @returns {Promise<Object>} - 모델 목록
   */
  async getModels() {
    try {
      // eleven_v3 모델만 고정값으로 반환 (API 호출 없이 빠른 응답)
      const elevenV3Model = {
        model_id: 'eleven_v3',
        name: 'Eleven v3',
        description: '최신 고급 음성 합성 모델, 높은 감정 범위와 컨텍스트 이해력',
        language_support: '70개 이상',
        quality: '매우 높음',
        speed: '보통',
        character_limit: 5000,
        can_use_style: true,
        can_use_speaker_boost: true,
        supported_settings: {
          stability: {
            supported: true,
            default: 0.5,
            min: 0.0,
            max: 1.0,
            description: '음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)'
          },
          similarity_boost: {
            supported: true,
            default: 0.75,
            min: 0.0,
            max: 1.0,
            description: '원본 목소리와의 유사도 (높을수록 유사)'
          },
          use_speaker_boost: {
            supported: true,
            default: true,
            type: 'boolean',
            description: '화자 부스트 활성화'
          },
          speed: {
            supported: true,
            default: 1.0,
            min: 0.25,
            max: 4.0,
            description: '음성 속도 (높을수록 빠름)'
          },
          style: {
            supported: true,
            default: 0.0,
            min: 0.0,
            max: 1.0,
            description: '음성의 스타일 강도 (v3 모델 전용)'
          }
        },
        default_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          use_speaker_boost: true,
          speed: 1.0,
          style: 0.0
        }
      };

      return {
        success: true,
        models: [elevenV3Model]
      };
    } catch (error) {
      console.error('[TTSService] 모델 목록 조회 실패:', error.message);

      return {
        success: false,
        error: 'ModelListError',
        message: error.message || '모델 목록을 가져오는데 실패했습니다.'
      };
    }
  }

  /**
   * 특정 모델의 지원 설정 정보 조회
   * @param {string} modelId - 모델 ID
   * @returns {Promise<Object>} - 모델 설정 스키마
   */
  async getModelSettings(modelId) {
    try {
      if (!modelId) {
        throw new Error('modelId는 필수입니다.');
      }

      // eleven_v3만 지원하므로 고정값 반환
      if (modelId !== 'eleven_v3') {
        return {
          success: false,
          error: 'ModelNotFound',
          message: `모델 '${modelId}'를 찾을 수 없습니다. 지원되는 모델: eleven_v3`
        };
      }

      // eleven_v3 모델 설정 스키마 (고정값)
      const settingsSchema = {
        stability: {
          supported: true,
          default: 0.5,
          min: 0.0,
          max: 1.0,
          description: '음성의 안정성과 일관성 (낮을수록 안정적, 높을수록 창의적)'
        },
        similarity_boost: {
          supported: true,
          default: 0.75,
          min: 0.0,
          max: 1.0,
          description: '원본 목소리와의 유사도 (높을수록 유사)'
        },
        use_speaker_boost: {
          supported: true,
          default: true,
          type: 'boolean',
          description: '화자 부스트 활성화'
        },
        speed: {
          supported: true,
          default: 1.0,
          min: 0.25,
          max: 4.0,
          description: '음성 속도 (높을수록 빠름)'
        },
        style: {
          supported: true,
          default: 0.0,
          min: 0.0,
          max: 1.0,
          description: '음성의 스타일 강도 (v3 모델 전용)'
        }
      };

      const defaultSettings = {
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: true,
        speed: 1.0,
        style: 0.0
      };

      return {
        success: true,
        modelId: 'eleven_v3',
        modelName: 'Eleven v3',
        settingsSchema,
        defaultSettings
      };
    } catch (error) {
      console.error('[TTSService] 모델 설정 조회 실패:', error.message);
      return {
        success: false,
        error: 'ModelSettingsError',
        message: error.message || '모델 설정을 조회하는데 실패했습니다.'
      };
    }
  }

  /**
   * 목소리 목록 조회 (사용자가 선택/저장한 목소리만)
   * @returns {Promise<Object>} - 선택된 목소리 목록
   */
  async getVoices() {
    try {
      if (!this.apiKey) {
        throw new Error('ELEVENLABS_API_KEY가 설정되지 않았습니다.');
      }

      const response = await axios.get(`${this.apiUrl}/voices`, {
        headers: this.getHeaders()
      });

      const allVoices = response.data.voices || [];

      // 사용자가 선택/저장한 목소리만 필터링
      // API 응답 구조에 따라 다음 필드들을 확인:
      // - is_favorite: 즐겨찾기 여부
      // - is_custom: 커스텀 목소리 여부
      // - category: 'premade'가 아닌 것들 (사용자가 생성한 목소리)
      // 또는 사용자가 생성한 목소리만 (category가 없거나 'custom'인 것들)
      const selectedVoices = allVoices.filter(voice => {
        // 1. 즐겨찾기된 목소리
        if (voice.is_favorite === true) {
          return true;
        }

        // 2. 사용자가 생성한 커스텀 목소리 (category가 'premade'가 아닌 것)
        if (voice.category && voice.category !== 'premade') {
          return true;
        }

        // 3. category가 없으면 사용자 계정에 등록된 목소리로 간주
        // (API 키와 연동된 계정의 목소리만 반환되므로)
        // 기본 제공 목소리(premade)는 제외
        return !voice.category || voice.category !== 'premade';
      });

      return {
        success: true,
        voices: selectedVoices
      };
    } catch (error) {
      console.error('[TTSService] 목소리 목록 조회 실패:', error.message);

      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.detail?.message || error.response.data?.detail || '목소리 목록을 가져오는데 실패했습니다.';

        return {
          success: false,
          error: 'ElevenLabsAPIError',
          status,
          message
        };
      }

      return {
        success: false,
        error: 'NetworkError',
        message: error.message || '네트워크 오류가 발생했습니다.'
      };
    }
  }

  /**
   * 텍스트를 음성으로 변환
   * @param {string} voiceId - 목소리 ID
   * @param {string} text - 변환할 텍스트
   * @param {string} modelId - 모델 ID
   * @param {Object} settings - 추가 설정
   * @returns {Promise<Object>} - 오디오 데이터와 타임스탬프
   */
  async textToSpeech(voiceId, text, modelId = 'eleven_multilingual_v2', settings = {}) {
    try {
      if (!this.apiKey) {
        throw new Error('ELEVENLABS_API_KEY가 설정되지 않았습니다.');
      }

      if (!voiceId || !text) {
        throw new Error('voiceId와 text는 필수입니다.');
      }

      // 모델 정보 조회하여 지원하는 설정만 필터링
      const modelSettingsResult = await this.getModelSettings(modelId);
      let validSettings = {};

      if (modelSettingsResult.success) {
        const settingsSchema = modelSettingsResult.settingsSchema;
        const defaultSettings = modelSettingsResult.defaultSettings;

        // 지원하는 설정만 포함
        Object.keys(settings).forEach(key => {
          if (settingsSchema[key] && settingsSchema[key].supported) {
            validSettings[key] = settings[key];
          }
        });

        // 기본값으로 병합
        validSettings = { ...defaultSettings, ...validSettings };
      } else {
        // 모델 정보를 가져올 수 없는 경우 기본 설정 사용
        const defaultSettings = {
          stability: 0.5,
          similarity_boost: 0.75,
          use_speaker_boost: true
        };
        validSettings = { ...defaultSettings, ...settings };
      }

      // 요청 본문 구성
      const requestBody = {
        text,
        model_id: modelId,
        voice_settings: validSettings
      };

      // 모델별 파라미터 구성
      // eleven_v3 모델은 optimize_streaming_latency를 지원하지 않음
      const params = {
        output_format: 'mp3_44100_128',
        enable_logging: false
      };

      // optimize_streaming_latency는 v3 모델이 아닌 경우에만 추가
      if (modelId !== 'eleven_v3') {
        params.optimize_streaming_latency = 0;
      }

      // 타임스탬프를 포함한 요청 - with-timestamps 엔드포인트 사용
      const response = await axios.post(
        `${this.apiUrl}/text-to-speech/${voiceId}/with-timestamps`,
        requestBody,
        {
          headers: {
            ...this.getHeaders(),
            'Accept': 'application/json'
          },
          params
        }
      );

      // 응답에서 오디오(base64)와 타임스탬프 추출
      const responseData = response.data;
      let audioBuffer;
      let timestamps = null;

      if (responseData.audio_base64) {
        // base64 인코딩된 오디오를 버퍼로 변환
        audioBuffer = Buffer.from(responseData.audio_base64, 'base64');
      } else {
        // fallback: 일반 엔드포인트 사용 (타임스탬프 없음)
        const audioResponse = await axios.post(
          `${this.apiUrl}/text-to-speech/${voiceId}`,
          requestBody,
          {
            headers: {
              ...this.getHeaders(),
              'Accept': 'audio/mpeg'
            },
            params,
            responseType: 'arraybuffer'
          }
        );
        audioBuffer = Buffer.from(audioResponse.data);
      }

      // 타임스탬프 데이터 파싱
      let duration = 0;
      if (responseData.alignment) {
        const alignment = responseData.alignment;

        // ElevenLabs API 응답 형식에 맞게 변환
        timestamps = {
          version: '1.0',
          alignment: {
            characters: [],
            words: []
          }
        };

        // 문자 단위 타임스탬프
        if (alignment.characters && alignment.character_start_times_seconds && alignment.character_end_times_seconds) {
          timestamps.alignment.characters = alignment.characters.map((char, index) => ({
            char: char,
            start: alignment.character_start_times_seconds[index] || 0,
            end: alignment.character_end_times_seconds[index] || 0
          }));

          // 마지막 문자 종료 시간을 총 길이로 설정
          if (alignment.character_end_times_seconds.length > 0) {
            duration = alignment.character_end_times_seconds[alignment.character_end_times_seconds.length - 1];
            timestamps.total_duration = duration;
          }
        }

        // 단어 단위 타임스탬프 (API에서 제공하는 경우)
        if (alignment.words && alignment.word_start_times_seconds && alignment.word_end_times_seconds) {
          timestamps.alignment.words = alignment.words.map((word, index) => ({
            word: word,
            start: alignment.word_start_times_seconds[index] || 0,
            end: alignment.word_end_times_seconds[index] || 0,
            confidence: 1.0 // 기본값
          }));
        } else if (timestamps.alignment.characters.length > 0) {
          // API에서 단어 정보가 없는 경우, 문자 배열에서 단어 추출
          // 공백을 기준으로 단어를 구분
          const characters = timestamps.alignment.characters;
          const words = [];
          let currentWord = '';
          let wordStart = null;
          let wordEnd = null;

          for (let i = 0; i < characters.length; i++) {
            const char = characters[i];

            // 공백이면 단어 종료
            if (char.char.trim() === '') {
              if (currentWord.trim() && wordStart !== null) {
                words.push({
                  word: currentWord.trim(),
                  start: wordStart,
                  end: wordEnd || char.end,
                  confidence: 1.0
                });
                currentWord = '';
                wordStart = null;
                wordEnd = null;
              }
            } else {
              // 일반 문자 - 단어에 추가
              if (wordStart === null) {
                wordStart = char.start;
              }
              currentWord += char.char;
              wordEnd = char.end;
            }
          }

          // 마지막 단어 추가 (공백으로 끝나지 않은 경우)
          if (currentWord.trim() && wordStart !== null) {
            words.push({
              word: currentWord.trim(),
              start: wordStart,
              end: wordEnd || characters[characters.length - 1]?.end || 0,
              confidence: 1.0
            });
          }

          timestamps.alignment.words = words;
        }
      }

      return {
        success: true,
        audioBuffer,
        audioSize: audioBuffer.length,
        timestamps,
        duration
      };
    } catch (error) {
      console.error('[TTSService] 음성 생성 실패:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        voiceId,
        modelId,
        textLength: text?.length
      });

      if (error.response) {
        const status = error.response.status;
        let message = '음성 생성에 실패했습니다.';

        // 응답 데이터 파싱 (Buffer인 경우 JSON으로 변환)
        let responseData = error.response.data;
        if (Buffer.isBuffer(responseData)) {
          try {
            responseData = JSON.parse(responseData.toString());
          } catch (e) {
            // 파싱 실패 시 그대로 사용
          }
        }

        if (status === 401) {
          message = 'API 키가 유효하지 않습니다.';
        } else if (status === 429) {
          message = 'API 할당량을 초과했습니다. 잠시 후 다시 시도해주세요.';
        } else if (responseData?.detail) {
          const detail = responseData.detail;
          if (typeof detail === 'string') {
            message = detail;
          } else if (detail.message) {
            message = detail.message;
          } else if (detail.status) {
            message = detail.message || `오류: ${detail.status}`;
          }
        } else if (responseData?.message) {
          // responseData에 직접 message가 있는 경우
          message = responseData.message;
        } else if (responseData) {
          // 응답 데이터가 있으면 그대로 사용
          if (typeof responseData === 'string') {
            message = responseData;
          } else if (typeof responseData === 'object') {
            // 객체인 경우 JSON 문자열로 변환하거나 주요 필드 추출
            message = responseData.message || responseData.error || JSON.stringify(responseData);
          } else {
            message = String(responseData);
          }
        }

        return {
          success: false,
          error: 'ElevenLabsAPIError',
          status,
          message
        };
      }

      return {
        success: false,
        error: 'NetworkError',
        message: error.message || '네트워크 오류가 발생했습니다.'
      };
    }
  }

  /**
   * 타임스탬프 포함 텍스트-음성 변환 (v3 알파 모델용)
   * @param {string} voiceId - 목소리 ID
   * @param {string} text - 변환할 텍스트
   * @param {string} modelId - 모델 ID
   * @param {Object} settings - 추가 설정
   * @returns {Promise<Object>} - 오디오 데이터와 타임스탬프
   */
  async textToSpeechWithTimestamps(voiceId, text, modelId = 'eleven_multilingual_v2', settings = {}) {
    try {
      if (!this.apiKey) {
        throw new Error('ELEVENLABS_API_KEY가 설정되지 않았습니다.');
      }

      // 모델 정보 조회하여 지원하는 설정만 필터링
      const modelSettingsResult = await this.getModelSettings(modelId);
      let validSettings = {};

      if (modelSettingsResult.success) {
        const settingsSchema = modelSettingsResult.settingsSchema;
        const defaultSettings = modelSettingsResult.defaultSettings;

        // 지원하는 설정만 포함
        Object.keys(settings).forEach(key => {
          if (settingsSchema[key] && settingsSchema[key].supported) {
            validSettings[key] = settings[key];
          }
        });

        // 기본값으로 병합
        validSettings = { ...defaultSettings, ...validSettings };
      } else {
        // 모델 정보를 가져올 수 없는 경우 기본 설정 사용
        const defaultSettings = {
          stability: 0.5,
          similarity_boost: 0.75,
          use_speaker_boost: true
        };
        validSettings = { ...defaultSettings, ...settings };
      }

      const requestBody = {
        text,
        model_id: modelId,
        voice_settings: validSettings
      };

      // 타임스탬프를 포함한 요청
      // ElevenLabs API의 실제 타임스탬프 엔드포인트 확인 필요
      // 일단 기본 구조만 구현

      // 모델별 파라미터 구성
      // eleven_v3 모델은 optimize_streaming_latency를 지원하지 않음
      const params = {
        output_format: 'mp3_44100_128',
        enable_logging: false
      };

      // optimize_streaming_latency는 v3 모델이 아닌 경우에만 추가
      if (modelId !== 'eleven_v3') {
        params.optimize_streaming_latency = 0;
      }

      const response = await axios.post(
        `${this.apiUrl}/text-to-speech/${voiceId}`,
        requestBody,
        {
          headers: {
            ...this.getHeaders(),
            'Accept': 'application/json'
          },
          params
        }
      );

      // 실제 API 응답 구조에 맞게 수정 필요
      // 타임스탬프는 별도 엔드포인트나 응답에 포함될 수 있음
      return {
        success: true,
        audioBuffer: null, // 실제 구현 필요
        timestamps: null // 실제 구현 필요
      };
    } catch (error) {
      console.error('[TTSService] 타임스탬프 포함 음성 생성 실패:', error.message);
      return {
        success: false,
        error: 'ElevenLabsAPIError',
        message: error.message || '음성 생성에 실패했습니다.'
      };
    }
  }
}

module.exports = new TTSService();
