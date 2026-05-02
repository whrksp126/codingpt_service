const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.ACCESS_SECRET;

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
  
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: '인증 토큰이 없습니다.' });
    }
  
    const token = authHeader.split(' ')[1];
  
    try {
      const decoded = jwt.verify(token, ACCESS_SECRET); // ✅ ACCESS_SECRET으로 검증
      req.user = decoded; // 이후 req.user.id로 사용 가능
      next();
    } catch (error) {
      console.error('토큰 검증 실패:', error.message);
      return res.status(401).json({ success: false, message: '유효하지 않은 토큰입니다.' });
    }
  };
  
  module.exports = authMiddleware;