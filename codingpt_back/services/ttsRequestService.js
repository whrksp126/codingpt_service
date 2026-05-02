const { TTSRequest, TTSSavedFile } = require('../models');

/**
 * TTS 요청 관리 서비스
 */
class TTSRequestService {
  /**
   * TTS 요청 생성
   * @param {Object} data - 요청 데이터
   * @returns {Promise<Object>} - 생성된 요청
   */
  async createRequest(data) {
    try {
      const {
        userId,
        voiceId,
        modelId,
        text,
        textWithEmotions,
        settings,
        audioS3Path,
        audioUrl,
        timestamps,
        fileName,
        fileSize,
        duration,
        status = 'pending'
      } = data;

      const request = await TTSRequest.create({
        user_id: userId || null, // 인증되지 않은 사용자는 null 허용
        voice_id: voiceId,
        model_id: modelId,
        text,
        text_with_emotions: textWithEmotions,
        settings,
        audio_s3_path: audioS3Path,
        audio_url: audioUrl,
        timestamps,
        file_name: fileName,
        file_size: fileSize,
        duration,
        status,
        is_saved: false
      });

      return {
        success: true,
        data: request
      };
    } catch (error) {
      console.error('[TTSRequestService] 요청 생성 실패:', error);
      return {
        success: false,
        error: 'CreateError',
        message: error.message || '요청 생성에 실패했습니다.'
      };
    }
  }

  /**
   * 요청 ID로 조회
   * @param {number} requestId - 요청 ID
   * @param {number} userId - 사용자 ID (권한 확인용)
   * @returns {Promise<Object>} - 요청 데이터
   */
  async getRequestById(requestId, userId = null) {
    try {
      const where = { id: requestId };
      if (userId) {
        where.user_id = userId;
      }

      const request = await TTSRequest.findOne({ where });

      if (!request) {
        return {
          success: false,
          error: 'NotFound',
          message: '요청을 찾을 수 없습니다.'
        };
      }

      return {
        success: true,
        data: request
      };
    } catch (error) {
      console.error('[TTSRequestService] 요청 조회 실패:', error);
      return {
        success: false,
        error: 'QueryError',
        message: error.message || '요청 조회에 실패했습니다.'
      };
    }
  }


  /**
   * 요청 업데이트
   * @param {number} requestId - 요청 ID
   * @param {Object} updateData - 업데이트 데이터
   * @param {number} userId - 사용자 ID (권한 확인용)
   * @returns {Promise<Object>} - 업데이트 결과
   */
  async updateRequest(requestId, updateData, userId = null) {
    try {
      const where = { id: requestId };
      if (userId) {
        where.user_id = userId;
      }

      const [updatedCount] = await TTSRequest.update(updateData, { where });

      if (updatedCount === 0) {
        return {
          success: false,
          error: 'NotFound',
          message: '요청을 찾을 수 없거나 권한이 없습니다.'
        };
      }

      const updatedRequest = await TTSRequest.findOne({ where: { id: requestId } });

      return {
        success: true,
        data: updatedRequest
      };
    } catch (error) {
      console.error('[TTSRequestService] 요청 업데이트 실패:', error);
      return {
        success: false,
        error: 'UpdateError',
        message: error.message || '요청 업데이트에 실패했습니다.'
      };
    }
  }

  /**
   * 요청 삭제
   * @param {number} requestId - 요청 ID
   * @param {number} userId - 사용자 ID (권한 확인용)
   * @returns {Promise<Object>} - 삭제 결과
   */
  async deleteRequest(requestId, userId) {
    try {
      const where = { id: requestId, user_id: userId };

      const request = await TTSRequest.findOne({ where });

      if (!request) {
        return {
          success: false,
          error: 'NotFound',
          message: '요청을 찾을 수 없거나 권한이 없습니다.'
        };
      }

      await TTSRequest.destroy({ where });

      return {
        success: true,
        data: {
          requestId,
          deletedS3Path: request.audio_s3_path
        }
      };
    } catch (error) {
      console.error('[TTSRequestService] 요청 삭제 실패:', error);
      return {
        success: false,
        error: 'DeleteError',
        message: error.message || '요청 삭제에 실패했습니다.'
      };
    }
  }

  /**
   * 저장된 파일 생성
   * @param {Object} data - 저장 데이터
   * @returns {Promise<Object>} - 생성된 저장 파일
   */
  async createSavedFile(data) {
    try {
      const {
        userId,
        ttsRequestId,
        s3Path,
        fileName,
        originalText,
        voiceId,
        modelId,
        settings,
        timestamps,
        fileSize,
        duration
      } = data;

      const savedFile = await TTSSavedFile.create({
        user_id: userId,
        tts_request_id: ttsRequestId,
        s3_path: s3Path,
        file_name: fileName,
        original_text: originalText,
        voice_id: voiceId,
        model_id: modelId,
        settings,
        timestamps,
        file_size: fileSize,
        duration
      });

      return {
        success: true,
        data: savedFile
      };
    } catch (error) {
      console.error('[TTSRequestService] 저장 파일 생성 실패:', error);
      return {
        success: false,
        error: 'CreateError',
        message: error.message || '저장 파일 생성에 실패했습니다.'
      };
    }
  }

  /**
   * 저장된 파일 목록 조회
   * @param {number} userId - 사용자 ID
   * @param {number} page - 페이지 번호
   * @param {number} limit - 페이지당 항목 수
   * @returns {Promise<Object>} - 저장된 파일 목록
   */
  async getSavedFiles(userId, page = 1, limit = 20) {
    try {
      const offset = (page - 1) * limit;

      const { count, rows } = await TTSSavedFile.findAndCountAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
        limit,
        offset
      });

      return {
        success: true,
        data: {
          files: rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            totalPages: Math.ceil(count / limit)
          }
        }
      };
    } catch (error) {
      console.error('[TTSRequestService] 저장 파일 목록 조회 실패:', error);
      return {
        success: false,
        error: 'QueryError',
        message: error.message || '저장 파일 목록 조회에 실패했습니다.'
      };
    }
  }

  /**
   * 저장된 파일 삭제
   * @param {number} savedFileId - 저장된 파일 ID
   * @param {number} userId - 사용자 ID (권한 확인용)
   * @returns {Promise<Object>} - 삭제 결과
   */
  async deleteSavedFile(savedFileId, userId) {
    try {
      const where = { id: savedFileId, user_id: userId };

      const savedFile = await TTSSavedFile.findOne({ where });

      if (!savedFile) {
        return {
          success: false,
          error: 'NotFound',
          message: '저장된 파일을 찾을 수 없거나 권한이 없습니다.'
        };
      }

      await TTSSavedFile.destroy({ where });

      return {
        success: true,
        data: {
          savedFileId,
          deletedS3Path: savedFile.s3_path
        }
      };
    } catch (error) {
      console.error('[TTSRequestService] 저장 파일 삭제 실패:', error);
      return {
        success: false,
        error: 'DeleteError',
        message: error.message || '저장 파일 삭제에 실패했습니다.'
      };
    }
  }
}

module.exports = new TTSRequestService();

