// 요청 로깅 미들웨어
const logger = (req, res, next) => {
  const start = Date.now();
  
  // 응답 완료 후 로깅
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logMessage = `${new Date().toISOString()} - ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
    
    // 상태 코드에 따른 로그 레벨
    if (res.statusCode >= 400) {
      console.error(logMessage);
    } else {
      console.log(logMessage);
    }
  });
  
  next();
};

module.exports = logger; 