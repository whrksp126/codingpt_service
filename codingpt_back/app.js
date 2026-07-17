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
// API 응답에 ETag/304 비활성화 — 모바일 앱은 HTTP 캐시 레이어가 없어 304(빈 본문)를 못 다룸.
// 조건부 GET 으로 인한 304 → 항상 200+본문 반환(예: 워크스페이스 세션 목록).
app.set('etag', false);
const PORT = process.env.PORT || 3000;

// CORS 설정 (실무 환경)
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173', // React 개발 서버
  'http://localhost:3001', // 다른 프론트엔드 포트
  'http://192.168.153.122:3100', // GH_Home -> MacBook Pro
  'http://10.0.2.2:3100', // React Native Android 에뮬레이터
  'http://10.0.2.2:8381', // React Native Metro 번들러
  'http://localhost:3400', // 로컬 공개 웹(Next.js front)
  // 공개 웹(랜딩+결제+웹 바이브코딩) — 정식 도메인 codingpt.ghmate.com + 별칭 codingpt-front
  'https://codingpt.ghmate.com',
  'https://dev-codingpt.ghmate.com',
  'https://stg-codingpt.ghmate.com',
  'https://dev-codingpt-front.ghmate.com',
  'https://stg-codingpt-front.ghmate.com',
  'https://codingpt-front.ghmate.com',
  // 어드민(독립 프로젝트) 도메인
  'https://dev-codingpt-admin.ghmate.com',
  'https://stg-codingpt-admin.ghmate.com',
  'https://codingpt-admin.ghmate.com'
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

// PortOne 웹훅 — 서명 검증을 위해 raw body 가 필요하므로 전역 JSON 파서 "앞"에 마운트.
// (authMiddleware 없음 — 서명 검증 + getPayment 재조회로 신뢰)
const webhookController = require('./controllers/webhookController');
app.post('/api/billing/webhook', express.raw({ type: '*/*' }), webhookController.handlePortoneWebhook);

// BYO-PC 프리뷰 — dpv 쿠키가 있는 non-/api 루트 요청을 데몬 dev 서버로 프록시(Vite 절대경로/에셋).
//  JSON 파서 "앞": 프록시는 요청 본문을 raw 로 파이프하므로 파서가 먼저 소비하면 안 됨. (/api 요청은 즉시 next)
app.use(require('./controllers/daemonController').previewCookieMiddleware);

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
    const server = app.listen(PORT, () => {
      console.log(`🚀 서버가 http://localhost:${PORT}에서 실행 중입니다!`);
      console.log(`👥 사용자 API: http://localhost:${PORT}/api/users`);
      console.log(`🌍 환경: ${process.env.NODE_ENV || 'local'}`);
    });

    // 구독 갱신 / 크레딧 만료 스위퍼 (cron 없이 setInterval)
    try {
      require('./services/billingSweeper').start();
    } catch (e) {
      console.error('[app] billingSweeper 시작 실패:', e.message);
    }

    // 미리보기 HMR(WebSocket) 업그레이드 프록시 — /api/preview/:token/* 의 ws 를 워커→샌드박스 dev 서버로 포워딩.
    // (Express 라우트는 ws 업그레이드를 처리하지 않으므로 http.Server 레벨에서 직접 처리)
    const previewProxyController = require('./controllers/previewProxyController');
    const terminalProxyController = require('./controllers/terminalProxyController');
    const agentProxyService = require('./services/agentProxyService');
    const daemonRelayService = require('./services/daemonRelayService');
    // 단일 upgrade 핸들러에서 분기(리스너 2개면 비매칭 경로를 서로 destroy 하므로 한 곳에서 처리).
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      // BYO-PC 데몬 — 제어 채널(데몬 아웃바운드, Bearer deviceToken 인증)
      if (url === '/api/daemon/connect' || url.startsWith('/api/daemon/connect?')) {
        daemonRelayService.handleControlUpgrade(req, socket, head);
        return;
      }
      // BYO-PC 데몬 — dial-back 스트림(데몬→back, stream_open 지시에 대한 응답)
      const dsm = url.match(/^\/api\/daemon\/stream\/([^/?]+)/);
      if (dsm) {
        daemonRelayService.handleStreamUpgrade(dsm[1], req, socket, head);
        return;
      }
      // BYO-PC 데몬 — 에이전트 이벤트 WSS(M3-1, JWT=쿼리 토큰). SSE(/events)와 병행.
      const asm = url.match(/^\/api\/daemon\/agent\/stream(?:\?|$)/);
      if (asm) {
        const token = new URLSearchParams(url.split('?')[1] || '').get('token') || '';
        daemonRelayService.handleAgentStreamUpgrade(token, req, socket, head);
        return;
      }
      // BYO-PC 데몬 — 앱 터미널(불투명 토큰, /api/daemon/terminal/start 에서 발급)
      const dtm = url.match(/^\/api\/daemon\/terminal\/([^/?]+)/);
      if (dtm) {
        daemonRelayService.handleAppTerminalUpgrade(dtm[1], req, socket, head);
        return;
      }
      // 인터랙티브 PTY 터미널
      const tm = url.match(/^\/api\/terminal\/([^/?]+)/);
      if (tm) {
        const tsess = terminalProxyController.resolveToken(tm[1]);
        if (!tsess) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
        agentProxyService.proxyTerminalWs(req, socket, head, { userId: tsess.userId, projectId: tsess.projectId });
        return;
      }
      // 미리보기 HMR
      const m = url.match(/^\/api\/preview\/([^/?]+)/);
      if (m) {
        const sess = previewProxyController.resolveToken(m[1]);
        if (!sess) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
        agentProxyService.proxyDevWs(req, socket, head, { userId: sess.userId });
        return;
      }
      // BYO-PC 데몬 프리뷰 HMR — 토큰 경로(:token) 또는 dpv 쿠키 기반 루트 WS(사용자 Vite HMR)
      const daemonController = require('./controllers/daemonController');
      const dpm = url.match(/^\/api\/daemon\/preview\/([^/?]+)(\/[^?]*)?/);
      if (dpm) {
        const sess = daemonController.resolvePreviewToken(dpm[1]);
        if (!sess) { try { socket.destroy(); } catch (_) { /* noop */ } return; }
        const connOpts = sess.runnerId != null ? { runnerId: sess.runnerId } : undefined;
        daemonRelayService.proxyWs(sess.userId, sess.port, dpm[2] || '/', req, socket, head, connOpts);
        return;
      }
      if (!url.startsWith('/api/')) {
        const mm = String(req.headers.cookie || '').match(/(?:^|;\s*)dpv=([^;]+)/);
        if (mm) {
          const sess = daemonController.resolvePreviewToken(decodeURIComponent(mm[1]));
          if (sess) {
            const connOpts = sess.runnerId != null ? { runnerId: sess.runnerId } : undefined;
            daemonRelayService.proxyWs(sess.userId, sess.port, url, req, socket, head, connOpts);
            return;
          }
        }
      }
      try { socket.destroy(); } catch (_) { /* noop */ }
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