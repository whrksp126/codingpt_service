/**
 * TTS 파일명 생성 및 관련 유틸리티 서비스
 */

/**
 * 텍스트에서 파일명 생성
 * @param {string} text - 원본 텍스트
 * @returns {string} - 생성된 파일명 (확장자 포함)
 */
function generateFileName(text) {
  if (!text || typeof text !== 'string') {
    return `tts_${Date.now()}.mp3`;
  }

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
    cleaned = `tts_${Date.now()}`;
  }
  
  return `${cleaned}.mp3`;
}

/**
 * 파일명 중복 방지를 위한 고유 파일명 생성
 * @param {string} baseFileName - 기본 파일명
 * @param {number} requestId - 요청 ID (중복 방지용)
 * @returns {string} - 고유 파일명
 */
function generateUniqueFileName(baseFileName, requestId) {
  const nameWithoutExt = baseFileName.replace(/\.mp3$/, '');
  return `${nameWithoutExt}_${requestId}.mp3`;
}

/**
 * S3 경로 정규화 (앞뒤 슬래시 제거)
 * @param {string} path - 사용자 입력 경로
 * @returns {string} - 정규화된 경로
 */
function normalizeS3Path(path) {
  if (!path || typeof path !== 'string') {
    return '';
  }
  return path.replace(/^\/+|\/+$/g, '');
}

/**
 * 최종 S3 저장 경로 생성
 * @param {string} userInputPath - 사용자가 입력한 경로
 * @param {string} fileName - 파일명
 * @returns {string} - 최종 S3 경로
 */
function buildFinalS3Path(userInputPath, fileName) {
  const normalizedPath = normalizeS3Path(userInputPath);
  if (normalizedPath) {
    return `codingpt/tts/static/${normalizedPath}/${fileName}`;
  }
  return `codingpt/tts/static/${fileName}`;
}

/**
 * 임시 S3 저장 경로 생성
 * @param {number} requestId - 요청 ID
 * @returns {string} - 임시 S3 경로
 */
function buildTempS3Path(requestId) {
  return `codingpt/tts/temp/${requestId}.mp3`;
}

module.exports = {
  generateFileName,
  generateUniqueFileName,
  normalizeS3Path,
  buildFinalS3Path,
  buildTempS3Path
};

