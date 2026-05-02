const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, CopyObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');

class S3Service {
  constructor() {
    const endpoint = process.env.OBJECTSTORE_ENDPOINT; // objectstore 사용 시 설정

    this.s3Client = new S3Client({
      region: process.env.OBJECTSTORE_REGION || process.env.AWS_REGION || 'ap-northeast-2',
      credentials: {
        accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY
      },
      ...(endpoint && {
        endpoint,
        forcePathStyle: true, // MinIO/objectstore는 path-style 필수
      }),
    });
    this.bucketName = process.env.OBJECTSTORE_BUCKET || process.env.S3_BUCKET_NAME;

    // CloudFront 클라이언트 초기화 (objectstore 사용 시 CloudFront 불필요)
    this.cloudFrontClient = endpoint ? null : new CloudFrontClient({
      region: process.env.AWS_REGION || 'ap-northeast-2',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    this.cloudFrontDistributionId = endpoint ? null : process.env.CLOUDFRONT_DISTRIBUTION_ID;
    
    if (!this.bucketName) {
      console.warn('[S3Service] S3_BUCKET_NAME 환경 변수가 설정되지 않았습니다.');
    }
    
    if (!this.cloudFrontDistributionId) {
      console.warn('[S3Service] CLOUDFRONT_DISTRIBUTION_ID 환경 변수가 설정되지 않았습니다. CloudFront 캐시 무효화가 비활성화됩니다.');
    }
  }

  /**
   * 경로 검증 (경로 탐색 공격 방지)
   * @param {string} path - 검증할 경로
   * @returns {boolean} - 유효한 경로인지 여부
   */
  validatePath(path) {
    if (!path || typeof path !== 'string') {
      return false;
    }
    
    // 위험한 패턴 차단
    const dangerousPatterns = [
      /\.\./,           // .. (상위 디렉토리)
      /\/\//,           // // (중복 슬래시)
      /^\/+/,           // 절대 경로 (앞의 슬래시)
      /[\x00-\x1f]/,    // 제어 문자
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(path)) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 파일 확장자에 따른 Content-Type 반환
   * @param {string} filePath - 파일 경로
   * @returns {string} - Content-Type
   */
  getContentType(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentTypes = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'txt': 'text/plain',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'webp': 'image/webp',
      'ico': 'image/x-icon',
      'woff': 'font/woff',
      'woff2': 'font/woff2',
      'ttf': 'font/ttf',
      'eot': 'application/vnd.ms-fontobject',
      'otf': 'font/otf'
    };
    return contentTypes[ext] || 'application/octet-stream';
  }

  /**
   * S3 파일 목록 조회
   * @param {string} s3Path - S3 경로 (디렉토리)
   * @param {boolean} recursive - 재귀적으로 조회할지 여부 (기본값: true)
   * @returns {Promise<Object>} - 파일 목록 또는 에러
   */
  async listFiles(s3Path, recursive = true) {
    try {
      // 빈 경로 처리: 최상단 경로로 설정
      const isEmptyPath = !s3Path || (typeof s3Path === 'string' && s3Path.trim() === '');
      if (isEmptyPath) {
        s3Path = 'codingpt/execute/';
      }

      // 경로 정규화 (앞뒤 슬래시 제거)
      let normalizedPath = s3Path.replace(/^\/+|\/+$/g, '');
      
      // codingpt/execute/ prefix가 없으면 추가 (코드 실행 관련 경로인 경우)
      // 단, TTS 경로(codingpt/tts/)는 제외
      if (normalizedPath && !normalizedPath.startsWith('codingpt/execute/') && !normalizedPath.startsWith('codingpt/tts/')) {
        // class-id- 또는 execute/ 로 시작하는 경우 codingpt/execute/ prefix 추가
        if (normalizedPath.startsWith('class-id-') || normalizedPath.startsWith('execute/')) {
          normalizedPath = `codingpt/execute/${normalizedPath}`;
        } else if (normalizedPath !== 'codingpt/execute') {
          // 그 외의 경우도 codingpt/execute/ prefix 추가 (최상단 경로 제외)
          normalizedPath = `codingpt/execute/${normalizedPath}`;
        }
      }
      
      // 빈 경로였거나 codingpt/execute인 경우 codingpt/execute/로 설정
      if (isEmptyPath || normalizedPath === 'codingpt/execute') {
        normalizedPath = 'codingpt/execute/';
      }
      
      // 경로 검증 (정규화 후)
      if (!this.validatePath(normalizedPath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }
      
      // 디렉토리 경로인 경우 마지막에 슬래시 추가
      if (normalizedPath && !normalizedPath.endsWith('/')) {
        normalizedPath += '/';
      }

      console.log('[S3Service] 최종 정규화된 경로:', normalizedPath);

      const files = [];
      let continuationToken = undefined;
      let hasMore = true;

      // 재귀적 조회: 모든 페이지를 순회하며 파일 수집
      while (hasMore) {
        const params = {
          Bucket: this.bucketName,
          Prefix: normalizedPath,
          Delimiter: recursive ? undefined : '/', // 재귀적 조회 시 구분자 없음
          MaxKeys: 1000 // 한 번에 최대 1000개 객체 조회
        };

        if (continuationToken) {
          params.ContinuationToken = continuationToken;
        }

        console.log('[S3Service] S3 조회 파라미터:', {
          Bucket: params.Bucket,
          Prefix: params.Prefix,
          Delimiter: params.Delimiter,
          ContinuationToken: continuationToken ? '있음' : '없음'
        });

        const command = new ListObjectsV2Command(params);
        const data = await this.s3Client.send(command);

        console.log('[S3Service] S3 응답:', {
          KeyCount: data.KeyCount,
          ContentsCount: data.Contents?.length || 0,
          CommonPrefixesCount: data.CommonPrefixes?.length || 0,
          IsTruncated: data.IsTruncated,
          Contents: data.Contents?.map(c => c.Key).slice(0, 5) || [],
          CommonPrefixes: data.CommonPrefixes?.map(p => p.Prefix).slice(0, 5) || []
        });

        // 모든 객체를 수집 (나중에 트리 구조로 변환)
        if (data.Contents) {
          for (const object of data.Contents) {
            files.push({
              key: object.Key,
              size: object.Size,
              lastModified: object.LastModified ? object.LastModified.toISOString() : null,
              isDirectory: object.Key.endsWith('/')
            });
          }
        }

        // 하위 디렉토리 처리 (재귀적이 아닌 경우 - CommonPrefixes 사용)
        if (!recursive && data.CommonPrefixes) {
          for (const prefix of data.CommonPrefixes) {
            files.push({
              key: prefix.Prefix,
              size: 0,
              lastModified: null,
              isDirectory: true
            });
          }
        }

        // 다음 페이지가 있는지 확인
        hasMore = data.IsTruncated === true;
        if (hasMore) {
          continuationToken = data.NextContinuationToken;
        }
      }

      console.log('[S3Service] 최종 파일 개수:', files.length);

      // 트리 구조로 변환
      const tree = this.buildFileTree(files, normalizedPath);

      return {
        success: true,
        files: tree
      };
    } catch (error) {
      console.error('[S3Service] 파일 목록 조회 오류:', error);
      
      // AWS 에러 코드에 따른 메시지 처리
      if (error.name === 'NoSuchBucket') {
        return {
          success: false,
          message: 'S3 버킷을 찾을 수 없습니다.',
          error: 'NoSuchBucket'
        };
      } else if (error.name === 'AccessDenied') {
        return {
          success: false,
          message: 'S3 버킷에 접근할 권한이 없습니다.',
          error: 'AccessDenied'
        };
      }
      
      return {
        success: false,
        message: error.message || '파일 목록을 불러올 수 없습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * 파일 목록을 트리 구조로 변환
   * @param {Array} allFiles - 모든 파일 객체 배열
   * @param {string} basePath - 기준 경로
   * @returns {Array} - 트리 구조의 파일 목록
   */
  buildFileTree(allFiles, basePath) {
    const tree = [];
    const pathMap = new Map(); // 경로 -> 노드 매핑

    // 모든 파일을 경로 길이 순으로 정렬 (상위 디렉토리부터)
    const sortedFiles = allFiles.sort((a, b) => {
      const aDepth = a.key.split('/').filter(p => p).length;
      const bDepth = b.key.split('/').filter(p => p).length;
      return aDepth - bDepth;
    });

    for (const file of sortedFiles) {
      // basePath를 제거하여 상대 경로만 사용
      let relativePath = file.key.replace(basePath, '');
      if (!relativePath) continue; // basePath 자체는 제외

      // 디렉토리인 경우 마지막 슬래시 제거
      if (relativePath.endsWith('/')) {
        relativePath = relativePath.slice(0, -1);
      }

      const pathParts = relativePath.split('/').filter(p => p);
      if (pathParts.length === 0) continue;

      // 현재 레벨의 경로 구성
      let currentPath = basePath;
      let parentNode = null;

      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        const isLastPart = i === pathParts.length - 1;
        const isFile = isLastPart && !file.isDirectory;
        
        // 현재 경로 구성
        currentPath += part;
        if (!isFile) {
          currentPath += '/';
        }

        // 이미 존재하는 노드인지 확인
        if (pathMap.has(currentPath)) {
          parentNode = pathMap.get(currentPath);
          // 파일인 경우 parentNode에 추가하지 않고 다음 파일로
          if (isFile) {
            break;
          }
          continue;
        }

        // 새 노드 생성
        const node = {
          name: part,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          size: isFile ? file.size : 0,
          lastModified: isFile ? file.lastModified : null
        };

        // 디렉토리인 경우 files 배열 추가
        if (!isFile) {
          node.files = [];
        }

        // 부모 노드에 추가
        if (parentNode) {
          if (!parentNode.files) {
            parentNode.files = [];
          }
          parentNode.files.push(node);
        } else {
          // 최상위 레벨
          tree.push(node);
        }

        // 디렉토리인 경우 pathMap에 추가하고 parentNode 업데이트
        if (!isFile) {
          pathMap.set(currentPath, node);
          parentNode = node;
        }
      }
    }

    return tree;
  }

  /**
   * S3 파일 내용 조회
   * @param {string} filePath - S3 파일 경로
   * @returns {Promise<Object>} - 파일 내용 또는 에러
   */
  async getFileContent(filePath) {
    try {
      // 경로 검증
      if (!this.validatePath(filePath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      // 빈 경로 처리
      if (!filePath || filePath.trim() === '') {
        return {
          success: false,
          message: '파일 경로가 필요합니다.',
          error: 'EmptyPath'
        };
      }

      // 경로 정규화 (앞뒤 슬래시 제거)
      let normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
      
      // codingpt/execute/ prefix가 없으면 항상 추가 (기본 경로)
      // 단, TTS 경로(codingpt/tts/)는 제외
      if (normalizedPath && !normalizedPath.startsWith('codingpt/execute/') && !normalizedPath.startsWith('codingpt/tts/')) {
        normalizedPath = `codingpt/execute/${normalizedPath}`;
      }

      const params = {
        Bucket: this.bucketName,
        Key: normalizedPath
      };

      // 먼저 파일 존재 여부 확인 (크기 제한 체크를 위해)
      const headCommand = new HeadObjectCommand(params);
      let headData;
      try {
        headData = await this.s3Client.send(headCommand);
      } catch (headError) {
        if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
          return {
            success: false,
            message: '파일을 찾을 수 없습니다.',
            error: 'NoSuchKey'
          };
        }
        throw headError;
      }

      // 파일 크기 제한 체크 (10MB)
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (headData.ContentLength > maxSize) {
        return {
          success: false,
          message: `파일 크기가 너무 큽니다. (최대 10MB, 현재: ${(headData.ContentLength / 1024 / 1024).toFixed(2)}MB)`,
          error: 'FileTooLarge'
        };
      }

      // 파일 내용 가져오기
      const getCommand = new GetObjectCommand(params);
      const data = await this.s3Client.send(getCommand);

      // Content-Type 확인
      const contentType = data.ContentType || this.getContentType(normalizedPath);
      
      // 텍스트 파일인지 확인
      const isTextFile = contentType.startsWith('text/') ||
                        normalizedPath.endsWith('.html') ||
                        normalizedPath.endsWith('.css') ||
                        normalizedPath.endsWith('.js') ||
                        normalizedPath.endsWith('.json') ||
                        normalizedPath.endsWith('.txt') ||
                        normalizedPath.endsWith('.svg') ||
                        normalizedPath.endsWith('.xml');

      // 파일 내용 읽기
      const chunks = [];
      for await (const chunk of data.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      let content;
      let encoding;

      if (isTextFile) {
        // 텍스트 파일은 UTF-8로 디코딩
        content = buffer.toString('utf-8');
        encoding = 'utf-8';
      } else {
        // 바이너리 파일은 base64로 인코딩
        content = buffer.toString('base64');
        encoding = 'base64';
      }

      return {
        success: true,
        content: content,
        filePath: normalizedPath,
        contentType: contentType,
        encoding: encoding,
        size: buffer.length
      };
    } catch (error) {
      console.error('[S3Service] 파일 내용 조회 오류:', error);
      
      // AWS 에러 코드에 따른 메시지 처리
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return {
          success: false,
          message: '파일을 찾을 수 없습니다.',
          error: 'NoSuchKey'
        };
      } else if (error.name === 'AccessDenied') {
        return {
          success: false,
          message: '파일에 접근할 권한이 없습니다.',
          error: 'AccessDenied'
        };
      }
      
      return {
        success: false,
        message: error.message || '파일을 불러올 수 없습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * S3 파일 저장/업데이트
   * @param {string} filePath - S3 파일 경로
   * @param {string} content - 파일 내용
   * @returns {Promise<Object>} - 저장 결과 또는 에러
   */
  async saveFile(filePath, content) {
    try {
      // 경로 검증
      if (!this.validatePath(filePath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      // 빈 경로 처리
      if (!filePath || filePath.trim() === '') {
        return {
          success: false,
          message: '파일 경로가 필요합니다.',
          error: 'EmptyPath'
        };
      }

      // 내용 검증
      if (content === undefined || content === null) {
        return {
          success: false,
          message: '파일 내용이 필요합니다.',
          error: 'EmptyContent'
        };
      }

      // 경로 정규화 (앞뒤 슬래시 제거)
      let normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
      
      // codingpt/execute/ prefix가 없으면 항상 추가 (기본 경로)
      // 단, TTS 경로(codingpt/tts/)는 제외
      if (normalizedPath && !normalizedPath.startsWith('codingpt/execute/') && !normalizedPath.startsWith('codingpt/tts/')) {
        normalizedPath = `codingpt/execute/${normalizedPath}`;
      }

      // 파일 크기 제한 체크 (10MB)
      const maxSize = 10 * 1024 * 1024; // 10MB
      const contentSize = Buffer.byteLength(content, 'utf-8');
      if (contentSize > maxSize) {
        return {
          success: false,
          message: `파일 크기가 너무 큽니다. (최대 10MB, 현재: ${(contentSize / 1024 / 1024).toFixed(2)}MB)`,
          error: 'FileTooLarge'
        };
      }

      // Content-Type 결정
      const contentType = this.getContentType(normalizedPath);

      // 파일 내용을 Buffer로 변환
      let body;
      if (typeof content === 'string') {
        // 텍스트 파일인 경우
        if (contentType.startsWith('text/') || 
            normalizedPath.endsWith('.html') ||
            normalizedPath.endsWith('.css') ||
            normalizedPath.endsWith('.js') ||
            normalizedPath.endsWith('.json') ||
            normalizedPath.endsWith('.txt') ||
            normalizedPath.endsWith('.svg') ||
            normalizedPath.endsWith('.xml')) {
          body = Buffer.from(content, 'utf-8');
        } else {
          // base64로 인코딩된 바이너리인 경우
          try {
            body = Buffer.from(content, 'base64');
          } catch (e) {
            // base64 디코딩 실패 시 UTF-8로 처리
            body = Buffer.from(content, 'utf-8');
          }
        }
      } else {
        body = content;
      }

      const params = {
        Bucket: this.bucketName,
        Key: normalizedPath,
        Body: body,
        ContentType: contentType
      };

      const command = new PutObjectCommand(params);
      await this.s3Client.send(command);

      return {
        success: true,
        message: '파일이 성공적으로 저장되었습니다.',
        filePath: normalizedPath,
        size: body.length
      };
    } catch (error) {
      console.error('[S3Service] 파일 저장 오류:', error);
      
      // AWS 에러 코드에 따른 메시지 처리
      if (error.name === 'AccessDenied') {
        return {
          success: false,
          message: '파일을 저장할 권한이 없습니다.',
          error: 'AccessDenied'
        };
      } else if (error.name === 'NoSuchBucket') {
        return {
          success: false,
          message: 'S3 버킷을 찾을 수 없습니다.',
          error: 'NoSuchBucket'
        };
      }
      
      return {
        success: false,
        message: error.message || '파일 저장에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * S3 폴더 생성
   * @param {string} folderPath - 생성할 폴더 경로
   * @returns {Promise<Object>} - 생성 결과
   */
  async createFolder(folderPath) {
    try {
      // 경로 검증
      if (!this.validatePath(folderPath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      // 빈 경로 처리
      if (!folderPath || folderPath.trim() === '') {
        return {
          success: false,
          message: '폴더 경로가 필요합니다.',
          error: 'EmptyPath'
        };
      }

      // 경로 정규화 (앞뒤 슬래시 제거)
      let normalizedPath = folderPath.replace(/^\/+|\/+$/g, '');
      
      // codingpt/execute/ prefix가 없으면 항상 추가 (기본 경로)
      if (normalizedPath && !normalizedPath.startsWith('codingpt/execute/')) {
        normalizedPath = `codingpt/execute/${normalizedPath}`;
      }

      // 폴더 경로는 항상 /로 끝나야 함
      if (!normalizedPath.endsWith('/')) {
        normalizedPath += '/';
      }

      // 경로 검증 (정규화 후)
      if (!this.validatePath(normalizedPath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      // S3에서 폴더는 빈 객체로 생성 (키가 /로 끝남)
      const params = {
        Bucket: this.bucketName,
        Key: normalizedPath,
        Body: '' // 빈 본문
      };

      const command = new PutObjectCommand(params);
      await this.s3Client.send(command);

      return {
        success: true,
        message: '폴더가 성공적으로 생성되었습니다.',
        folderPath: normalizedPath
      };
    } catch (error) {
      console.error('[S3Service] 폴더 생성 오류:', error);
      
      // AWS 에러 코드에 따른 메시지 처리
      if (error.name === 'AccessDenied') {
        return {
          success: false,
          message: '폴더를 생성할 권한이 없습니다.',
          error: 'AccessDenied'
        };
      } else if (error.name === 'NoSuchBucket') {
        return {
          success: false,
          message: 'S3 버킷을 찾을 수 없습니다.',
          error: 'NoSuchBucket'
        };
      }
      
      return {
        success: false,
        message: error.message || '폴더 생성에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * S3 파일 삭제
   * @param {string} filePath - 삭제할 S3 파일 경로
   * @returns {Promise<Object>} - 삭제 결과
   */
  async deleteFile(filePath) {
    try {
      // 경로 검증
      if (!this.validatePath(filePath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      // 빈 경로 처리
      if (!filePath || filePath.trim() === '') {
        return {
          success: false,
          message: '파일 경로가 필요합니다.',
          error: 'EmptyPath'
        };
      }

      // 경로 정규화
      let normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
      
      // codingpt/execute/ prefix가 없으면 항상 추가 (기본 경로)
      if (normalizedPath && !normalizedPath.startsWith('codingpt/execute/')) {
        normalizedPath = `codingpt/execute/${normalizedPath}`;
      }

      // 파일인지 폴더인지 판단 (원본 경로가 /로 끝나는지 확인)
      const isFolder = filePath.trim().endsWith('/');
      
      if (isFolder) {
        // 폴더인 경우: 내부의 모든 파일을 재귀적으로 삭제
        if (!normalizedPath.endsWith('/')) {
          normalizedPath += '/';
        }

        // 폴더 내부의 모든 파일 조회 (재귀적)
        const allObjects = [];
        let continuationToken = undefined;
        let hasMore = true;

        while (hasMore) {
          const listCommand = new ListObjectsV2Command({
            Bucket: this.bucketName,
            Prefix: normalizedPath,
            MaxKeys: 1000
          });

          if (continuationToken) {
            listCommand.input.ContinuationToken = continuationToken;
          }

          const listData = await this.s3Client.send(listCommand);

          if (listData.Contents) {
            allObjects.push(...listData.Contents.map(obj => ({ Key: obj.Key })));
          }

          hasMore = listData.IsTruncated === true;
          if (hasMore) {
            continuationToken = listData.NextContinuationToken;
          }
        }

        if (allObjects.length === 0) {
          return {
            success: false,
            message: '폴더를 찾을 수 없거나 비어있습니다.',
            error: 'NoSuchKey'
          };
        }

        // 배치 삭제 (최대 1000개씩)
        const batchSize = 1000;
        for (let i = 0; i < allObjects.length; i += batchSize) {
          const batch = allObjects.slice(i, i + batchSize);
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
              Objects: batch,
              Quiet: false
            }
          });
          await this.s3Client.send(deleteCommand);
        }

        return {
          success: true,
          message: '폴더가 성공적으로 삭제되었습니다.',
          filePath: normalizedPath,
          deletedCount: allObjects.length
        };
      } else {
        // 파일인 경우
        // 파일 존재 여부 확인
        const headCommand = new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedPath
        });

        try {
          await this.s3Client.send(headCommand);
        } catch (headError) {
          if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
            return {
              success: false,
              message: '파일을 찾을 수 없습니다.',
              error: 'NoSuchKey'
            };
          }
          throw headError;
        }

        // 파일 삭제
        const deleteCommand = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedPath
        });

        await this.s3Client.send(deleteCommand);

        return {
          success: true,
          message: '파일이 성공적으로 삭제되었습니다.',
          filePath: normalizedPath
        };
      }
    } catch (error) {
      console.error('[S3Service] 파일 삭제 오류:', error);
      
      // AWS 에러 코드에 따른 메시지 처리
      if (error.name === 'AccessDenied') {
        return {
          success: false,
          message: '파일을 삭제할 권한이 없습니다.',
          error: 'AccessDenied'
        };
      } else if (error.name === 'NoSuchBucket') {
        return {
          success: false,
          message: 'S3 버킷을 찾을 수 없습니다.',
          error: 'NoSuchBucket'
        };
      }
      
      return {
        success: false,
        message: error.message || '파일 삭제에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * 파일/폴더명 수정 (이름 변경) - 통합 API
   * @param {string} oldPath - 기존 파일/폴더 경로
   * @param {string} newName - 새로운 파일/폴더명
   * @returns {Promise<Object>} - 수정 결과
   */
  async rename(oldPath, newName) {
    try {
      // 경로 검증
      if (!this.validatePath(oldPath) || !this.validatePath(newName)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      if (!oldPath || !newName) {
        return {
          success: false,
          message: '기존 경로와 새로운 이름이 필요합니다.',
          error: 'MissingPath'
        };
      }

      // 경로 정규화
      let normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, '');
      // TTS 경로(codingpt/tts/)는 제외
      if (normalizedOldPath && !normalizedOldPath.startsWith('codingpt/execute/') && !normalizedOldPath.startsWith('codingpt/tts/')) {
        normalizedOldPath = `codingpt/execute/${normalizedOldPath}`;
      }

      // 파일인지 폴더인지 판단 (원본 경로가 /로 끝나는지 확인)
      const isFolder = oldPath.trim().endsWith('/') || normalizedOldPath.endsWith('/');
      
      if (isFolder && !normalizedOldPath.endsWith('/')) {
        normalizedOldPath += '/';
      }

      // 새 경로 생성
      const pathParts = normalizedOldPath.split('/').filter(p => p);
      pathParts[pathParts.length - 1] = newName;
      let normalizedNewPath = pathParts.join('/');
      
      if (isFolder && !normalizedNewPath.endsWith('/')) {
        normalizedNewPath += '/';
      }

      // 폴더인 경우 내부 파일들도 함께 이동
      if (isFolder) {
        // 폴더 내부의 모든 파일 조회
        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: normalizedOldPath
        });
        const listData = await this.s3Client.send(listCommand);

        if (!listData.Contents || listData.Contents.length === 0) {
          return {
            success: false,
            message: '폴더를 찾을 수 없거나 비어있습니다.',
            error: 'NoSuchKey'
          };
        }

        // 모든 파일을 새 경로로 이동
        const movePromises = [];
        for (const object of listData.Contents) {
          const oldKey = object.Key;
          const relativePath = oldKey.replace(normalizedOldPath, '');
          const newKey = normalizedNewPath + relativePath;

          // 복사 (CopySource는 key 부분만 URL 인코딩하여 한글 경로 지원)
          const encodedKey = oldKey.split('/').map(part => encodeURIComponent(part)).join('/');
          const copyCommand = new CopyObjectCommand({
            Bucket: this.bucketName,
            CopySource: `${this.bucketName}/${encodedKey}`,
            Key: newKey
          });
          movePromises.push(this.s3Client.send(copyCommand).then(() => {
            // 복사 성공 후 삭제
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.bucketName,
              Key: oldKey
            });
            return this.s3Client.send(deleteCommand);
          }));
        }

        await Promise.all(movePromises);

        return {
          success: true,
          message: '폴더명이 성공적으로 변경되었습니다.',
          oldPath: normalizedOldPath,
          newPath: normalizedNewPath,
          movedFiles: listData.Contents.length
        };
      } else {
        // 파일인 경우
        // 기존 파일 존재 확인
        const headCommand = new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedOldPath
        });

        try {
          await this.s3Client.send(headCommand);
        } catch (headError) {
          if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
            return {
              success: false,
              message: '파일을 찾을 수 없습니다.',
              error: 'NoSuchKey'
            };
          }
          throw headError;
        }

        // 파일 복사 (새 이름으로) - CopySource는 key 부분만 URL 인코딩하여 한글 경로 지원
        const encodedOldPath = normalizedOldPath.split('/').map(part => encodeURIComponent(part)).join('/');
        const copyCommand = new CopyObjectCommand({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${encodedOldPath}`,
          Key: normalizedNewPath
        });
        await this.s3Client.send(copyCommand);

        // 기존 파일 삭제
        const deleteCommand = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedOldPath
        });
        await this.s3Client.send(deleteCommand);

        return {
          success: true,
          message: '파일명이 성공적으로 변경되었습니다.',
          oldPath: normalizedOldPath,
          newPath: normalizedNewPath
        };
      }
    } catch (error) {
      console.error('[S3Service] 이름 변경 오류:', error);
      return {
        success: false,
        message: error.message || '이름 변경에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * 파일/폴더 이동 - 통합 API
   * @param {string} sourcePath - 원본 파일/폴더 경로
   * @param {string} targetPath - 대상 파일/폴더 경로
   * @returns {Promise<Object>} - 이동 결과
   */
  async move(sourcePath, targetPath) {
    try {
      // 경로 검증
      if (!this.validatePath(sourcePath) || !this.validatePath(targetPath)) {
        return {
          success: false,
          message: '잘못된 경로입니다. 경로 탐색 공격을 방지하기 위해 특수 문자를 사용할 수 없습니다.',
          error: 'InvalidPath'
        };
      }

      if (!sourcePath || !targetPath) {
        return {
          success: false,
          message: '원본 경로와 대상 경로가 필요합니다.',
          error: 'MissingPath'
        };
      }

      // 경로 정규화
      let normalizedSourcePath = sourcePath.replace(/^\/+|\/+$/g, '');
      let normalizedTargetPath = targetPath.replace(/^\/+|\/+$/g, '');

      // TTS 경로(codingpt/tts/)는 제외
      if (normalizedSourcePath && !normalizedSourcePath.startsWith('codingpt/execute/') && !normalizedSourcePath.startsWith('codingpt/tts/')) {
        normalizedSourcePath = `codingpt/execute/${normalizedSourcePath}`;
      }
      if (normalizedTargetPath && !normalizedTargetPath.startsWith('codingpt/execute/') && !normalizedTargetPath.startsWith('codingpt/tts/')) {
        normalizedTargetPath = `codingpt/execute/${normalizedTargetPath}`;
      }

      // 파일인지 폴더인지 판단 (원본 경로가 /로 끝나는지 확인)
      const isFolder = sourcePath.trim().endsWith('/') || normalizedSourcePath.endsWith('/');
      
      if (isFolder) {
        if (!normalizedSourcePath.endsWith('/')) {
          normalizedSourcePath += '/';
        }
        if (!normalizedTargetPath.endsWith('/')) {
          normalizedTargetPath += '/';
        }

        // 폴더인 경우 내부 파일들도 함께 이동
        const allObjects = [];
        let continuationToken = undefined;
        let hasMore = true;

        while (hasMore) {
          const listCommand = new ListObjectsV2Command({
            Bucket: this.bucketName,
            Prefix: normalizedSourcePath,
            MaxKeys: 1000
          });

          if (continuationToken) {
            listCommand.input.ContinuationToken = continuationToken;
          }

          const listData = await this.s3Client.send(listCommand);

          if (listData.Contents) {
            allObjects.push(...listData.Contents);
          }

          hasMore = listData.IsTruncated === true;
          if (hasMore) {
            continuationToken = listData.NextContinuationToken;
          }
        }

        if (allObjects.length === 0) {
          return {
            success: false,
            message: '원본 폴더를 찾을 수 없거나 비어있습니다.',
            error: 'NoSuchKey'
          };
        }

        // 폴더명 추출 (sourcePath의 마지막 폴더명)
        const sourcePathParts = normalizedSourcePath.split('/').filter(p => p);
        const folderName = sourcePathParts[sourcePathParts.length - 1]; // 마지막 폴더명
        
        // targetPath가 폴더 경로로 끝나면 폴더명을 추가
        if (!normalizedTargetPath.endsWith('/')) {
          normalizedTargetPath += '/';
        }
        const finalTargetPath = normalizedTargetPath + folderName + '/';

        // 모든 파일을 새 경로로 이동
        const movePromises = [];
        for (const object of allObjects) {
          const oldKey = object.Key;
          const relativePath = oldKey.replace(normalizedSourcePath, '');
          const newKey = finalTargetPath + relativePath;

          // 복사 (CopySource는 key 부분만 URL 인코딩하여 한글 경로 지원)
          // 슬래시는 그대로 두고 각 경로 세그먼트만 인코딩
          const encodedKey = oldKey.split('/').map(part => encodeURIComponent(part)).join('/');
          const copyCommand = new CopyObjectCommand({
            Bucket: this.bucketName,
            CopySource: `${this.bucketName}/${encodedKey}`,
            Key: newKey
          });
          movePromises.push(this.s3Client.send(copyCommand).then(() => {
            // 복사 성공 후 삭제
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.bucketName,
              Key: oldKey
            });
            return this.s3Client.send(deleteCommand);
          }));
        }

        await Promise.all(movePromises);

        return {
          success: true,
          message: '폴더가 성공적으로 이동되었습니다.',
          sourcePath: normalizedSourcePath,
          targetPath: finalTargetPath,
          movedFiles: allObjects.length
        };
      } else {
        // 파일인 경우
        // targetPath가 폴더 경로로 끝나면 원본 파일명을 추가
        if (targetPath.trim().endsWith('/') || normalizedTargetPath.endsWith('/')) {
          // 원본 파일명 추출
          const sourceFileName = normalizedSourcePath.split('/').pop();
          normalizedTargetPath = normalizedTargetPath.replace(/\/$/, '') + '/' + sourceFileName;
        }

        // 원본 파일 존재 확인
        const headCommand = new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedSourcePath
        });

        try {
          await this.s3Client.send(headCommand);
        } catch (headError) {
          if (headError.name === 'NotFound' || headError.$metadata?.httpStatusCode === 404) {
            return {
              success: false,
              message: '원본 파일을 찾을 수 없습니다.',
              error: 'NoSuchKey'
            };
          }
          throw headError;
        }

        // 파일 복사 - CopySource는 key 부분만 URL 인코딩하여 한글 경로 지원
        const encodedSourcePath = normalizedSourcePath.split('/').map(part => encodeURIComponent(part)).join('/');
        const copyCommand = new CopyObjectCommand({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${encodedSourcePath}`,
          Key: normalizedTargetPath
        });
        await this.s3Client.send(copyCommand);

        // 원본 파일 삭제
        const deleteCommand = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: normalizedSourcePath
        });
        await this.s3Client.send(deleteCommand);

        return {
          success: true,
          message: '파일이 성공적으로 이동되었습니다.',
          sourcePath: normalizedSourcePath,
          targetPath: normalizedTargetPath
        };
      }
    } catch (error) {
      console.error('[S3Service] 이동 오류:', error);
      return {
        success: false,
        message: error.message || '이동에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * CloudFront 캐시 무효화 (배치 - 여러 파일)
   * @param {string[]} filePaths - 무효화할 파일 경로 배열
   * @returns {Promise<Object>} - 무효화 결과
   */
  async invalidateCloudFrontCacheBatch(filePaths) {
    // CloudFront Distribution ID가 설정되지 않은 경우 스킵
    if (!this.cloudFrontDistributionId) {
      return {
        success: false,
        message: 'CloudFront Distribution ID가 설정되지 않았습니다.',
        skipped: true
      };
    }

    // CloudFront Distribution ID가 설정되지 않은 경우 스킵
    if (!this.cloudFrontDistributionId) {
      return {
        success: false,
        message: 'CloudFront Distribution ID가 설정되지 않았습니다.',
        skipped: true
      };
    }

    if (!filePaths || filePaths.length === 0) {
      return {
        success: false,
        message: '무효화할 파일 경로가 없습니다.',
        skipped: true
      };
    }

    try {
      // S3 경로를 CloudFront 경로로 변환 (앞에 슬래시 추가)
      // 중복 제거 (같은 파일이 여러 번 업데이트된 경우)
      const uniquePaths = [...new Set(filePaths.map(path => `/${path}`))];

      const params = {
        DistributionId: this.cloudFrontDistributionId,
        InvalidationBatch: {
          Paths: {
            Quantity: uniquePaths.length,
            Items: uniquePaths
          },
          CallerReference: `invalidate-${Date.now()}-${Math.random().toString(36).substring(7)}`
        }
      };

      console.log('[S3Service] CloudFront 캐시 무효화 요청 (배치):', {
        distributionId: this.cloudFrontDistributionId,
        pathCount: uniquePaths.length,
        paths: uniquePaths,
        note: '여러 파일을 한 번의 요청으로 무효화하여 효율성 향상'
      });

      const command = new CreateInvalidationCommand(params);
      const result = await this.cloudFrontClient.send(command);

      console.log('[S3Service] CloudFront 캐시 무효화 성공:', {
        invalidationId: result.Invalidation?.Id,
        status: result.Invalidation?.Status
      });

      return {
        success: true,
        invalidationId: result.Invalidation?.Id,
        status: result.Invalidation?.Status,
        pathCount: uniquePaths.length,
        paths: uniquePaths
      };
    } catch (error) {
      console.error('[S3Service] CloudFront 캐시 무효화 오류:', error);
      return {
        success: false,
        message: error.message || 'CloudFront 캐시 무효화에 실패했습니다.',
        error: error.name || 'UnknownError'
      };
    }
  }

  /**
   * S3 경로에서 index.html 파일 찾기
   * @param {string} s3Path - S3 경로 (디렉토리)
   * @returns {Promise<string|null>} - 찾은 파일명 또는 null
   */
  async findIndexHtml(s3Path) {
    try {
      const result = await this.listFiles(s3Path, false);
      
      if (!result.success || !result.files || result.files.length === 0) {
        return null;
      }

      // index.html 찾기
      const indexFile = result.files.find(f => f.name === 'index.html' && f.type === 'file');
      if (indexFile) {
        return 'index.html';
      }

      // index.html이 없으면 첫 번째 HTML 파일 찾기
      const htmlFile = result.files.find(f => 
        f.type === 'file' && 
        (f.name.endsWith('.html') || f.name.endsWith('.htm'))
      );
      
      if (htmlFile) {
        return htmlFile.name;
      }

      return null;
    } catch (error) {
      console.error('[S3Service] index.html 찾기 오류:', error);
      return null;
    }
  }
}

module.exports = new S3Service();

