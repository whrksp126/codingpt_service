const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const config = require('../config/database');

const env = process.env.NODE_ENV || 'local';
const dbConfig = config[env];

// Sequelize 인스턴스 생성
const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  {
    host: dbConfig.host,
    port: dbConfig.port,
    dialect: dbConfig.dialect,
    logging: dbConfig.logging,
    pool: dbConfig.pool,
    dialectOptions: dbConfig.dialectOptions
  }
);

const models = {};
const basename = path.basename(__filename);

// 모델 파일들을 로드
fs.readdirSync(__dirname)
  .filter(file => {
    return (
      file !== basename &&
      file.endsWith('.js')
    );
  })
  .forEach(file => {
    const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
    
    // 모델 이름을 원래 대소문자 그대로 저장
    const modelKey = model.name; // 'User', 'Product', 'Class' 등
    models[modelKey] = model;
  });

// 모델 간의 관계 설정
Object.values(models).forEach(model => {
  if (typeof model.associate === 'function') {
    model.associate(models);
  }
});

console.log('✅ 모델 로딩 완료:', Object.keys(models));

// Sequelize 인스턴스도 함께 export
models.sequelize = sequelize;
models.Sequelize = Sequelize;

module.exports = models;
