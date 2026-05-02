const { errorResponse } = require('../utils/response');

// 에러 핸들링 미들웨어
const errorHandler = (err, req, res, next) => {
  console.error('에러 발생:', err);

  // Sequelize 유효성 검사 에러
  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({
      success: false,
      message: '입력 데이터가 유효하지 않습니다.',
      errors: err.errors.map(e => ({
        field: e.path,
        message: e.message
      })),
      timestamp: new Date().toISOString()
    });
  }

  // Sequelize 고유 제약 조건 위반
  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      success: false,
      message: '이미 존재하는 데이터입니다.',
      errors: err.errors.map(e => ({
        field: e.path,
        message: e.message
      })),
      timestamp: new Date().toISOString()
    });
  }

  // Sequelize 연결 에러
  if (err.name === 'SequelizeConnectionError') {
    return res.status(503).json({
      success: false,
      message: '데이터베이스 연결에 실패했습니다.',
      timestamp: new Date().toISOString()
    });
  }

  // 기본 서버 에러
  errorResponse(res, err, err.status || 500);
};

module.exports = errorHandler; 