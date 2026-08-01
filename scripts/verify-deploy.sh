#!/usr/bin/env bash
# verify-deploy.sh — 배포 직후 "정말 반영됐는가" 를 실호출로 확인한다.
#
# 규율: 재빌드·재시작만으로 완료 보고 금지. 여기서 통과해야 배포가 끝난 것이다.
#   사용: bash scripts/verify-deploy.sh [prod|dev]
set -uo pipefail
ENV="${1:-prod}"
case "$ENV" in
  prod) BACK="https://codingpt-back.ghmate.com"; FRONT="https://codingpt.ghmate.com" ;;
  dev)  BACK="https://dev-codingpt-back.ghmate.com"; FRONT="https://dev-codingpt.ghmate.com" ;;
  *) echo "사용법: verify-deploy.sh [prod|dev]"; exit 1 ;;
esac

fails=0
ok()   { printf "  PASS  %s\n" "$*"; }
bad()  { printf "  FAIL  %s\n" "$*"; fails=$((fails+1)); }
code_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo 000; }

echo "── $ENV 배포 검증 ──"

# 1) back 기동 — 인증을 요구하면(401) 라우팅·부팅이 정상이라는 뜻이다.
c=$(code_of "$BACK/api/daemon/status")
[ "$c" = 401 ] && ok "back 기동 (401 = 인증 요구)" || bad "back 응답 $c (401 이어야 함)"

# 2) front
c=$(code_of "$FRONT/")
[ "$c" = 200 ] && ok "front 200" || bad "front 응답 $c"

# 3) 앱 버전 안내 API — **손으로 고친 값이 썩는 자리**라 매 배포마다 확인한다.
#    iOS 는 스토어 실조회가 붙었으므로 source=store 여야 정상(env 면 조회 실패 = 폴백 중).
body=$(curl -s --max-time 15 "$BACK/api/app/version" 2>/dev/null || echo '')
if [ -z "$body" ]; then
  bad "/api/app/version 응답 없음"
else
  python3 - "$body" <<'PY' || fails=$((fails+1))
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print("  FAIL  /api/app/version 파싱 불가"); raise SystemExit(1)
ios=d.get('ios',{}); an=d.get('android',{})
print(f"  INFO  안내 버전 ios={ios.get('version')}({ios.get('source')}) android={an.get('version')}({an.get('source')})")
bad=0
if not ios.get('version'): print("  FAIL  ios.version 없음"); bad=1
if ios.get('source')=='env': print("  WARN  iOS 스토어 조회 실패 → env 폴백 중(네트워크/차단 확인)")
elif ios.get('source')=='store': print("  PASS  iOS 는 스토어 실조회(자동 감지 동작)")
raise SystemExit(bad)
PY
fi

# 4) PC 업데이트 채널 — 아주 낮은 버전으로 물으면 발행된 최신을 돌려줘야 한다.
v=$(curl -s --max-time 15 "$BACK/api/pc/update/darwin/aarch64/0.0.1" 2>/dev/null \
  | python3 -c "import sys,json;s=sys.stdin.read().strip();print(json.loads(s)['version'] if s else '')" 2>/dev/null || echo '')
[ -n "$v" ] && ok "PC 업데이트 채널 응답 (발행 최신 $v)" || bad "PC 업데이트 채널이 버전을 안 줌(latest.json 확인)"

echo
if [ "$fails" != 0 ]; then echo "❌ $fails 건 실패 — 완료 보고 금지"; exit 1; fi
echo "✅ 검증 통과"
