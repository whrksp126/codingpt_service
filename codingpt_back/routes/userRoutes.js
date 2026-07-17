const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const {
  login,
  loginLocal,
  logout,
  verifyAccessToken,
  refreshAccessToken,
  updateUser, 
  deleteUser,
  getAllUsers, 
  getUserById, 
  updateUserXp,
  getAchievements,
  getStudyHeatmap,
  getTotalStudyDays,
  createStudyHeatmap,
} = require('../controllers/userController');

// 사용자 관련 라우트
router.post('/login', login);                   // 로그인 (구글 OAuth)
router.post('/login-local', loginLocal);        // 로컬 ID/PW 로그인 (심사용 계정)
router.post('/logout', logout);                 // 로그아웃
router.get('/verify', verifyAccessToken);       // 엑세스 토큰 검증
router.post('/refresh', refreshAccessToken);    // 엑세스 토큰 재발급

router.get('/', getAllUsers);                   // 모든 사용자 조회
router.get('/heatmap', authMiddleware, getStudyHeatmap); // 사용자 잔디 조회(일자별 학습 횟수 조회)
router.get('/study-days', authMiddleware, getTotalStudyDays); // 누적 학습일수 조회
router.get('/me', authMiddleware, getUserById); // 특정 사용자 조회
router.put('/:id', updateUser);                 // 사용자 정보 수정
router.delete('/:id', authMiddleware, deleteUser); // 회원 탈퇴 — 인증 필수 + 컨트롤러가 본인만 허용(IDOR 차단)
router.patch('/:id/xp', updateUserXp);          // 사용자 XP 업데이트
router.get('/achievements', authMiddleware, getAchievements); // 업적 조회
router.post('/heatmap', createStudyHeatmap);    // 학습 히트맵 로그 생성

module.exports = router;