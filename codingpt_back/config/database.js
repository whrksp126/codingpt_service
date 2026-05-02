// config/config.js
require('dotenv').config(); // 로컬/테스트에만 영향. 컨테이너 런타임은 --env-file로 주입됨.

const base = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 5432),
  dialect:  'postgres',
  dialectOptions: {
    ssl: { require: true, rejectUnauthorized: false },
  },
};

// 로컬 도커 PostgreSQL은 SSL 불필요
const baseLocal = {
  ...base,
  dialectOptions: {},
};

module.exports = {
  // 로컬 개발: nodemon, ts-node 등
  local: {
    ...baseLocal,
    logging: console.log,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  },

  // 개발 서버(또는 개발용 도커): dev
  development: {
    ...base,
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