// 환경 변수 로딩 (가장 먼저)
require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cors = require('cors');
const { sequelize } = require('./models');
const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const logger = require('./middlewares/logger');

// 환경 변수 디버깅 (개발 환경에서만)
if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local') {
  console.log('🔧 환경 변수 확인:');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('DB_HOST:', process.env.DB_HOST);
  console.log('DB_NAME:', process.env.DB_NAME);
  console.log('DB_USER:', process.env.DB_USER);
  console.log('DB_PORT:', process.env.DB_PORT);
  console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***설정됨***' : '***설정되지 않음***');
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정 (실무 환경)
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173', // React 개발 서버
  'http://localhost:3001', // 다른 프론트엔드 포트
  'http://192.168.153.122:3100', // GH_Home -> MacBook Pro
  'http://10.0.2.2:3100', // React Native Android 에뮬레이터
  'http://10.0.2.2:8381', // React Native Metro 번들러
  'https://dev-codingpt-front.ghmate.com',
  'https://stg-codingpt-front.ghmate.com',
  'https://codingpt-front.ghmate.com'
];

app.use(cors({
  origin: (origin, callback) => {
    console.log('🌐 CORS 요청 origin:', origin);
    
    // 개발 환경에서는 모든 origin 허용
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local') {
      console.log('✅ 개발 환경 - 모든 origin 허용');
      callback(null, true);
    } else {
      // 프로덕션에서는 허용된 origin만
      if (!origin || allowedOrigins.includes(origin)) {
        console.log('✅ 허용된 origin:', origin);
        callback(null, true);
      } else {
        console.log('❌ 차단된 origin:', origin);
        callback(new Error('CORS 정책에 의해 차단되었습니다.'));
      }
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  optionsSuccessStatus: 200
}));

// 미들웨어 설정
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 로깅 미들웨어
app.use(logger);

// API 라우트
app.use('/api', routes);

// [과거 프록시 방식 코드 - 주석 처리]
// 프리뷰 세션의 절대 경로 요청 처리 (Referer 기반)
// 예: /style.css 요청이 /api/executor/preview-xxx/index.html에서 온 경우
// -> /api/executor/preview-xxx/style.css로 리다이렉트
// 현재는 executor-server.js에서 직접 처리하므로 이 코드는 사용하지 않음
/*
app.use((req, res, next) => {
  // /api 경로는 제외
  if (req.path.startsWith('/api')) {
    return next();
  }
  
  // 정적 파일 확장자만 처리 (CSS, JS, 이미지, 폰트, 미디어 등)
  const staticExtensions = [
    // 스타일시트
    '.css',
    // 스크립트
    '.js', '.mjs',
    // 이미지
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif',
    // 폰트
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    // 미디어
    '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.flac', '.aac',
    // 기타
    '.json', '.xml', '.pdf', '.txt', '.csv'
  ];
  const hasStaticExtension = staticExtensions.some(ext => req.path.toLowerCase().endsWith(ext));
  
  if (hasStaticExtension && req.get('referer')) {
    const referer = req.get('referer');
    // Referer에서 /api/executor/preview-xxx/ 패턴 찾기
    const match = referer.match(/\/api\/executor\/(preview-[^\/]+)\//);
    if (match) {
      const sessionId = match[1];
      // 세션 경로로 리다이렉트
      const redirectPath = `/api/executor/${sessionId}${req.path}`;
      return res.redirect(redirectPath);
    }
  }
  
  next();
});
*/

// 404 핸들러
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: '요청한 리소스를 찾을 수 없습니다.',
    path: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// 에러 핸들링 미들웨어 (반드시 마지막에 위치)
app.use(errorHandler);

// 데이터베이스 연결 및 서버 시작
const startServer = async () => {
  try {
    console.log('🔍 데이터베이스 연결 시도 중...');
    console.log('📍 연결 대상:', process.env.DB_HOST);
    
    // 데이터베이스 연결 테스트
    await sequelize.authenticate();
    console.log('✅ 데이터베이스 연결 성공');

    // // 데이터베이스 동기화 (개발 환경에서만)
    // if (process.env.NODE_ENV === 'development') {
    //   console.log('🔄 데이터베이스 동기화 시작...');
    //   await sequelize.sync({ alter: true });
    //   console.log('✅ 데이터베이스 동기화 완료');
    // }

    // 서버 시작
    app.listen(PORT, () => {
      console.log(`🚀 서버가 http://localhost:${PORT}에서 실행 중입니다!`);
      console.log(`👥 사용자 API: http://localhost:${PORT}/api/users`);
      console.log(`🌍 환경: ${process.env.NODE_ENV || 'local'}`);
    });

  } catch (error) {
    console.error('❌ 서버 시작 실패:', error);
    console.error('🔍 에러 상세 정보:', {
      name: error.name,
      message: error.message,
      code: error.parent?.code,
      detail: error.parent?.detail
    });
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM 신호 수신, 서버 종료 중...');
  await sequelize.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT 신호 수신, 서버 종료 중...');
  await sequelize.close();
  process.exit(0);
});

startServer();