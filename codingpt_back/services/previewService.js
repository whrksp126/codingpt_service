
const https = require('https');
const http = require('http');

class PreviewService {
  constructor() {
    this.s3PublicBaseUrl = process.env.S3_PUBLIC_BASE_URL || 'https://s3.ghmate.com';
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
   */
  createPreviewSession(s3Path, fileName = 'index.html') {
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
      isActive: false
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
    const s3Url = `${this.s3PublicBaseUrl}/${s3Path}`;
    const urlObj = new URL(s3Url);
    const client = urlObj.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + (urlObj.search || ''),
        method: 'GET'
      };

      const req = client.request(options, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`S3 파일을 가져올 수 없습니다: ${response.statusCode}`));
          return;
        }

        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve({
            content: data,
            contentType: response.headers['content-type'] || 'text/html'
          });
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = new PreviewService();

