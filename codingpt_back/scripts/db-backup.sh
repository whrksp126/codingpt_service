#!/usr/bin/env bash
# DB 백업 관리 스크립트 — objectstore(MinIO)를 통한 팀 공유.
#
# 사용법:
#   set -a && source .env.local && set +a
#   bash scripts/db-backup.sh upload          # 현재 로컬 DB → objectstore 업로드 (날짜 자동)
#   bash scripts/db-backup.sh upload v2       # full_YYYYMMDD_v2.sql 로 업로드
#   bash scripts/db-backup.sh list            # objectstore에 저장된 백업 목록
#   bash scripts/db-backup.sh restore         # 가장 최신 백업으로 로컬 DB 복원
#   bash scripts/db-backup.sh restore full_20260523.sql   # 특정 파일로 복원
#   bash scripts/db-backup.sh pull            # 다운로드만 (복원 X)
#
# 필요 환경변수: DB_*, OBJECTSTORE_*
# 컨테이너명: codingpt_postgres_local (없으면 환경변수 POSTGRES_CONTAINER로 오버라이드)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$(cd "$BACKEND_DIR/.." && pwd)"
LOCAL_BACKUPS_DIR="$SERVICE_DIR/db/backups"
HELPER="$SCRIPT_DIR/_db-backup-s3.js"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-codingpt_postgres_local}"

ACTION="${1:-}"
ARG="${2:-}"

if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
  echo "ERROR: DB 환경 변수가 없습니다."
  echo "사용 전: set -a && source .env.local && set +a"
  exit 1
fi

mkdir -p "$LOCAL_BACKUPS_DIR"

run_node() {
  (cd "$BACKEND_DIR" && node "$HELPER" "$@")
}

case "$ACTION" in
  upload)
    DATE_TAG="$(date +%Y%m%d)"
    if [ -n "$ARG" ]; then
      FILENAME="full_${DATE_TAG}_${ARG}.sql"
    else
      FILENAME="full_${DATE_TAG}.sql"
    fi
    OUT_PATH="$LOCAL_BACKUPS_DIR/$FILENAME"
    echo ">>> pg_dump 실행: $POSTGRES_CONTAINER → $OUT_PATH"
    docker exec "$POSTGRES_CONTAINER" pg_dump \
      -U "$DB_USER" -d "$DB_NAME" \
      --no-owner --no-privileges \
      > "$OUT_PATH"
    echo ">>> 로컬 저장 완료: $OUT_PATH"
    run_node upload "$OUT_PATH"
    ;;

  list)
    run_node list
    ;;

  pull)
    if [ -n "$ARG" ]; then
      FILENAME="$ARG"
    else
      FILENAME="$(run_node latest | tail -n 1)"
    fi
    echo ">>> 다운로드 대상: $FILENAME"
    run_node download "$FILENAME" "$LOCAL_BACKUPS_DIR"
    ;;

  restore)
    if [ -n "$ARG" ]; then
      FILENAME="$ARG"
    else
      FILENAME="$(run_node latest | tail -n 1)"
    fi
    LOCAL_PATH="$LOCAL_BACKUPS_DIR/$FILENAME"
    if [ ! -f "$LOCAL_PATH" ]; then
      echo ">>> 로컬에 없음, objectstore에서 다운로드: $FILENAME"
      run_node download "$FILENAME" "$LOCAL_BACKUPS_DIR" | tail -n 1 > /dev/null
    fi
    echo ">>> 복원 시작: $LOCAL_PATH → $POSTGRES_CONTAINER:$DB_NAME"
    echo ">>> 기존 DB 초기화 (DROP & CREATE)"
    docker exec -e PGPASSWORD="$DB_PASSWORD" "$POSTGRES_CONTAINER" \
      psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
    docker exec -e PGPASSWORD="$DB_PASSWORD" "$POSTGRES_CONTAINER" \
      psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";"
    echo ">>> SQL 적용"
    docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$POSTGRES_CONTAINER" \
      psql -U "$DB_USER" -d "$DB_NAME" < "$LOCAL_PATH"
    echo ">>> 마이그레이션 기준점 stamp"
    bash "$SCRIPT_DIR/db-stamp-baseline.sh"
    echo ">>> 신규 마이그레이션 적용 (db:migrate)"
    (cd "$BACKEND_DIR" && npm run db:migrate)
    echo ">>> 복원 완료."
    ;;

  *)
    echo "사용법: bash scripts/db-backup.sh <upload|list|pull|restore> [arg]"
    echo ""
    echo "  upload [suffix]         로컬 DB → 백업 생성 → objectstore 업로드"
    echo "                          suffix 지정 시 full_YYYYMMDD_<suffix>.sql"
    echo "  list                    objectstore에 저장된 백업 목록"
    echo "  pull [filename]         백업 다운로드만 (filename 생략 시 최신)"
    echo "  restore [filename]      백업 다운로드 + 로컬 DB 복원 + 마이그레이션 적용"
    exit 1
    ;;
esac
