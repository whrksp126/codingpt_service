const userService = require('../services/userService');
const { successResponse, errorResponse } = require('../utils/response');

// 로그인
const login = async (req, res) => {
  try {
    const { idToken } = req.body;
    const user = await userService.login(idToken);
    successResponse(res, user, '로그인이 성공적으로 완료되었습니다.');
  } catch (error) {
    console.error('로그인 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 로그아웃
const logout = async (req, res) => {
  try {
    const result = await userService.logout(req.headers.authorization);
    successResponse(res, result, '로그아웃이 완료되었습니다.');
  } catch (error) {
    console.error('로그아웃 오류:', error);
    errorResponse(res, { message: error.message }, 401);
  }
};

// 엑세스 토큰 검증
const verifyAccessToken = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: '토큰 없음' });

    const token = authHeader.split(' ')[1];
    const user = await userService.verifyAccessToken(token);
    successResponse(res, user, '토큰이 성공적으로 검증되었습니다.');
  } catch (error) {
    console.error('토큰 검증 오류:', error);
    errorResponse(res, { message: error.message }, 401);
  }
};

// 엑세스 토큰 재발급
const refreshAccessToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await userService.refreshAccessToken(refreshToken);
    successResponse(res, user, '엑세스 토큰이 성공적으로 재발급되었습니다.');
  } catch (error) {
    console.error('엑세스 토큰 재발급 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 사용자 정보 수정
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await userService.updateUser(id, req.body);
    successResponse(res, user, '사용자 정보가 성공적으로 수정되었습니다.');
  } catch (error) {
    console.error('사용자 수정 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 사용자 삭제
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    await userService.deleteUser(id);
    successResponse(res, null, '사용자가 성공적으로 삭제되었습니다.');
  } catch (error) {
    console.error('사용자 삭제 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 모든 사용자 조회
const getAllUsers = async (req, res) => {
  try {
    const users = await userService.getAllUsers();
    successResponse(res, users, '사용자 목록을 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('사용자 조회 오류:', error);
    errorResponse(res, error, 500);
  }
};

// 특정 사용자 조회
const getUserById = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await userService.getUserById(userId);
    successResponse(res, user, '사용자 정보를 성공적으로 조회했습니다.');
  } catch (error) {
    console.error('사용자 조회 오류:', error);
    errorResponse(res, { message: error.message }, 404);
  }
};

// 사용자 XP 업데이트
const updateUserXp = async (req, res) => {
  try {
    const { id } = req.params;
    const { xp } = req.body;

    const result = await userService.updateUserXp(id, xp);
    successResponse(res, result, '사용자 XP가 성공적으로 업데이트되었습니다.');

  } catch (error) {
    console.error('사용자 XP 업데이트 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 사용자 하트 업데이트
const updateUserHeart = async (req, res) => {
  try {
    const { id } = req.params;
    const { heart } = req.body;
    const result = await userService.updateUserHeart(id, heart);
    successResponse(res, result, '사용자 하트가 성공적으로 업데이트되었습니다.');
  } catch (error) {
    console.error('사용자 하트 업데이트 오류:', error);
    errorResponse(res, { message: error.message }, 400);
  }
};

// 잔디 조회: 학습 히트맵 데이터
const getStudyHeatmap = async (req, res) => {
  try {
    const userId = req.user.id; // ✅ authMiddleware에서 주입됨
    const heatmapData = await userService.getStudyHeatmap(userId);

    return res.status(200).json({
      success: true,
      data: heatmapData,
    });
  } catch (error) {
    console.error('Heatmap 조회 실패:', error);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
};

// 누적 학습일수 조회 (전체 기간)
const getTotalStudyDays = async (req, res) => {
  try {
    const userId = req.user.id;
    const studyDays = await userService.getTotalStudyDays(userId);

    return res.status(200).json({
      success: true,
      data: studyDays,
    });
  } catch (error) {
    console.error('학습일수 조회 실패:', error);
    return res.status(500).json({ success: false, message: '서버 오류' });
  }
};

// 잔디 생성: 학습 히트맵 로그 생성
const createStudyHeatmap = async (req, res) => {
  try {
    let { user_id, product_id, section_id, lesson_id } = req.body;
    if (!user_id || !product_id || !section_id || !lesson_id) {
      throw new Error('필수 파라미터가 누락되었습니다.');
    }

    const created_at = new Date(); // TIMESTAMP NOT NULL
    const response = await userService.createStudyHeatmap(user_id, product_id, section_id, lesson_id, created_at);
    if (response) {
      successResponse(res, response, '학습 히트맵 로그가 성공적으로 생성되었습니다.');
    } else {
      errorResponse(res, '학습 히트맵 로그 생성 실패', 400);
    }
  } catch (error) {
    console.error('학습 히트맵 로그 생성 오류:', error);
  }
};

module.exports = {
  login,
  logout,
  verifyAccessToken,
  refreshAccessToken,
  updateUser,
  deleteUser,
  getAllUsers,
  getUserById,
  updateUserXp,
  updateUserHeart,
  getStudyHeatmap,
  getTotalStudyDays,
  createStudyHeatmap,
};