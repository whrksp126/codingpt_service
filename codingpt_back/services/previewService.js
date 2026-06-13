
const https = require('https');
const http = require('http');

class PreviewService {
  constructor() {
    this.s3PublicBaseUrl = process.env.OBJECTSTORE_PUBLIC_BASE_URL || process.env.S3_PUBLIC_BASE_URL || 'https://objectstore.ghmate.com/codingpt';
    this.backendUrl = process.env.BACKEND_URL || 'http://localhost:5103';
    this.executorPublicUrl = `${this.backendUrl}/api/executor`;
    
    // 프리뷰 세션 관리
    this.previewSessions = new Map(); // 세션 ID -> 세션 정보
    this.s3PathToSessionId = new Map(); // S3 경로 -> 세션 ID
    
    // 세션 정리 (1분마다 만료된 세션 삭제)
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000); // 1분마다 체크
  }

  /**
   * 만료된 세션 정리
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, sessionData] of this.previewSessions.entries()) {
      if (now > sessionData.expiresAt) {
        this.previewSessions.delete(sessionId);
        if (this.s3PathToSessionId.get(sessionData.s3Path) === sessionId) {
          this.s3PathToSessionId.delete(sessionData.s3Path);
        }
      }
    }
  }

  /**
   * S3 파일 존재 여부 확인
   * s3Service를 사용하여 확인
   */
  async checkS3FileExists(s3Path) {
    const s3Service = require('./s3Service');
    const result = await s3Service.getFileContent(s3Path);
    return result.success;
  }

  /**
   * 프리뷰 세션 생성
   * @param {string} s3Path - objectstore 디렉토리 경로
   * @param {string} fileName - 진입 파일
   * @param {Object|null} inlineFiles - 편집된 파일 맵 { 상대경로: 내용 }.
   *   지정 시 해당 파일은 objectstore 대신 이 내용으로 서빙(세션 내 임시 편집 반영).
   *   없는 파일(이미지 등)은 기존대로 objectstore(baseDir)에서 가져온다.
   */
  createPreviewSession(s3Path, fileName = 'index.html', inlineFiles = null) {
    // S3 경로 정규화
    let normalizedDir = s3Path.replace(/^\/+|\/+$/g, '');
    
    // codingpt/execute/ prefix 추가
    if (!normalizedDir.startsWith('codingpt/execute/')) {
      normalizedDir = `codingpt/execute/${normalizedDir}`;
    }
    
    const normalizedPath = `${normalizedDir}/${fileName}`;

    // 기존 세션 확인 및 만료 처리
    const existingSessionId = this.s3PathToSessionId.get(normalizedPath);
    if (existingSessionId && this.previewSessions.has(existingSessionId)) {
      this.previewSessions.delete(existingSessionId);
      this.s3PathToSessionId.delete(normalizedPath);
    }

    // 새 세션 생성
    const sessionId = `preview-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5분

    this.previewSessions.set(sessionId, {
      s3Path: normalizedPath,
      baseDir: normalizedDir,
      fileName: fileName,
      createdAt: Date.now(),
      expiresAt: expiresAt,
      isActive: false,
      inlineFiles: inlineFiles || null
    });

    this.s3PathToSessionId.set(normalizedPath, sessionId);

    const previewUrl = `${this.executorPublicUrl}/${sessionId}/${fileName}`;

    return {
      sessionId,
      previewUrl,
      s3Path: normalizedPath,
      expiresIn: 300
    };
  }

  /**
   * 세션 조회
   */
  getSession(sessionId) {
    return this.previewSessions.get(sessionId);
  }

  /**
   * 세션 만료
   */
  expireSession(sessionId) {
    const session = this.previewSessions.get(sessionId);
    if (session) {
      this.previewSessions.delete(sessionId);
      if (this.s3PathToSessionId.get(session.s3Path) === sessionId) {
        this.s3PathToSessionId.delete(session.s3Path);
      }
      return true;
    }
    return false;
  }

  /**
   * S3에서 파일 가져오기
   */
  async getS3File(s3Path) {
    // 공개 URL 직접 fetch(과거 방식)는 비공개 prefix(execute/ide)에서 403 이고 바이너리를
    // 문자열로 받아 깨졌다. 인증/HEAD-우회/base64 처리되는 s3Service.getFileContent 로 가져온다.
    const s3Service = require('./s3Service'); // 순환참조 회피용 지연 require
    const tryFetch = async (p) => {
      const r = await s3Service.getFileContent(p);
      return r.success ? r : null;
    };
    let res = await tryFetch(s3Path);
    // 한글 파일명 NFC/NFD 정규화 불일치 대비(저장 키가 NFD 인 경우 등)
    if (!res && s3Path.normalize('NFC') !== s3Path) res = await tryFetch(s3Path.normalize('NFC'));
    if (!res && s3Path.normalize('NFD') !== s3Path) res = await tryFetch(s3Path.normalize('NFD'));
    if (!res) throw new Error('S3 파일을 가져올 수 없습니다: 404');

    const content = res.encoding === 'base64' ? Buffer.from(res.content, 'base64') : res.content;
    return { content, contentType: res.contentType || 'text/html' };
  }
}

module.exports = new PreviewService();

