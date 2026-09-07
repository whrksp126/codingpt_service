#!/bin/bash
# 사용법: ./deploy.sh [dev|stg|prod]
ENV=$1
SSH_KEY="$HOME/.ssh/ghmate_server"
REMOTE_DIR="/srv/projects/codingpt"

case $ENV in
  dev)
    COMPOSE_FILE="docker-compose.dev.yml"
    PROJECT_NAME="codingpt_dev"
    ;;
  stg)
    COMPOSE_FILE="docker-compose.stg.yml"
    PROJECT_NAME="codingpt_stg"
    ;;
  prod)
    COMPOSE_FILE="docker-compose.prod.yml"
    PROJECT_NAME="codingpt_prod"
    ;;
  *)
    echo "사용법: ./deploy.sh [dev|stg|prod]"
    exit 1
    ;;
esac

echo ">>> [$ENV] 배포 시작..."

ssh -i "$SSH_KEY" -p 222 ghmate@ghmate.iptime.org "
  set -e
  cd $REMOTE_DIR
  echo '>>> git pull...'
  git pull
  echo '>>> docker build & up...'
  docker compose -p $PROJECT_NAME -f $COMPOSE_FILE up --build -d back front code-executor agent-worker egress-proxy
  echo '>>> nginx reload...'
  docker exec nginx_proxy nginx -s reload
"

if [ $? -ne 0 ]; then
  echo ">>> [에러] 배포 실패. SSH 접속 및 서버 상태를 확인하세요."
  exit 1
fi

# 배포는 "컨테이너가 떴다" 로 끝나지 않는다 — 실호출 검증까지 통과해야 끝이다.
#  여기에 구성요소 호환 검증(compat.json ↔ 실서버)이 포함된다: PC 를 올리면서 앱 하한을
#  올렸는데 스토어 게시나 APP_MIN_* 전파를 빠뜨리면, 구버전 앱 사용자가 안내도 못 받고 막힌다.
echo ">>> 배포 검증..."
bash "$(dirname "$0")/scripts/verify-deploy.sh" "$ENV" || {
  echo ">>> [경고] 배포는 됐으나 검증에 실패했습니다 — 위 FAIL 항목을 처리하세요."
  exit 1
}
echo ">>> [$ENV] 배포 완료!"
