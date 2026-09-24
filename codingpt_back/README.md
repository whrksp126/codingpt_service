### 로컬(local) 개발 환경

## 컨테이너 중지(필요시)
docker stop codingpt_back_local

## 컨테이너 삭제(필요시)
docker rm codingpt_back_local

## 이미지 삭제(필요시)
docker rmi whrksp126/codingpt_back:local

## local 환경 실행
docker compose -f docker-compose.local.yml up --build

## local 환경 실행 (백그라운드)
docker compose -f docker-compose.local.yml up --build -d

## local 환경의 이미지 확인
docker images | grep codingpt_back

## local 허브에 local 태그로 푸쉬
docker push whrksp126/codingpt_back:local

---

### 데브(dev) 개발 환경

## 컨테이너 중지(필요시)
docker stop codingpt_back_dev

## 컨테이너 삭제(필요시)
docker rm codingpt_back_dev

## 이미지 삭제(필요시)
docker rmi whrksp126/codingpt_back:dev

## dev 환경 실행
docker compose -f docker-compose.dev.yml up --build

## dev 환경 실행 (백그라운드)
docker compose -f docker-compose.dev.yml up --build -d

## dev 환경 실행 컨테이너 중지
docker compose -f docker-compose.dev.yml down

## dev 환경의 이미지 확인
docker images | grep codingpt_back

## 도커 허브에 dev 태그로 푸쉬
docker push whrksp126/codingpt_back:dev

## 서버 적용
sudo systemctl restart codingpt_back_dev

---







# CodingPT Backend API Server

Express.js와 Sequelize를 사용한 RESTful API 서버입니다.

## 🏗️ 프로젝트 구조

```
src/
├── controllers/     # 비즈니스 로직 처리
├── routes/         # API 라우트 정의
├── models/         # 데이터베이스 모델
├── middlewares/    # 미들웨어
├── services/       # 복잡한 비즈니스 로직
├── utils/          # 유틸리티 함수
├── config/         # 설정 파일
└── app.js         # 메인 애플리케이션
```

## 🚀 시작하기

### 1. 의존성 설치
```bash
npm install
```

### 2. 환경 변수 설정
`.env.local` 파일을 생성하고 다음 내용을 추가하세요:
```env
NODE_ENV=development
DB_HOST=your-rds-endpoint
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_username
DB_PASSWORD=your_password
```

### 3. 서버 실행
```bash
# 개발 모드
npm run dev

# 프로덕션 모드
npm start
```

## 📡 API 엔드포인트

### 사용자 API
- `GET /api/users` - 모든 사용자 조회
- `GET /api/users/:id` - 특정 사용자 조회
- `PATCH /api/users/:id/xp` - 사용자 XP 업데이트
- `PATCH /api/users/:id/heart` - 사용자 하트 업데이트

### 제품 API
- `GET /api/products` - 모든 제품 조회
- `GET /api/products/type/:type` - 타입별 제품 조회
- `GET /api/products/:id` - 특정 제품 조회 (리뷰 포함)
- `GET /api/products/:id/classes` - 제품별 클래스 조회

### 클래스 API
- `GET /api/classes` - 모든 클래스 조회
- `GET /api/classes/:id` - 특정 클래스 조회 (섹션 포함)
- `GET /api/classes/:id/products` - 클래스별 제품 조회
- `GET /api/classes/:id/curriculums` - 클래스별 커리큘럼 조회

## 🛠️ 기술 스택

- **Node.js** - 런타임 환경
- **Express.js** - 웹 프레임워크
- **Sequelize** - ORM
- **PostgreSQL** - 데이터베이스
- **CORS** - 크로스 오리진 리소스 공유

## 📝 개발 가이드

### 새로운 API 추가하기

1. **컨트롤러 생성** (`src/controllers/`)
2. **라우트 정의** (`src/routes/`)
3. **라우트 등록** (`src/routes/index.js`)

### 에러 처리

모든 에러는 `src/middlewares/errorHandler.js`에서 일관되게 처리됩니다.

### 응답 형식

모든 API 응답은 다음 형식을 따릅니다:
```json
{
  "success": true,
  "message": "성공 메시지",
  "data": {},
  "timestamp": "2024-01-01T00:00:00.000Z"
}
``` 