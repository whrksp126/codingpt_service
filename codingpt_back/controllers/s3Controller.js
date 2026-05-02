const s3Service = require('../services/s3Service');
const logger = require('../middlewares/logger');

/**
 * S3 파일 목록 조회
 * POST /api/s3/files
 * GET /api/s3/files?path={s3Path}
 */
const listFiles = async (req, res) => {
  try {
    // POST 요청: body에서 s3Path 가져오기
    // GET 요청: query에서 path 가져오기
    let s3Path = req.body?.s3Path || req.query?.path;
    // recursive 기본값을 true로 설정 (명시적으로 false를 요청하지 않으면 재귀적으로 조회)
    const recursive = req.body?.recursive !== undefined ? req.body.recursive : 
                      req.query?.recursive !== undefined ? req.query.recursive === 'true' : true;

    // s3Path가 없거나 빈 문자열이면 최상단 경로로 설정
    if (!s3Path || (typeof s3Path === 'string' && s3Path.trim() === '')) {
      s3Path = 'codingpt/execute/';
    }

    // 로깅
    console.log(`[S3Controller] 파일 목록 조회 요청:`, { s3Path, recursive });

    const result = await s3Service.listFiles(s3Path, recursive);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'NoSuchBucket' || result.error === 'AccessDenied' ? 403 : 
                        result.error === 'InvalidPath' || result.error === 'EmptyPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 파일 목록 조회 오류:', error);
    return res.status(500).json({
      success: false,
      message: '파일 목록을 불러오는 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * S3 파일 내용 조회
 * POST /api/s3/file
 * GET /api/s3/file?path={filePath}
 */
const getFileContent = async (req, res) => {
  try {
    // POST 요청: body에서 filePath 가져오기
    // GET 요청: query에서 path 가져오기
    const filePath = req.body?.filePath || req.query?.path;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: '파일 경로가 필요합니다.',
        error: 'MissingPath'
      });
    }

    // 로깅
    console.log(`[S3Controller] 파일 내용 조회 요청:`, { filePath });

    const result = await s3Service.getFileContent(filePath);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'NoSuchKey' ? 404 :
                        result.error === 'AccessDenied' ? 403 :
                        result.error === 'FileTooLarge' || result.error === 'InvalidPath' || result.error === 'EmptyPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 파일 내용 조회 오류:', error);
    return res.status(500).json({
      success: false,
      message: '파일을 불러오는 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * S3 파일 저장/업데이트
 * PUT /api/s3/file
 */
const saveFile = async (req, res) => {
  try {
    const { filePath, content } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: '파일 경로가 필요합니다.',
        error: 'MissingPath'
      });
    }

    if (content === undefined || content === null) {
      return res.status(400).json({
        success: false,
        message: '파일 내용이 필요합니다.',
        error: 'MissingContent'
      });
    }

    // 로깅
    console.log(`[S3Controller] 파일 저장 요청:`, { 
      filePath, 
      contentLength: typeof content === 'string' ? content.length : 'binary'
    });

    const result = await s3Service.saveFile(filePath, content);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'AccessDenied' ? 403 :
                        result.error === 'FileTooLarge' || result.error === 'InvalidPath' || result.error === 'EmptyPath' || result.error === 'EmptyContent' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 파일 저장 오류:', error);
    return res.status(500).json({
      success: false,
      message: '파일을 저장하는 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * S3 폴더 생성
 * POST /api/s3/folder
 */
const createFolder = async (req, res) => {
  try {
    const { folderPath } = req.body;

    if (!folderPath) {
      return res.status(400).json({
        success: false,
        message: '폴더 경로가 필요합니다.',
        error: 'MissingPath'
      });
    }

    // 로깅
    console.log(`[S3Controller] 폴더 생성 요청:`, { folderPath });

    const result = await s3Service.createFolder(folderPath);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'AccessDenied' ? 403 :
                        result.error === 'InvalidPath' || result.error === 'EmptyPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 폴더 생성 오류:', error);
    return res.status(500).json({
      success: false,
      message: '폴더를 생성하는 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * CloudFront 캐시 무효화
 * POST /api/s3/invalidate
 * PUT /api/s3/invalidate
 * 
 * Body: { filePath: string } 또는 { filePaths: string[] }
 */
const invalidateCache = async (req, res) => {
  try {
    const { filePath, filePaths } = req.body;

    // 단일 경로 또는 여러 경로 지원
    let paths = [];
    if (filePaths && Array.isArray(filePaths)) {
      paths = filePaths;
    } else if (filePath && typeof filePath === 'string') {
      paths = [filePath];
    } else {
      return res.status(400).json({
        success: false,
        message: '파일 경로가 필요합니다. (filePath 또는 filePaths)',
        error: 'MissingPath'
      });
    }

    // 로깅
    console.log(`[S3Controller] CloudFront 캐시 무효화 요청:`, { 
      pathCount: paths.length,
      paths: paths 
    });

    // 여러 경로를 한 번에 무효화 (배치 처리)
    const result = await s3Service.invalidateCloudFrontCacheBatch(paths);

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: '캐시 무효화가 성공적으로 요청되었습니다.',
        invalidationId: result.invalidationId,
        status: result.status,
        pathCount: result.pathCount,
        paths: result.paths
      });
    } else {
      // 스킵된 경우 (예: Distribution ID 미설정)
      if (result.skipped) {
        return res.status(200).json({
          success: false,
          message: result.message || '캐시 무효화가 스킵되었습니다.',
          skipped: true
        });
      }

      const statusCode = result.error === 'AccessDenied' ? 403 : 500;
      return res.status(statusCode).json({
        success: false,
        message: result.message || '캐시 무효화에 실패했습니다.',
        error: result.error || 'UnknownError'
      });
    }
  } catch (error) {
    console.error('[S3Controller] 캐시 무효화 오류:', error);
    return res.status(500).json({
      success: false,
      message: '캐시 무효화 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * S3 파일 삭제
 * DELETE /api/s3/file
 */
const deleteFile = async (req, res) => {
  try {
    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: '파일 경로가 필요합니다.',
        error: 'MissingPath'
      });
    }

    // 로깅
    console.log(`[S3Controller] 파일 삭제 요청:`, { filePath });

    const result = await s3Service.deleteFile(filePath);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'NoSuchKey' ? 404 :
                        result.error === 'AccessDenied' ? 403 :
                        result.error === 'InvalidPath' || result.error === 'EmptyPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 파일 삭제 오류:', error);
    return res.status(500).json({
      success: false,
      message: '파일을 삭제하는 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * 파일/폴더명 수정 (통합 API)
 * PUT /api/s3/rename
 */
const rename = async (req, res) => {
  try {
    const { oldPath, newName } = req.body;

    if (!oldPath || !newName) {
      return res.status(400).json({
        success: false,
        message: '기존 경로와 새로운 이름이 필요합니다.',
        error: 'MissingPath'
      });
    }

    const result = await s3Service.rename(oldPath, newName);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'NoSuchKey' ? 404 :
                        result.error === 'AccessDenied' ? 403 :
                        result.error === 'InvalidPath' || result.error === 'MissingPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 이름 수정 오류:', error);
    return res.status(500).json({
      success: false,
      message: '이름 수정 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

/**
 * 파일/폴더 이동 (통합 API)
 * POST /api/s3/move
 */
const move = async (req, res) => {
  try {
    const { sourcePath, targetPath } = req.body;

    if (!sourcePath || !targetPath) {
      return res.status(400).json({
        success: false,
        message: '원본 경로와 대상 경로가 필요합니다.',
        error: 'MissingPath'
      });
    }

    const result = await s3Service.move(sourcePath, targetPath);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      const statusCode = result.error === 'NoSuchKey' ? 404 :
                        result.error === 'AccessDenied' ? 403 :
                        result.error === 'InvalidPath' || result.error === 'MissingPath' ? 400 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('[S3Controller] 이동 오류:', error);
    return res.status(500).json({
      success: false,
      message: '이동 중 오류가 발생했습니다.',
      error: 'InternalServerError'
    });
  }
};

module.exports = {
  listFiles,
  getFileContent,
  saveFile,
  createFolder,
  rename,
  deleteFile,
  move,
  invalidateCache
};

