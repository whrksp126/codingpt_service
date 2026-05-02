const executorService = require('../services/executorService');
const previewService = require('../services/previewService');
const s3Service = require('../services/s3Service');
const path = require('path');

/**
 * 코드 실행
 * POST /api/executor/execute
 */
const executeCode = async (req, res) => {
  try {
    let { code, language } = req.body;
    if (language === 'js') {
      language = 'javascript';
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        message: '코드가 필요합니다.'
      });
    }

    await executorService.executeCode(code, language, res);
  } catch (error) {
    console.error('[ExecutorController] 코드 실행 오류:', error);
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        message: error.message || '코드 실행 중 오류가 발생했습니다.'
      });
    }
  }
};

/**
 * S3 파일 기반 코드 실행
 * POST /api/executor/execute-s3
 */
const executeS3File = async (req, res) => {
  try {
    const { s3Path, fileName, language } = req.body;

    if (!s3Path || typeof s3Path !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'S3 경로가 필요합니다.'
      });
    }

    // 파일명이 없으면 에러
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({
        success: false,
        message: '파일명이 필요합니다.'
      });
    }

    // S3 경로 정규화
    let normalizedDir = s3Path.replace(/^\/+|\/+$/g, '');
    if (!normalizedDir.startsWith('codingpt/execute/')) {
      normalizedDir = `codingpt/execute/${normalizedDir}`;
    }
    const normalizedPath = `${normalizedDir}/${fileName}`;

    // S3에서 파일 내용 가져오기
    const fileResult = await s3Service.getFileContent(normalizedPath);

    if (!fileResult.success) {
      const statusCode = fileResult.error === 'NoSuchKey' ? 404 :
        fileResult.error === 'AccessDenied' ? 403 : 500;
      return res.status(statusCode).json({
        success: false,
        message: fileResult.message || 'S3 파일을 불러올 수 없습니다.',
        error: fileResult.error
      });
    }

    // 파일 내용
    let code = fileResult.content;

    // base64 인코딩된 경우 디코딩
    if (fileResult.encoding === 'base64') {
      code = Buffer.from(code, 'base64').toString('utf-8');
    }

    // 언어 자동 판단 또는 명시적 언어 사용
    const detectedLanguage = language || executorService.detectLanguageFromFile(fileName);

    if (!detectedLanguage) {
      return res.status(400).json({
        success: false,
        message: `파일 확장자로 언어를 판단할 수 없습니다: ${fileName}. language 파라미터를 제공해주세요.`
      });
    }

    // 코드 실행 (SSE 스트림)
    await executorService.executeCodeFromFile(code, fileName, detectedLanguage, res);
  } catch (error) {
    console.error('[ExecutorController] S3 파일 실행 오류:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message || 'S3 파일 실행 중 오류가 발생했습니다.'
      });
    }
  }
};

/**
 * 프리뷰 세션 생성
 * POST /api/executor/preview
 */
const createPreview = async (req, res) => {
  try {
    const { s3Path, fileName } = req.body;

    if (!s3Path || typeof s3Path !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'S3 경로가 필요합니다.'
      });
    }

    // fileName이 없으면 자동으로 index.html 찾기
    let targetFileName = fileName || 'index.html';
    if (!fileName) {
      const foundFileName = await s3Service.findIndexHtml(s3Path);
      if (foundFileName) {
        targetFileName = foundFileName;
      }
    }

    // S3 파일 존재 확인
    let normalizedDir = s3Path.replace(/^\/+|\/+$/g, '');
    if (!normalizedDir.startsWith('codingpt/execute/')) {
      normalizedDir = `codingpt/execute/${normalizedDir}`;
    }
    const normalizedPath = `${normalizedDir}/${targetFileName}`;

    const fileExists = await previewService.checkS3FileExists(normalizedPath);
    if (!fileExists) {
      return res.status(404).json({
        success: false,
        message: `S3 경로에 파일이 없습니다: ${normalizedPath}`,
        s3Path: normalizedPath
      });
    }

    // 프리뷰 세션 생성
    const session = previewService.createPreviewSession(s3Path, targetFileName);

    res.json({
      success: true,
      previewUrl: session.previewUrl,
      s3Path: session.s3Path,
      sessionId: session.sessionId,
      expiresIn: session.expiresIn,
      message: '프리뷰 URL이 생성되었습니다. (5분 유효)'
    });
  } catch (error) {
    console.error('[ExecutorController] 프리뷰 생성 오류:', error);
    res.status(500).json({
      success: false,
      message: error.message || '프리뷰 URL 생성에 실패했습니다.'
    });
  }
};

/**
 * 프리뷰 파일 제공
 * GET /api/executor/:sessionId/*
 */
const servePreview = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const requestedFile = req.params[0] || 'index.html';

    if (!sessionId.startsWith('preview-')) {
      return res.status(404).send('Not Found');
    }

    const session = previewService.getSession(sessionId);

    if (!session) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>프리뷰 만료</title></head>
        <body><h1>프리뷰가 만료되었습니다</h1></body>
        </html>
      `);
    }

    // 만료 확인
    if (Date.now() > session.expiresAt) {
      previewService.expireSession(sessionId);
      return res.status(410).send(`
        <!DOCTYPE html>
        <html>
        <head><title>프리뷰 만료</title></head>
        <body><h1>프리뷰가 만료되었습니다</h1></body>
        </html>
      `);
    }

    // S3에서 파일 가져오기
    const fullS3Path = `${session.baseDir}/${requestedFile}`;
    const fileData = await previewService.getS3File(fullS3Path);

    // Content-Type 설정
    const ext = path.extname(requestedFile).toLowerCase();
    let contentType = fileData.contentType;
    if (ext === '.css') {
      contentType = 'text/css; charset=utf-8';
    } else if (ext === '.js') {
      contentType = 'application/javascript; charset=utf-8';
    } else if (ext === '.html' || ext === '') {
      contentType = 'text/html; charset=utf-8';
    }

    res.setHeader('Content-Type', contentType);

    // HTML 파일인 경우 세션 활성화 및 스크립트 삽입
    if (ext === '.html' || ext === '') {
      session.isActive = true;
      session.accessedAt = Date.now();

      let htmlContent = fileData.content;
      const baseUrl = `/api/executor/${sessionId}/`;

      // <base> 태그 삽입
      const baseTag = `<base href="${baseUrl}">`;
      if (htmlContent.includes('<head>')) {
        htmlContent = htmlContent.replace('<head>', `<head>\n    ${baseTag}`);
      } else if (htmlContent.includes('<html>')) {
        htmlContent = htmlContent.replace('<html>', `<html>\n  <head>\n    ${baseTag}\n  </head>`);
      } else {
        htmlContent = `<head>\n    ${baseTag}\n  </head>\n${htmlContent}`;
      }

      // 페이지 이탈 감지 스크립트
      const expireScript = `
        <script>
          (function() {
            let sessionId = '${sessionId}';
            let hasExpired = false;
            function expireSession() {
              if (hasExpired) return;
              hasExpired = true;
              fetch('/api/executor/' + sessionId + '/expire', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              }).catch(() => {});
            }
            window.addEventListener('beforeunload', expireSession);
            document.addEventListener('visibilitychange', function() {
              if (document.hidden) expireSession();
            });
            window.addEventListener('pagehide', expireSession);
            window.addEventListener('unload', expireSession);
          })();
        </script>
      `;

      if (htmlContent.includes('</body>')) {
        htmlContent = htmlContent.replace('</body>', expireScript + '</body>');
      } else {
        htmlContent += expireScript;
      }

      res.send(htmlContent);
    } else {
      res.send(fileData.content);
    }
  } catch (error) {
    console.error('[ExecutorController] 프리뷰 파일 제공 오류:', error);

    if (error.message.includes('404') || error.message.includes('403')) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>파일을 찾을 수 없습니다</title></head>
        <body><h1>파일을 찾을 수 없습니다</h1></body>
        </html>
      `);
    }

    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><title>오류</title></head>
      <body><h1>오류 발생</h1><p>${error.message}</p></body>
      </html>
    `);
  }
};

/**
 * 프리뷰 세션 만료
 * POST /api/executor/:sessionId/expire
 */
const expirePreview = (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId.startsWith('preview-')) {
    return res.status(404).json({ success: false, message: 'Not Found' });
  }

  const expired = previewService.expireSession(sessionId);

  if (expired) {
    res.json({ success: true, message: '프리뷰 세션이 만료되었습니다.' });
  } else {
    res.json({ success: false, message: '세션을 찾을 수 없습니다.' });
  }
};

/**
 * 헬스 체크
 * GET /api/executor/health
 */
const healthCheck = (req, res) => {
  res.json({ status: 'ok', service: 'executor' });
};

module.exports = {
  executeCode,
  executeS3File,
  createPreview,
  servePreview,
  expirePreview,
  healthCheck
};

