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
const errorResponse = (res, error, statusCode = 500) => {
  const errorMessage = error.message || 'Internal Server Error';
  const errorDetails = process.env.NODE_ENV === 'local' ? error.stack : undefined;
  
  res.status(statusCode).json({
    success: false,
    message: errorMessage,
    error: errorDetails,
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