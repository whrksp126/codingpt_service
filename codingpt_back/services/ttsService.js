const { spawn } = require('child_process');

/**
 * Google Gemini TTS 통합 서비스 (이전 ElevenLabs 대체)
 *
 * - 모델: gemini-3.1-flash-tts-preview (기본), gemini-2.5-flash-preview-tts (저비용 대안)
 * - 보이스: Gemini 프리빌트 보이스(30종) 중 선택
 * - 스타일: settings.styleInstructions(자연어)를 프롬프트 프리픽스로 전달
 * - 응답: PCM(16bit/mono) → ffmpeg 로 mp3 변환하여 반환 (기존 저장/재생 파이프라인 호환)
 * - 타임스탬프: Gemini TTS 는 제공하지 않음 → null (RN 타이핑효과 비활성 + ttsHold onEnd 기반이라 불필요)
 */
class TTSService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.apiUrl = process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta';
    this.defaultModel = 'gemini-3.1-flash-tts-preview';
    this.defaultVoice = 'Achernar';
    // 보이스 샘플(▶ 미리듣기)을 한 번 생성해 저장하는 objectstore 경로.
    this.VOICE_SAMPLE_PREFIX = 'tts/static/library/_voice_samples';
    // 캐시버스터 버전 — 샘플 문장/보이스를 바꿔 재생성할 때마다 +1 (CDN 캐시 무효화).
    this.VOICE_SAMPLE_VERSION = 2;

    if (!this.apiKey) {
      console.warn('[TTSService] GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.');
    }
  }

  // 보이스 샘플로 읽을 문장(보이스 이름 포함)
  voiceSampleText(voiceId) {
    return `안녕하세요! 저는 ${voiceId} 입니다. 이건 제 목소리 샘플이에요.`;
  }

  // 보이스 샘플 공개 URL (PUBLIC_BASE 는 이미 버킷(/codingpt)을 포함)
  voiceSampleUrl(voiceId) {
    const bucket = process.env.OBJECTSTORE_BUCKET || 'codingpt';
    const base = (process.env.OBJECTSTORE_PUBLIC_BASE_URL
      || `${process.env.OBJECTSTORE_ENDPOINT || 'https://objectstore.ghmate.com'}/${bucket}`).replace(/\/+$/, '');
    return `${base}/${this.VOICE_SAMPLE_PREFIX}/${voiceId}.mp3?v=${this.VOICE_SAMPLE_VERSION}`;
  }

  /**
   * 사용 가능한 모델 목록 (Gemini TTS)
   */
  async getModels() {
    const settingsSchema = this._settingsSchema();
    const defaultSettings = this._defaultSettings();
    const models = [
      {
        model_id: 'gemini-3.1-flash-tts-preview',
        name: 'Gemini 3.1 Flash TTS',
        description: '최신 고품질 음성. 스타일 지시(자연어)로 톤·감정 제어, 한국어+영어 기술어 발음 우수',
        language_support: '다국어',
        quality: '매우 높음',
        speed: '빠름',
        character_limit: 5000,
        can_use_style: true,
        supported_settings: settingsSchema,
        default_settings: defaultSettings,
      },
      {
        model_id: 'gemini-2.5-flash-preview-tts',
        name: 'Gemini 2.5 Flash TTS (저비용)',
        description: '한 단계 낮은 비용. 품질도 양호. 동일하게 스타일 지시 지원',
        language_support: '다국어',
        quality: '높음',
        speed: '빠름',
        character_limit: 5000,
        can_use_style: true,
        supported_settings: settingsSchema,
        default_settings: defaultSettings,
      },
    ];
    return { success: true, models };
  }

  /**
   * 특정 모델의 설정 스키마
   */
  async getModelSettings(modelId) {
    const SUPPORTED = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
    const id = modelId || this.defaultModel;
    if (!SUPPORTED.includes(id)) {
      return {
        success: false,
        error: 'ModelNotFound',
        message: `모델 '${modelId}'를 찾을 수 없습니다. 지원되는 모델: ${SUPPORTED.join(', ')}`,
      };
    }
    return {
      success: true,
      modelId: id,
      modelName: id === 'gemini-2.5-flash-preview-tts' ? 'Gemini 2.5 Flash TTS' : 'Gemini 3.1 Flash TTS',
      settingsSchema: this._settingsSchema(),
      defaultSettings: this._defaultSettings(),
    };
  }

  /**
   * 사용 가능한 보이스 목록 (Gemini 프리빌트 30종)
   */
  async getVoices() {
    // 각 보이스에 샘플 ▶ 재생용 preview_url 부여(미리 생성해 저장한 mp3).
    const voices = GEMINI_VOICES.map((v) => ({ ...v, preview_url: this.voiceSampleUrl(v.voice_id) }));
    return { success: true, voices };
  }

  /**
   * 텍스트 → 음성(mp3). 시그니처는 기존과 동일하게 유지.
   * @param {string} voiceId - Gemini 보이스명 (예: 'Achernar')
   * @param {string} text - 변환할 텍스트
   * @param {string} modelId - Gemini 모델 ID
   * @param {Object} settings - { styleInstructions?: string, temperature?: number }
   * @returns {Promise<{success, audioBuffer, audioSize, timestamps, duration}>}
   */
  async textToSpeech(voiceId, text, modelId = this.defaultModel, settings = {}) {
    try {
      if (!this.apiKey) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
      if (!text) throw new Error('text는 필수입니다.');

      const model = modelId || this.defaultModel;
      const voice = voiceId || this.defaultVoice;
      const style = (settings && typeof settings.styleInstructions === 'string')
        ? settings.styleInstructions.trim()
        : '';

      // 스타일 지시를 프롬프트 프리픽스로 결합 (AI Studio "Style instructions" 와 동일 방식)
      const prompt = style ? `${style}:\n${text}` : text;

      const generationConfig = {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      };
      if (settings && typeof settings.temperature === 'number') {
        generationConfig.temperature = settings.temperature;
      }

      const resp = await fetch(
        `${this.apiUrl}/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        },
      );

      if (!resp.ok) {
        const errText = await resp.text();
        let message = `음성 생성에 실패했습니다. (HTTP ${resp.status})`;
        try {
          const j = JSON.parse(errText);
          message = j.error?.message || message;
        } catch (e) { /* keep default */ }
        if (resp.status === 401 || resp.status === 403) message = 'GEMINI_API_KEY가 유효하지 않거나 권한이 없습니다.';
        if (resp.status === 429) message = 'Gemini API 할당량/속도 제한을 초과했습니다. 잠시 후 다시 시도해주세요.';
        console.error('[TTSService] Gemini 음성 생성 실패:', resp.status, errText.slice(0, 300));
        return { success: false, error: 'GeminiAPIError', status: resp.status, message };
      }

      const data = await resp.json();
      const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      const inline = part?.inlineData;
      if (!inline?.data) {
        console.error('[TTSService] Gemini 응답에 오디오 없음:', JSON.stringify(data).slice(0, 300));
        return { success: false, error: 'GeminiNoAudio', message: '응답에 오디오 데이터가 없습니다.' };
      }

      const pcm = Buffer.from(inline.data, 'base64');
      const rateMatch = /rate=(\d+)/.exec(inline.mimeType || '');
      const rate = rateMatch ? Number(rateMatch[1]) : 24000;

      // PCM(16bit mono) → mp3
      const audioBuffer = await this._pcmToMp3(pcm, rate);
      // duration: PCM 바이트수 / (2바이트 × 샘플레이트)
      const duration = pcm.length / (2 * rate);

      return {
        success: true,
        audioBuffer,
        audioSize: audioBuffer.length,
        timestamps: null, // Gemini TTS 는 정렬 타임스탬프 미제공
        duration,
      };
    } catch (error) {
      console.error('[TTSService] 음성 생성 실패:', error.message);
      return { success: false, error: 'NetworkError', message: error.message || '네트워크 오류가 발생했습니다.' };
    }
  }

  // === 내부 헬퍼 ===

  _settingsSchema() {
    return {
      styleInstructions: {
        supported: true,
        type: 'text',
        default: '',
        description: '말투/감정/상황 지시(자연어). 예: "선생님이 학습 목차를 차분히 읽어주는 느낌"',
      },
      temperature: {
        supported: true,
        type: 'number',
        default: 1.0,
        min: 0.0,
        max: 2.0,
        description: '표현 다양성(낮을수록 일관, 높을수록 변화). 일관된 톤 원하면 낮게.',
      },
    };
  }

  _defaultSettings() {
    return { styleInstructions: '', temperature: 1.0 };
  }

  /**
   * PCM(s16le, mono) 버퍼를 mp3 버퍼로 변환 (ffmpeg, 파이프).
   */
  _pcmToMp3(pcm, rate) {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0',
        '-b:a', '128k', '-f', 'mp3', 'pipe:1',
      ]);
      const out = [];
      const err = [];
      ff.stdout.on('data', (c) => out.push(c));
      ff.stderr.on('data', (c) => err.push(c));
      ff.on('error', (e) => reject(new Error(`ffmpeg 실행 실패: ${e.message} (ffmpeg 설치 확인 필요)`)));
      ff.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`ffmpeg PCM→mp3 변환 실패: ${Buffer.concat(err).toString().slice(0, 200)}`));
      });
      ff.stdin.on('error', () => { /* EPIPE 무시 */ });
      ff.stdin.write(pcm);
      ff.stdin.end();
    });
  }
}

// Gemini TTS 프리빌트 보이스 (이름 + 한국어 톤 설명)
const GEMINI_VOICES = [
  { voice_id: 'Achernar', name: 'Achernar — 부드러움', category: 'gemini', description: '부드럽고 차분' },
  { voice_id: 'Sulafat', name: 'Sulafat — 따뜻함', category: 'gemini', description: '따뜻한 톤' },
  { voice_id: 'Kore', name: 'Kore — 단단함', category: 'gemini', description: '안정적이고 또렷' },
  { voice_id: 'Charon', name: 'Charon — 정보전달', category: 'gemini', description: '차분한 설명조' },
  { voice_id: 'Aoede', name: 'Aoede — 산뜻함', category: 'gemini', description: '밝고 산뜻' },
  { voice_id: 'Puck', name: 'Puck — 경쾌함', category: 'gemini', description: '경쾌한 톤' },
  { voice_id: 'Zephyr', name: 'Zephyr — 밝음', category: 'gemini', description: '밝은 톤' },
  { voice_id: 'Leda', name: 'Leda — 젊은 느낌', category: 'gemini', description: '젊고 가벼움' },
  { voice_id: 'Orus', name: 'Orus — 단호함', category: 'gemini', description: '단호하고 명확' },
  { voice_id: 'Callirrhoe', name: 'Callirrhoe — 느긋함', category: 'gemini', description: '여유로운 톤' },
  { voice_id: 'Autonoe', name: 'Autonoe — 밝음', category: 'gemini', description: '밝은 톤' },
  { voice_id: 'Enceladus', name: 'Enceladus — 부드러움(숨결)', category: 'gemini', description: '부드럽고 숨결감' },
  { voice_id: 'Iapetus', name: 'Iapetus — 명료함', category: 'gemini', description: '또렷한 발음' },
  { voice_id: 'Umbriel', name: 'Umbriel — 느긋함', category: 'gemini', description: '여유로운 톤' },
  { voice_id: 'Algieba', name: 'Algieba — 부드러움', category: 'gemini', description: '부드러운 톤' },
  { voice_id: 'Despina', name: 'Despina — 매끄러움', category: 'gemini', description: '매끄러운 톤' },
  { voice_id: 'Erinome', name: 'Erinome — 또렷함', category: 'gemini', description: '또렷한 톤' },
  { voice_id: 'Algenib', name: 'Algenib — 거친 듯', category: 'gemini', description: '약간 거친 질감' },
  { voice_id: 'Rasalgethi', name: 'Rasalgethi — 정보전달', category: 'gemini', description: '설명조' },
  { voice_id: 'Laomedeia', name: 'Laomedeia — 경쾌함', category: 'gemini', description: '경쾌한 톤' },
  { voice_id: 'Alnilam', name: 'Alnilam — 단단함', category: 'gemini', description: '단단한 톤' },
  { voice_id: 'Schedar', name: 'Schedar — 고른 톤', category: 'gemini', description: '균형잡힌 톤' },
  { voice_id: 'Gacrux', name: 'Gacrux — 성숙함', category: 'gemini', description: '성숙한 톤' },
  { voice_id: 'Pulcherrima', name: 'Pulcherrima — 주도적', category: 'gemini', description: '또렷하고 주도적' },
  { voice_id: 'Achird', name: 'Achird — 친근함', category: 'gemini', description: '친근한 톤' },
  { voice_id: 'Zubenelgenubi', name: 'Zubenelgenubi — 캐주얼', category: 'gemini', description: '편안한 캐주얼' },
  { voice_id: 'Vindemiatrix', name: 'Vindemiatrix — 온화함', category: 'gemini', description: '온화한 톤' },
  { voice_id: 'Sadachbia', name: 'Sadachbia — 생기', category: 'gemini', description: '생기있는 톤' },
  { voice_id: 'Sadaltager', name: 'Sadaltager — 전문적', category: 'gemini', description: '전문적인 톤' },
  { voice_id: 'Fenrir', name: 'Fenrir — 활기', category: 'gemini', description: '활기찬 톤' },
];

module.exports = new TTSService();
