#!/bin/bash
# 서버에서 실행: 이 폴더의 *.conf 를 공용 nginx_proxy conf.d 로 동기화한다(원본=저장소).
#  - 바뀐 파일만 복사, 복사 전 서버 원본을 /tmp/<이름>.prev.<ts> 로 백업(conf.d 안엔 백업을 만들지 않는다)
#  - nginx -t 실패 시 즉시 원복하고 실패 종료 → reload 는 호출자가 한다(nginx_proxy restart 금지)
set -u
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DST_DIR=/srv/nginx-proxy/conf.d
TS=$(date +%s)
CHANGED=()

for src in "$SRC_DIR"/*.conf; do
  name=$(basename "$src")
  dst="$DST_DIR/$name"
  cmp -s "$src" "$dst" && continue
  [ -f "$dst" ] && cp -p "$dst" "/tmp/$name.prev.$TS"
  cp "$src" "$dst"
  CHANGED+=("$name")
done

if [ ${#CHANGED[@]} -eq 0 ]; then
  echo '>>> nginx conf: 변경 없음'
  exit 0
fi
echo ">>> nginx conf 갱신: ${CHANGED[*]}"

if ! docker exec nginx_proxy nginx -t; then
  echo '>>> [에러] nginx -t 실패 — 원복'
  for name in "${CHANGED[@]}"; do
    if [ -f "/tmp/$name.prev.$TS" ]; then cp -p "/tmp/$name.prev.$TS" "$DST_DIR/$name"; else rm -f "$DST_DIR/$name"; fi
  done
  docker exec nginx_proxy nginx -t
  exit 1
fi
