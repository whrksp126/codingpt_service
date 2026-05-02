const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const { 
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
} = require('../controllers/userController');

// 사용자 관련 라우트
router.post('/login', login);                   // 로그인
router.post('/logout', logout);                 // 로그아웃
router.get('/verify', verifyAccessToken);       // 엑세스 토큰 검증
router.post('/refresh', refreshAccessToken);    // 엑세스 토큰 재발급

router.get('/', getAllUsers);                   // 모든 사용자 조회
router.get('/heatmap', authMiddleware, getStudyHeatmap); // 사용자 잔디 조회(일자별 학습 횟수 조회)
router.get('/study-days', authMiddleware, getTotalStudyDays); // 누적 학습일수 조회
router.get('/me', authMiddleware, getUserById); // 특정 사용자 조회
router.put('/:id', updateUser);                 // 사용자 정보 수정
router.delete('/:id', deleteUser);              // 사용자 삭제
router.patch('/:id/xp', updateUserXp);          // 사용자 XP 업데이트
router.patch('/:id/heart', updateUserHeart);    // 사용자 하트 업데이트
router.post('/heatmap', createStudyHeatmap);    // 학습 히트맵 로그 생성

module.exports = router;