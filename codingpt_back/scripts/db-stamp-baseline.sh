#!/bin/sh
# 베이스라인 SQL(db/backups/full_*.sql) 복원 직후 1회 실행.
# 이미 스키마가 존재하는 DB에서 sequelize 마이그레이션을 "적용된 셈"으로 표시.
# Heyvoca의 `flask db stamp head`와 동일한 역할.

set -e

INITIAL_MIGRATION="20260504000000-initial-schema.js"

if [ -z "$DB_HOST" ] || [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  echo "ERROR: DB_HOST / DB_USER / DB_NAME 환경 변수가 필요합니다."
  echo "예: set -a && source .env.local && set +a && bash scripts/db-stamp-baseline.sh"
  exit 1
fi

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" <<SQL
CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
  "name" VARCHAR(255) NOT NULL PRIMARY KEY
);
INSERT INTO "SequelizeMeta" ("name") VALUES ('${INITIAL_MIGRATION}')
ON CONFLICT ("name") DO NOTHING;
SQL

echo ">>> Stamp 완료: ${INITIAL_MIGRATION} 표시됨."
echo ">>> 다음 컨테이너 시작 시 db:migrate가 베이스라인 이후 신규 마이그레이션만 적용합니다."
