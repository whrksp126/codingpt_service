const ttsService = require('../services/ttsService');
const ttsRequestService = require('../services/ttsRequestService');
const ttsStorageService = require('../services/ttsStorageService');
const { generateFileName, buildFinalS3Path } = require('../services/ttsFileService');
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response');

/**
 * ElevenLabs 모델 목록 조회
 * GET /api/tts/models
 */
const getModels = async (req, res) => {
  try {
    const result = await ttsService.getModels();

    if (!result.success) {
      return errorResponse(res, { message: result.message }, 400);
    }

    return successResponse(res, {
      success: true,
      data: {
        models: result.models
      }
    });
  } catch (error) {
    console.error('[TTSController] 모델 목록 조회 오류:', error);
    return errorResponse(res, { message: '모델 목록을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 특정 모델의 지원 설정 정보 조회
 * GET /api/tts/models/:modelId/settings
 */
const getModelSettings = async (req, res) => {
  try {
    const { modelId } = req.params;

    if (!modelId) {
      return errorResponse(res, { message: 'modelId는 필수입니다.' }, 400);
    }

    const result = await ttsService.getModelSettings(modelId);

    if (!result.success) {
      return errorResponse(res, { message: result.message }, 404);
    }

    return successResponse(res, {
      success: true,
      data: {
        modelId: result.modelId,
        modelName: result.modelName,
        settingsSchema: result.settingsSchema,
        defaultSettings: result.defaultSettings
      }
    });
  } catch (error) {
    console.error('[TTSController] 모델 설정 조회 오류:', error);
    return errorResponse(res, { message: '모델 설정을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * ElevenLabs 목소리 목록 조회
 * GET /api/tts/voices
 */
const getVoices = async (req, res) => {
  try {
    const result = await ttsService.getVoices();

    if (!result.success) {
      return errorResponse(res, { message: result.message }, 400);
    }

    return successResponse(res, {
      success: true,
      data: {
        voices: result.voices
      }
    });
  } catch (error) {
    console.error('[TTSController] 목소리 목록 조회 오류:', error);
    return errorResponse(res, { message: '목소리 목록을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 음성 생성 요청
 * POST /api/tts/generate
 */
const generate = async (req, res) => {
  try {
    const { voiceId, modelId, text, settings } = req.body;
    const userId = req.user?.id || null; // 인증되지 않은 사용자는 null

    // 필수 파라미터 검증
    if (!voiceId || !text) {
      return errorResponse(res, { message: 'voiceId, text는 필수입니다.' }, 400);
    }

    // ElevenLabs API 호출하여 음성 생성
    const ttsResult = await ttsService.textToSpeech(
      voiceId,
      text,
      modelId || 'eleven_multilingual_v2',
      settings || {}
    );

    if (!ttsResult.success) {
      console.error('[TTSController] ElevenLabs API 오류:', {
        error: ttsResult.error,
        status: ttsResult.status,
        message: ttsResult.message,
        voiceId,
        modelId,
        textLength: text?.length,
        fullResult: ttsResult
      });

      // 에러 메시지가 있으면 사용, 없으면 기본 메시지
      const errorMessage = ttsResult.message || '음성 생성에 실패했습니다.';

      return res.status(400).json({
        success: false,
        message: errorMessage,
        error: ttsResult.error || 'ElevenLabsAPIError',
        status: ttsResult.status || 400,
        timestamp: new Date().toISOString()
      });
    }

    // 파일명 생성
    const fileName = generateFileName(text);

    // DB에 요청 먼저 저장 (requestId 생성)
    const requestResult = await ttsRequestService.createRequest({
      userId,
      voiceId,
      modelId: modelId || 'eleven_multilingual_v2',
      text,
      textWithEmotions: text, // 감정 표현 포함 텍스트
      settings: settings || {},
      audioS3Path: null, // 나중에 업데이트
      timestamps: ttsResult.timestamps || null,
      fileName,
      fileSize: null, // 나중에 업데이트
      duration: ttsResult.duration || null,
      status: 'pending' // S3 저장 후 completed로 변경
    });

    if (!requestResult.success) {
      return errorResponse(res, { message: requestResult.message }, 500);
    }

    const request = requestResult.data;
    const requestId = request.id;

    // S3에 임시 저장 (sessionId 없이 requestId만 사용)
    const saveResult = await ttsStorageService.saveTempFile(
      requestId,
      ttsResult.audioBuffer
    );

    if (!saveResult.success) {
      // DB 레코드 삭제 (롤백)
      await ttsRequestService.deleteRequest(requestId, userId);
      return errorResponse(res, { message: saveResult.message }, 500);
    }

    // DB에 S3 경로 및 파일 크기 업데이트
    await ttsRequestService.updateRequest(requestId, {
      audio_s3_path: saveResult.s3Path,
      file_size: ttsResult.audioSize,
      status: 'completed'
    }, userId);

    // Presigned URL 생성 (프록시 모드 사용하여 CORS 문제 해결)
    // baseUrl을 req.protocol과 req.get('host')로 구성
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const urlResult = await ttsStorageService.getPresignedUrl(saveResult.s3Path, 3600, true, baseUrl);

    return successResponse(res, {
      success: true,
      data: {
        requestId: request.id,
        audioUrl: urlResult.success ? urlResult.url : null,
        timestamps: ttsResult.timestamps, // 최신 타임스탬프 (duration 포함됨)
        duration: ttsResult.duration,
        fileName: request.file_name,
        text: request.text,
        voiceId: request.voice_id,
        modelId: request.model_id,
        settings: request.settings,
        createdAt: request.created_at
      }
    });
  } catch (error) {
    console.error('[TTSController] 음성 생성 오류:', error);
    return errorResponse(res, { message: '음성 생성 중 오류가 발생했습니다.' }, 500);
  }
};


/**
 * 임시 생성 데이터 삭제
 * DELETE /api/tts/request/:requestId
 */
const deleteRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user?.id || null; // 인증되지 않은 사용자는 null

    if (!requestId) {
      return errorResponse(res, { message: 'requestId는 필수입니다.' }, 400);
    }

    // 요청 조회
    const requestResult = await ttsRequestService.getRequestById(requestId, userId);

    if (!requestResult.success) {
      return errorResponse(res, { message: requestResult.message }, 404);
    }

    const request = requestResult.data;

    // S3 파일 삭제
    if (request.audio_s3_path) {
      await ttsStorageService.deleteFile(request.audio_s3_path);
    }

    // DB 레코드 삭제
    const deleteResult = await ttsRequestService.deleteRequest(requestId, userId);

    if (!deleteResult.success) {
      return errorResponse(res, { message: deleteResult.message }, 400);
    }

    return successResponse(res, {
      success: true,
      message: '임시 생성 데이터가 삭제되었습니다.',
      data: {
        requestId: parseInt(requestId),
        deletedS3Path: request.audio_s3_path
      }
    });
  } catch (error) {
    console.error('[TTSController] 요청 삭제 오류:', error);
    return errorResponse(res, { message: '요청 삭제 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 최종 저장
 * POST /api/tts/save
 */
const save = async (req, res) => {
  try {
    const { requestId, s3Path, customFileName } = req.body;
    const userId = req.user?.id || null; // 인증되지 않은 사용자는 null

    if (!requestId || !s3Path) {
      return errorResponse(res, { message: 'requestId와 s3Path는 필수입니다.' }, 400);
    }

    // 요청 조회
    const requestResult = await ttsRequestService.getRequestById(requestId, userId);

    if (!requestResult.success) {
      return errorResponse(res, { message: requestResult.message }, 404);
    }

    const request = requestResult.data;

    // 이미 저장된 경우
    if (request.is_saved) {
      return errorResponse(res, { message: '이미 저장된 요청입니다.' }, 400);
    }

    // 파일명 결정
    const fileName = customFileName || request.file_name;

    // 최종 S3 경로로 복사
    const copyResult = await ttsStorageService.copyToFinalPath(
      request.audio_s3_path,
      s3Path,
      fileName
    );

    if (!copyResult.success) {
      return errorResponse(res, { message: copyResult.message }, 400);
    }

    // 저장된 파일 레코드 생성
    const savedFileResult = await ttsRequestService.createSavedFile({
      userId,
      ttsRequestId: request.id,
      s3Path: copyResult.s3Path,
      fileName,
      originalText: request.text,
      voiceId: request.voice_id,
      modelId: request.model_id,
      settings: request.settings,
      timestamps: request.timestamps,
      fileSize: request.file_size,
      duration: request.duration
    });

    if (!savedFileResult.success) {
      // 복사한 파일 삭제 (롤백)
      await ttsStorageService.deleteFile(copyResult.s3Path);
      return errorResponse(res, { message: savedFileResult.message }, 500);
    }

    // 요청 상태 업데이트
    await ttsRequestService.updateRequest(requestId, {
      is_saved: true,
      s3_save_path: copyResult.s3Path,
      status: 'saved'
    }, userId);

    // Presigned URL 생성 (프록시 모드 사용하여 CORS 문제 해결)
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const urlResult = await ttsStorageService.getPresignedUrl(copyResult.s3Path, 3600, true, baseUrl);

    return successResponse(res, {
      success: true,
      data: {
        savedFileId: savedFileResult.data.id,
        s3Path: copyResult.s3Path,
        s3Url: urlResult.success ? urlResult.url : null,
        timestamps: request.timestamps,
        createdAt: savedFileResult.data.created_at
      }
    });
  } catch (error) {
    console.error('[TTSController] 저장 오류:', error);
    return errorResponse(res, { message: '저장 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 저장된 파일 목록 조회
 * GET /api/tts/saved
 */
const getSavedFiles = async (req, res) => {
  try {
    const userId = req.user?.id || null; // 인증되지 않은 사용자는 null

    // 인증되지 않은 사용자는 빈 목록 반환
    if (!userId) {
      return successResponse(res, {
        success: true,
        data: {
          files: [],
          pagination: {
            page: 1,
            limit: 20,
            total: 0,
            totalPages: 0
          }
        }
      });
    }
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await ttsRequestService.getSavedFiles(userId, page, limit);

    if (!result.success) {
      return errorResponse(res, { message: result.message }, 400);
    }

    // 각 파일에 Presigned URL 추가
    const filesWithUrls = await Promise.all(
      result.data.files.map(async (file) => {
        const urlResult = await ttsStorageService.getPresignedUrl(file.s3_path, 3600);
        return {
          savedFileId: file.id,
          s3Path: file.s3_path,
          s3Url: urlResult.success ? urlResult.url : null,
          fileName: file.file_name,
          originalText: file.original_text,
          voiceId: file.voice_id,
          modelId: file.model_id,
          duration: file.duration,
          createdAt: file.created_at
        };
      })
    );

    return paginatedResponse(
      res,
      filesWithUrls,
      page,
      limit,
      result.data.pagination.total,
      '저장된 파일 목록을 성공적으로 조회했습니다.'
    );
  } catch (error) {
    console.error('[TTSController] 저장 파일 목록 조회 오류:', error);
    return errorResponse(res, { message: '저장 파일 목록을 불러오는 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 저장된 파일 삭제
 * DELETE /api/tts/saved/:savedFileId
 */
const deleteSavedFile = async (req, res) => {
  try {
    const { savedFileId } = req.params;
    const userId = req.user?.id || null; // 인증되지 않은 사용자는 null

    // 인증되지 않은 사용자는 삭제 불가
    if (!userId) {
      return errorResponse(res, { message: '인증이 필요합니다.' }, 401);
    }

    if (!savedFileId) {
      return errorResponse(res, { message: 'savedFileId는 필수입니다.' }, 400);
    }

    // DB 레코드 조회 및 삭제
    const deleteResult = await ttsRequestService.deleteSavedFile(savedFileId, userId);

    if (!deleteResult.success) {
      return errorResponse(res, { message: deleteResult.message }, 400);
    }

    // S3 파일 삭제
    if (deleteResult.data.deletedS3Path) {
      await ttsStorageService.deleteFile(deleteResult.data.deletedS3Path);
    }

    return successResponse(res, {
      success: true,
      message: '저장된 파일이 삭제되었습니다.',
      data: {
        savedFileId: parseInt(savedFileId),
        deletedS3Path: deleteResult.data.deletedS3Path
      }
    });
  } catch (error) {
    console.error('[TTSController] 저장 파일 삭제 오류:', error);
    return errorResponse(res, { message: '저장 파일 삭제 중 오류가 발생했습니다.' }, 500);
  }
};

/**
 * 오디오 파일 프록시 (CORS 문제 해결용)
 * GET /api/tts/audio/:requestId
 */
const getAudioProxy = async (req, res) => {
  try {
    const { requestId } = req.params;

    if (!requestId) {
      return errorResponse(res, { message: 'requestId는 필수입니다.' }, 400);
    }

    // requestId로 S3 경로 생성
    const { buildTempS3Path } = require('../services/ttsFileService');
    const s3Path = buildTempS3Path(parseInt(requestId));

    // S3에서 오디오 파일 스트림 가져오기
    const streamResult = await ttsStorageService.getAudioStream(s3Path);

    if (!streamResult.success) {
      return errorResponse(res, { message: streamResult.message || '오디오 파일을 찾을 수 없습니다.' }, 404);
    }

    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', streamResult.contentType);
    res.setHeader('Content-Length', streamResult.contentLength);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1시간 캐시

    // 스트림을 클라이언트로 전송
    const stream = streamResult.body;
    stream.pipe(res);

    stream.on('error', (error) => {
      console.error('[TTSController] 오디오 스트림 전송 오류:', error);
      if (!res.headersSent) {
        return errorResponse(res, { message: '오디오 파일 전송 중 오류가 발생했습니다.' }, 500);
      }
    });
  } catch (error) {
    console.error('[TTSController] 오디오 프록시 오류:', error);
    if (!res.headersSent) {
      return errorResponse(res, { message: '오디오 파일을 불러오는 중 오류가 발생했습니다.' }, 500);
    }
  }
};

module.exports = {
  getModels,
  getModelSettings,
  getVoices,
  generate,
  deleteRequest,
  save,
  getSavedFiles,
  deleteSavedFile,
  getAudioProxy
};
