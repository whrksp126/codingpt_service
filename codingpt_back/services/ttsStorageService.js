const s3Service = require('./s3Service');
const { buildTempS3Path, buildFinalS3Path, normalizeS3Path } = require('./ttsFileService');
const { S3Client } = require('@aws-sdk/client-s3');

function createS3Client() {
  const endpoint = process.env.OBJECTSTORE_ENDPOINT;
  return new S3Client({
    region: process.env.OBJECTSTORE_REGION || process.env.AWS_REGION || 'ap-northeast-2',
    credentials: {
      accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    },
    ...(endpoint && { endpoint, forcePathStyle: true }),
  });
}

/**
 * TTS 전용 S3 저장 서비스
 */
class TTSStorageService {
  /**
   * 임시 파일을 S3에 저장
   * @param {number} requestId - 요청 ID
   * @param {Buffer} audioBuffer - 오디오 버퍼
   * @returns {Promise<Object>} - 저장 결과
   */
  async saveTempFile(requestId, audioBuffer) {
    try {
      const s3Path = buildTempS3Path(requestId);
      
      // S3에 저장 (바이너리 데이터)
      const result = await s3Service.saveFile(s3Path, audioBuffer);
      
      if (!result.success) {
        return {
          success: false,
          error: result.error || 'S3SaveError',
          message: result.message || '임시 파일 저장에 실패했습니다.'
        };
      }

      return {
        success: true,
        s3Path: result.filePath,
        fileSize: result.size
      };
    } catch (error) {
      console.error('[TTSStorageService] 임시 파일 저장 실패:', error);
      return {
        success: false,
        error: 'StorageError',
        message: error.message || '임시 파일 저장에 실패했습니다.'
      };
    }
  }

  /**
   * 임시 파일을 최종 경로로 복사
   * @param {string} tempS3Path - 임시 S3 경로
   * @param {string} userInputPath - 사용자가 입력한 경로
   * @param {string} fileName - 파일명
   * @returns {Promise<Object>} - 복사 결과
   */
  async copyToFinalPath(tempS3Path, userInputPath, fileName) {
    try {
      // 사용자 입력 경로 검증
      const normalizedPath = normalizeS3Path(userInputPath);
      
      // 경로 검증 (위험한 패턴 차단)
      if (!s3Service.validatePath(normalizedPath)) {
        return {
          success: false,
          error: 'InvalidPath',
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.'
        };
      }

      const finalS3Path = buildFinalS3Path(userInputPath, fileName);
      
      // S3 파일 복사 (CopyObjectCommand 사용)
      const { CopyObjectCommand } = require('@aws-sdk/client-s3');
      const s3Client = createS3Client();

      // 한글 경로 지원을 위한 인코딩
      const encodedTempPath = tempS3Path.split('/').map(part => encodeURIComponent(part)).join('/');
      
      const copyCommand = new CopyObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        CopySource: `${process.env.S3_BUCKET_NAME}/${encodedTempPath}`,
        Key: finalS3Path
      });

      await s3Client.send(copyCommand);

      return {
        success: true,
        s3Path: finalS3Path,
        tempS3Path: tempS3Path
      };
    } catch (error) {
      console.error('[TTSStorageService] 파일 복사 실패:', error);
      return {
        success: false,
        error: 'CopyError',
        message: error.message || '파일 복사에 실패했습니다.'
      };
    }
  }

  /**
   * S3 파일 삭제
   * @param {string} s3Path - S3 경로
   * @returns {Promise<Object>} - 삭제 결과
   */
  async deleteFile(s3Path) {
    try {
      // 경로 검증
      if (!s3Service.validatePath(s3Path)) {
        return {
          success: false,
          error: 'InvalidPath',
          message: '잘못된 경로입니다.'
        };
      }

      const result = await s3Service.deleteFile(s3Path);
      
      if (!result.success) {
        return {
          success: false,
          error: result.error || 'DeleteError',
          message: result.message || '파일 삭제에 실패했습니다.'
        };
      }

      return {
        success: true,
        deletedPath: s3Path
      };
    } catch (error) {
      console.error('[TTSStorageService] 파일 삭제 실패:', error);
      return {
        success: false,
        error: 'DeleteError',
        message: error.message || '파일 삭제에 실패했습니다.'
      };
    }
  }

  /**
   * S3에서 오디오 파일 스트림 가져오기 (프록시용)
   * @param {string} s3Path - S3 경로
   * @returns {Promise<Object>} - 스트림 데이터
   */
  async getAudioStream(s3Path) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3Client = createS3Client();

      const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Path
      });

      const response = await s3Client.send(command);

      return {
        success: true,
        body: response.Body,
        contentType: response.ContentType || 'audio/mpeg',
        contentLength: response.ContentLength
      };
    } catch (error) {
      console.error('[TTSStorageService] 오디오 스트림 가져오기 실패:', error);
      return {
        success: false,
        error: 'StreamError',
        message: error.message || '오디오 파일을 가져오는데 실패했습니다.'
      };
    }
  }

  /**
   * Presigned URL 생성 (임시 파일 접근용)
   * @param {string} s3Path - S3 경로
   * @param {number} expiresIn - 만료 시간 (초, 기본값: 3600 = 1시간)
   * @param {boolean} useProxy - 프록시 URL 사용 여부 (기본값: false)
   * @returns {Promise<Object>} - Presigned URL 또는 프록시 URL
   */
  async getPresignedUrl(s3Path, expiresIn = 3600, useProxy = false, baseUrl = null) {
    // 프록시 모드인 경우 백엔드 프록시 URL 반환
    if (useProxy) {
      // requestId 추출 (경로에서)
      const pathParts = s3Path.split('/');
      const fileName = pathParts[pathParts.length - 1];
      const requestId = fileName.replace('.mp3', '');
      
      // baseUrl이 제공되면 절대 URL로, 없으면 상대 경로로 반환
      const proxyPath = `/api/tts/audio/${requestId}`;
      const proxyUrl = baseUrl ? `${baseUrl}${proxyPath}` : proxyPath;
      
      return {
        success: true,
        url: proxyUrl,
        expiresIn: null, // 프록시 URL은 만료 없음
        isProxy: true
      };
    }

    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      const s3Client = createS3Client();

      const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Path
      });

      const url = await getSignedUrl(s3Client, command, { expiresIn });

      return {
        success: true,
        url,
        expiresIn
      };
    } catch (error) {
      // @aws-sdk/s3-request-presigner가 설치되지 않은 경우 대체 방법 사용
      // CloudFront URL 또는 직접 S3 URL 사용
      console.warn('[TTSStorageService] Presigned URL 생성 실패, 대체 URL 사용:', error.message);
      
      // CloudFront URL이 있으면 사용, 없으면 직접 S3 URL 반환
      const cloudFrontUrl = process.env.CLOUDFRONT_DISTRIBUTION_URL || process.env.S3_PUBLIC_BASE_URL;
      if (cloudFrontUrl) {
        return {
          success: true,
          url: `${cloudFrontUrl}/${s3Path}`,
          expiresIn: null // CloudFront URL은 만료 없음
        };
      }
      
      // 직접 URL (objectstore 또는 S3 공개 읽기 권한이 있는 경우)
      const bucket = process.env.OBJECTSTORE_BUCKET || process.env.S3_BUCKET_NAME;
      const endpoint = process.env.OBJECTSTORE_ENDPOINT;
      const fallbackUrl = endpoint
        ? `${endpoint}/${bucket}/${s3Path}`
        : `https://${bucket}.s3.${process.env.AWS_REGION || 'ap-northeast-2'}.amazonaws.com/${s3Path}`;
      return {
        success: true,
        url: fallbackUrl,
        expiresIn: null
      };
    }
  }
}

module.exports = new TTSStorageService();

