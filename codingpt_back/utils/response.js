// // 성공 응답
// const successResponse = (res, data, message = 'Success', statusCode = 200) => {
//   res.status(statusCode).json({
//     success: true,
//     message,
//     data,
//     timestamp: new Date().toISOString()
//   });
// };
// 성공 응답
const successResponse = (res, data, message = 'Success', statusCode = 200) => {
  res.status(statusCode).json(data);
};

// 에러 응답
//  error.publicDetail = 클라이언트가 분기해야 하는 구조화 정보(예: 승인 409 의 code/resolvedBy).
//  우리 코드가 명시적으로 붙일 때만 실린다 — node/sequelize 의 내부 error.code 는 노출하지 않는다.
const errorResponse = (res, error, statusCode = 500) => {
  const errorMessage = error.message || 'Internal Server Error';
  const errorDetails = process.env.NODE_ENV === 'local' ? error.stack : undefined;

  res.status(statusCode).json({
    success: false,
    message: errorMessage,
    error: errorDetails,
    ...(error.publicDetail && typeof error.publicDetail === 'object' ? { detail: error.publicDetail } : {}),
    timestamp: new Date().toISOString()
  });
};

// 페이지네이션 응답
const paginatedResponse = (res, data, page, limit, total, message = 'Success') => {
  const totalPages = Math.ceil(total / limit);
  
  res.json({
    success: true,
    message,
    data,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    },
    timestamp: new Date().toISOString()
  });
};

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse
}; 