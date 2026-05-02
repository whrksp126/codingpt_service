const executeService = require('../services/executeService');

/**
 * 코드를 실행하고 SSE로 결과를 전송
 */
const executeCode = async (req, res) => {
  const { code, language = 'javascript' } = req.body;

  // 코드가 없으면 에러
  if (!code || typeof code !== 'string') {
    return res.status(400).json({
      success: false,
      message: '코드가 필요합니다.'
    });
  }

  // 언어 검증
  const supportedLanguages = ['javascript', 'python'];
  const normalizedLanguage = language.toLowerCase();
  if (!supportedLanguages.includes(normalizedLanguage)) {
    return res.status(400).json({
      success: false,
      message: `지원하지 않는 언어입니다: ${language}. 지원 언어: ${supportedLanguages.join(', ')}`
    });
  }

  // SSE 헤더 설정
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 버퍼링 방지

  // 언어별 이름 매핑
  const languageNames = {
    javascript: 'JavaScript',
    python: 'Python'
  };

  // 로그 콜백 (시작/종료 메시지 등)
  // 시작 메시지는 코드 실행 서버에서 전송하므로 여기서는 전송하지 않음
  const onLog = (message) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'log', message: message })}\n\n`);
    } catch (err) {
      console.error('[ExecuteController] SSE 로그 전송 오류:', err.message);
    }
  };

  // 출력 콜백 (터미널 출력 - 실제 콘솔 출력만)
  const onOutput = (data) => {
    // 연결이 끊어져도 전송 시도 (프론트엔드가 받을 수 있으면 받음)
    try {
      res.write(`data: ${JSON.stringify({ type: 'output', data: data })}\n\n`);
    } catch (err) {
      console.error('[ExecuteController] SSE 출력 전송 오류:', err.message);
      if (!clientClosed) {
        clientClosed = true;
      }
    }
  };

  // 에러 콜백
  const onError = (data) => {
    // 연결이 끊어져도 전송 시도
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', data: data })}\n\n`);
    } catch (err) {
      console.error('[ExecuteController] SSE 에러 전송 오류:', err.message);
      if (!clientClosed) {
        clientClosed = true;
      }
    }
  };

  // 종료 콜백
  const onClose = (result) => {
    try {
      // 종료 메시지 전송
      // 1. 종료 로그 메시지
      try {
        res.write(`data: ${JSON.stringify({ 
          type: 'log', 
          message: `프로세스가 종료되었습니다. (종료 코드: ${result.exitCode})\n`
        })}\n\n`);
      } catch (logErr) {
        // 무시
      }
      
      // 2. close 이벤트 (메타데이터만)
      try {
        res.write(`data: ${JSON.stringify({ 
          type: 'close', 
          exitCode: result.exitCode,
          hasError: result.hasError
        })}\n\n`);
      } catch (writeErr) {
        // 무시
      }
      
      // 연결 종료
      try {
        res.end();
      } catch (endErr) {
        // 무시
      }
      clientClosed = true;
    } catch (err) {
      console.error('[ExecuteController] SSE 종료 처리 오류:', err);
      try {
        res.end();
      } catch (e) {}
      clientClosed = true;
    }
  };

  // 클라이언트 연결 종료 감지
  // 주의: req.on('close')는 요청 본문을 읽는 중에도 발생할 수 있음
  let clientClosed = false;
  let requestBodyRead = false;
  
  // 요청 본문이 완전히 읽혔는지 확인
  req.on('end', () => {
    requestBodyRead = true;
  });
  
  req.on('close', () => {
    // 요청 본문을 읽기 전에 close가 발생하면 무시 (정상적인 동작)
    if (!requestBodyRead) {
      return;
    }
    
    if (!clientClosed) {
      clientClosed = true;
      // 프론트엔드 연결이 끊어도 코드 실행 서버와의 연결은 유지
      // res.end()는 onClose에서 처리하므로 여기서는 호출하지 않음
    }
  });

  try {
    // 코드 실행
    await executeService.executeCode(code, normalizedLanguage, onLog, onOutput, onError, onClose);
  } catch (err) {
    console.error('[ExecuteController] 코드 실행 오류:', err);
    try {
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        data: `실행 중 오류가 발생했습니다: ${err.message}\n`
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ 
        type: 'close', 
        exitCode: -1,
        hasError: true,
        message: '실행 실패'
      })}\n\n`);
      res.end();
    } catch (writeErr) {
      console.error('에러 메시지 전송 실패:', writeErr);
      res.end();
    }
  }
};

module.exports = {
  executeCode
};

