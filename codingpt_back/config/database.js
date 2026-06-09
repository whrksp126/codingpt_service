// config/config.js
require('dotenv').config(); // 로컬/테스트에만 영향. 컨테이너 런타임은 --env-file로 주입됨.

// SSL: 외부 관리형 DB(AWS RDS 등)는 필요, 홈서버/로컬 Docker PostgreSQL은 불필요.
// 환경별 기본값을 두되 DB_SSL=true|false 로 명시 오버라이드 가능.
// (RDS → 홈서버 이전 시 해당 환경 .env 에 DB_SSL=false 추가하면 SSL 비활성화)
const SSL_OPTION = { ssl: { require: true, rejectUnauthorized: false } };
function dialectOptions(defaultSsl) {
  const ssl = process.env.DB_SSL != null ? process.env.DB_SSL === 'true' : defaultSsl;
  return ssl ? { ...SSL_OPTION } : {};
}

const base = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 5432),
  dialect:  'postgres',
  dialectOptions: dialectOptions(true),
};

// 로컬 도커 PostgreSQL은 SSL 불필요
const baseLocal = {
  ...base,
  dialectOptions: dialectOptions(false),
};

module.exports = {
  // 로컬 개발: nodemon, ts-node 등
  local: {
    ...baseLocal,
    logging: console.log,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  },

  // 개발 서버(홈서버 도커 PostgreSQL): SSL 불필요
  development: {
    ...baseLocal,
    logging: console.log,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  },

  // 스테이징: prod과 거의 동일하지만 필요시 로깅/풀 크기 등 다르게
  staging: {
    ...base,
    logging: false,
    pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
  },

  // 프로덕션
  production: {
    ...base,
    logging: false,
    pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
  },

  // 테스트
  test: {
    ...base,
    database: process.env.DB_NAME_TEST || process.env.DB_NAME,
    logging: false,
  },
};