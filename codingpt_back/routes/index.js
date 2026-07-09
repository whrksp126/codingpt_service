const express = require('express');
const router = express.Router();
const userRoutes = require('./userRoutes');
const productRoutes = require('./productRoutes');
const classRoutes = require('./classRoutes');
const storeRoutes = require('./storeRoutes');
const myclassRoutes = require('./myclassRoutes');
const lessonRoutes = require('./lessonRoutes');
const executorRoutes = require('./executorRoutes');
const reviewRoutes = require('./reviewRoutes');
const s3Routes = require('./s3Routes');
const ttsRoutes = require('./ttsRoutes');
const contentTreeRoutes = require('./contentTreeRoutes');
const githubRoutes = require('./githubRoutes');
const githubRepoRoutes = require('./githubRepoRoutes');
const adminUsageRoutes = require('./adminUsageRoutes');
const workspaceRoutes = require('./workspaceRoutes');
const previewRoutes = require('./previewRoutes');
const terminalRoutes = require('./terminalRoutes');
const usageRoutes = require('./usageRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const billingRoutes = require('./billingRoutes');
const onboardingRoutes = require('./onboardingRoutes');
const daemonRoutes = require('./daemonRoutes');
const pushRoutes = require('./pushRoutes');

// API 라우트 설정
router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/classes', classRoutes);
router.use('/store', storeRoutes);
router.use('/myclass', myclassRoutes);
router.use('/lesson', lessonRoutes);
router.use('/executor', executorRoutes);
router.use('/reviews', reviewRoutes);
router.use('/s3', s3Routes);
router.use('/tts', ttsRoutes);
router.use('/admin/github-repos', githubRepoRoutes);
router.use('/admin/usage', adminUsageRoutes); // 사용량 실측 집계(어드민)
router.use('/admin', contentTreeRoutes);
router.use('/github', githubRoutes);
router.use('/workspaces', workspaceRoutes);
router.use('/preview', previewRoutes); // 바이브코딩 dev 서버 미리보기 프록시
router.use('/terminal', terminalRoutes); // 인터랙티브 PTY 터미널(ws 업그레이드는 app.js 에서)
router.use('/usage', usageRoutes); // 사용량 미터링 조회
router.use('/subscription', subscriptionRoutes); // 구독 플랜/상태
router.use('/billing', billingRoutes); // 충전/결제/크레딧
router.use('/onboarding', onboardingRoutes); // 온보딩 설문(익명)
router.use('/daemon', daemonRoutes); // BYO-PC 데몬 페어링/상태(ws 업그레이드는 app.js 에서)
router.use('/push', pushRoutes); // 푸시 기기 등록/해제(M3-3)
// 한시적 호환 alias — 구버전 앱(/api/projects) 대비. 신규 코드는 /workspaces 사용.
router.use('/projects', workspaceRoutes);

// API 루트 엔드포인트
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'CodingPT API 서버',
    version: '1.0.0',
    endpoints: {
      users: '/api/users',
      products: '/api/products',
      classes: '/api/classes',
      store: '/api/store',
      myclass: '/api/myclass',
      lesson: '/api/lesson',
      executor: '/api/executor',
      reviews: '/api/reviews',
      s3: '/api/s3',
      tts: '/api/tts'
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;