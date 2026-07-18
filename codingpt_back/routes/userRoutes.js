const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middlewares/authMiddleware');

// 인증/토큰 엔드포인트 무차별 대입·코드 그라인딩 방지 — IP당 제한(15분/30회). 실패만 세지 않고 전량 카운트.
//  다기기 정상 사용(로그인/refresh)엔 넉넉하되, 자동화 공격은 차단하는 수준.
//  Cloudflare→nginx 뒤라 req.ip 는 매 요청 다른 엣지 IP 로 잡혀 카운터가 안 쌓인다 → 실제 클라이언트 IP
//  헤더(CF-Connecting-IP → X-Real-IP → X-Forwarded-For 첫 항목)로 키를 고정한다.
const realClientIp = (req) => {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xr = req.headers['x-real-ip'];
  if (xr) return String(xr).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip;
};
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: realClientIp,
  message: { success: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
});

const {
  login,
  appleLogin,
  loginLocal,
  registerLocal,
  handoffIssue,
  handoffRedeem,
  passwordForgot,
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
router.post('/login', authLimiter, login);                   // 로그인 (구글 OAuth)
router.post('/apple-login', authLimiter, appleLogin);        // 로그인 (Apple — iOS/웹/PC/안드로이드 공용)
router.post('/login-local', authLimiter, loginLocal);        // 로컬 ID/PW 로그인 (심사용 계정 + 일반 이메일 가입자)
router.post('/register-local', authLimiter, registerLocal);  // 이메일/비밀번호 회원가입 (일반 사용자)
router.post('/handoff/issue', authMiddleware, handoffIssue);  // 웹→앱 로그인 핸드오프 코드 발급(로그인 필요)
router.post('/handoff/redeem', authLimiter, handoffRedeem);  // 앱→토큰 핸드오프 코드 교환(무인증, 코드가 비밀)
router.post('/password/forgot', authLimiter, passwordForgot); // 비밀번호 찾기(재설정 요청) — 무인증, 존재 노출 없음
router.post('/logout', logout);                 // 로그아웃
router.get('/verify', verifyAccessToken);       // 엑세스 토큰 검증
router.post('/refresh', authLimiter, refreshAccessToken);    // 엑세스 토큰 재발급

router.get('/', authMiddleware, getAllUsers);   // 모든 사용자 조회 — 인증 필수(무인증 PII 덤프 차단)
router.get('/heatmap', authMiddleware, getStudyHeatmap); // 사용자 잔디 조회(일자별 학습 횟수 조회)
router.get('/study-days', authMiddleware, getTotalStudyDays); // 누적 학습일수 조회
router.get('/me', authMiddleware, getUserById); // 특정 사용자 조회
router.put('/:id', authMiddleware, updateUser); // 사용자 정보 수정 — 인증 필수 + 컨트롤러가 본인만 허용
router.delete('/:id', authMiddleware, deleteUser); // 회원 탈퇴 — 인증 필수 + 컨트롤러가 본인만 허용(IDOR 차단)
router.patch('/:id/xp', authMiddleware, updateUserXp); // 사용자 XP 업데이트 — 인증 필수 + 본인만
router.get('/achievements', authMiddleware, getAchievements); // 업적 조회
router.post('/heatmap', authMiddleware, createStudyHeatmap); // 학습 히트맵 로그 생성 — 인증 필수 + 본인만

module.exports = router;