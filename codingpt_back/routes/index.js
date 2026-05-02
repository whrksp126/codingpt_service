const express = require('express');
const router = express.Router();
const userRoutes = require('./userRoutes');
const productRoutes = require('./productRoutes');
const classRoutes = require('./classRoutes');
const storeRoutes = require('./storeRoutes');
const myclassRoutes = require('./myclassRoutes');
const lessonRoutes = require('./lessonRoutes');
const heartRoutes = require('./heartRoutes');
const executorRoutes = require('./executorRoutes');
const reviewRoutes = require('./reviewRoutes');
const s3Routes = require('./s3Routes');
const ttsRoutes = require('./ttsRoutes');

// API 라우트 설정
router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/classes', classRoutes);
router.use('/store', storeRoutes);
router.use('/myclass', myclassRoutes);
router.use('/lesson', lessonRoutes);
router.use('/hearts', heartRoutes);
router.use('/executor', executorRoutes);
router.use('/reviews', reviewRoutes);
router.use('/s3', s3Routes);
router.use('/tts', ttsRoutes);

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
      hearts: '/api/hearts',
      executor: '/api/executor',
      reviews: '/api/reviews',
      s3: '/api/s3',
      tts: '/api/tts'
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;