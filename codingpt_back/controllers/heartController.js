const heartService = require('../services/heartService');
const { successResponse, errorResponse } = require('../utils/response');

// 내 하트 조회
const getMyHearts = async (req, res) => {
    try {
      const userId = req.user.id; // ✅ authMiddleware에서 주입됨
      const data = await heartService.getHearts(userId);
  
      return res.status(200).json({
        success: true,
        data: data,
      });
    } catch (error) {
      console.error('하트 조회 실패:', error);
      return res.status(500).json({ success: false, message: '서버 오류' });
    }
};

// 내 하트 차감
const spendOneHeart = async (req, res) => {
    try {
    //   console.log('하트 차감 진입');
      const userId = req.user.id; // ✅ authMiddleware에서 주입됨
    //   console.log('jwt 인증 됨', userId);

      const result = await heartService.spendOneHeart(userId);
    //   console.log('서비스 갔다옴', result);
  
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error('하트 차감 실패:', error);
      return res.status(500).json({ success: false, message: '서버 오류' });
    }
};

module.exports = {
    getMyHearts,
    spendOneHeart,
};