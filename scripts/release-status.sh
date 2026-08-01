#!/usr/bin/env bash
# release-status.sh — "지금 무엇을 배포해야 하는가" 를 한 번에 진단한다(읽기 전용).
#
# 왜 필요한가: 이 제품의 배포는 서로 다른 5개 표면(back/front · PC 앱 · Android · iOS · 서버의
# 버전 표기)이 각자 다른 절차를 갖고, 순서를 틀리면 조용히 어긋난다(예: 스토어 게시 전에
# APP_LATEST 를 올리면 사용자가 없는 버전으로 안내받는다). 매번 사람이 기억하는 대신 여기서 읽는다.
#
# 이 스크립트는 **아무것도 바꾸지 않는다**. 판단 재료만 모은다.
#   사용: bash scripts/release-status.sh [--json]
set -uo pipefail

SVC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SVC_ROOT/.." && pwd)"
SVC="$SVC_ROOT"
APP="$ROOT/codingpt_app"
ADMIN="$ROOT/codingpt_admin"

BACK_PROD="https://codingpt-back.ghmate.com"
FRONT_PROD="https://codingpt.ghmate.com"
IOS_APP_ID="6751457159"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

say() { [ "$JSON" = 1 ] || echo "$@"; }
hdr() { [ "$JSON" = 1 ] || { echo; echo "── $* ──"; }; }

# ── 로컬: 리포 상태 ───────────────────────────────────────────────────
repo_state() { # <path> → "dirty|clean unpushed_count branch"
  local d="$1"
  [ -d "$d/.git" ] || { echo "norepo 0 -"; return; }
  local dirty unpushed branch
  dirty=$(git -C "$d" status --porcelain | wc -l | tr -d ' ')
  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')
  git -C "$d" fetch --quiet origin 2>/dev/null || true
  unpushed=$(git -C "$d" rev-list --count "origin/$branch..$branch" 2>/dev/null || echo 0)
  echo "$dirty $unpushed $branch"
}

# ── 로컬: 버전 ────────────────────────────────────────────────────────
pc_ver=$(python3 -c "import json;print(json.load(open('$SVC/codingpt_pc/src-tauri/tauri.conf.json'))['version'])" 2>/dev/null || echo '?')
and_code=$(grep -Eo 'versionCode +[0-9]+' "$APP/android/app/build.gradle" 2>/dev/null | grep -Eo '[0-9]+' | head -1)
and_name=$(grep -Eo 'versionName +"[^"]+"' "$APP/android/app/build.gradle" 2>/dev/null | grep -Eo '"[^"]+"' | tr -d '"' | head -1)
ios_ver=$(grep -Eo 'MARKETING_VERSION = [^;]+' "$APP/ios/codingpt.xcodeproj/project.pbxproj" 2>/dev/null | head -1 | awk '{print $3}')
ios_build=$(grep -Eo 'CURRENT_PROJECT_VERSION = [0-9]+' "$APP/ios/codingpt.xcodeproj/project.pbxproj" 2>/dev/null | head -1 | awk '{print $3}')
cmp_ios=$(grep -Eo 'APP_LATEST_IOS=[^ ]+' "$SVC/docker-compose.prod.yml" 2>/dev/null | cut -d= -f2)
cmp_and=$(grep -Eo 'APP_LATEST_ANDROID=[^ ]+' "$SVC/docker-compose.prod.yml" 2>/dev/null | cut -d= -f2)

# ── 라이브: 서버/스토어 ───────────────────────────────────────────────
code_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$1" 2>/dev/null || echo 000; }
back_code=$(code_of "$BACK_PROD/api/daemon/status")     # 401 = 정상 기동
front_code=$(code_of "$FRONT_PROD/")
# 발행된 PC 최신 버전 — 아주 낮은 버전으로 물어보면 항상 최신을 알려준다(204 면 발행분 없음).
pc_live=$(curl -s --max-time 12 "$BACK_PROD/api/pc/update/darwin/aarch64/0.0.1" 2>/dev/null \
  | python3 -c "import sys,json;d=sys.stdin.read().strip();print(json.loads(d)['version'] if d else '없음')" 2>/dev/null || echo '?')
# back 이 앱에 알려주는 최신 버전(= 인앱 업데이트 안내 기준)
app_ver_json=$(curl -s --max-time 12 "$BACK_PROD/api/app/version" 2>/dev/null || echo '')
back_ios=$(echo "$app_ver_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['ios']['version'],d['ios'].get('source','?'))" 2>/dev/null || echo '? ?')
back_and=$(echo "$app_ver_json" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['android']['version'],d['android'].get('source','?'))" 2>/dev/null || echo '? ?')
# 스토어 실게시 버전(iOS 만 공개 조회 가능)
store_ios=$(curl -s --max-time 12 "https://itunes.apple.com/lookup?id=$IOS_APP_ID&country=kr" 2>/dev/null \
  | python3 -c "import sys,json;r=json.load(sys.stdin).get('results') or [];print(r[0]['version'] if r else '미게시')" 2>/dev/null || echo '?')

read -r svc_dirty svc_unpushed svc_branch <<<"$(repo_state "$SVC")"
read -r app_dirty app_unpushed app_branch <<<"$(repo_state "$APP")"
read -r adm_dirty adm_unpushed adm_branch <<<"$(repo_state "$ADMIN")"

if [ "$JSON" = 1 ]; then
  python3 - "$svc_dirty" "$svc_unpushed" "$app_dirty" "$app_unpushed" "$adm_dirty" "$adm_unpushed" \
    "$pc_ver" "$pc_live" "$and_name" "$and_code" "$ios_ver" "$ios_build" \
    "$cmp_ios" "$cmp_and" "$store_ios" "$back_code" "$front_code" "$back_ios" "$back_and" <<'PY'
import json,sys
a=sys.argv[1:]
print(json.dumps({
 "repos":{"service":{"dirty":int(a[0]),"unpushed":int(a[1])},
          "app":{"dirty":int(a[2]),"unpushed":int(a[3])},
          "admin":{"dirty":int(a[4]),"unpushed":int(a[5])}},
 "pc":{"repo":a[6],"published":a[7]},
 "android":{"versionName":a[8],"versionCode":a[9],"composeLatest":a[13]},
 "ios":{"marketing":a[10],"build":a[11],"composeLatest":a[12],"store":a[14]},
 "live":{"backCode":a[15],"frontCode":a[16],"backIos":a[17],"backAndroid":a[18]},
},ensure_ascii=False,indent=2))
PY
  exit 0
fi

hdr "리포 상태"
printf "  service  %-6s 미커밋 %s · 미푸시 %s\n" "$svc_branch" "$svc_dirty" "$svc_unpushed"
printf "  app      %-6s 미커밋 %s · 미푸시 %s\n" "$app_branch" "$app_dirty" "$app_unpushed"
printf "  admin    %-6s 미커밋 %s · 미푸시 %s\n" "$adm_branch" "$adm_dirty" "$adm_unpushed"

hdr "버전 (리포 → 라이브)"
printf "  PC        %s → 발행됨 %s\n" "$pc_ver" "$pc_live"
printf "  Android   %s (code %s) → 스토어 조회불가(공개 API 없음)\n" "$and_name" "$and_code"
printf "  iOS       %s (build %s) → 스토어 %s\n" "$ios_ver" "$ios_build" "$store_ios"
printf "  안내기준   back ios=%s · android=%s   (compose ios=%s android=%s)\n" "$back_ios" "$back_and" "$cmp_ios" "$cmp_and"

hdr "라이브 상태"
printf "  back  %s %s\n" "$back_code" "$([ "$back_code" = 401 ] && echo '(정상 — 인증 요구)' || echo '⚠ 401 이 아님')"
printf "  front %s %s\n" "$front_code" "$([ "$front_code" = 200 ] && echo '(정상)' || echo '⚠ 200 이 아님')"

hdr "해야 할 일"
todo=0
note() { todo=$((todo+1)); printf "  %d) %s\n" "$todo" "$*"; }
[ "${svc_dirty:-0}" != 0 ] && note "service 미커밋 $svc_dirty 건 — 배포 전 커밋/정리 필요"
[ "${app_dirty:-0}" != 0 ] && note "app 미커밋 $app_dirty 건"
[ "${svc_unpushed:-0}" != 0 ] && note "service 미푸시 $svc_unpushed 건 — deploy.sh 는 서버에서 git pull 이라 push 선행 필수"
[ "${app_unpushed:-0}" != 0 ] && note "app 미푸시 $app_unpushed 건"
[ "$pc_ver" != "$pc_live" ] && note "PC $pc_ver 미발행(발행됨=$pc_live) — bash codingpt_pc/scripts/release-pc.sh"
[ "$store_ios" != "$ios_ver" ] && [ "$store_ios" != "?" ] && note "iOS $ios_ver 미게시(스토어=$store_ios) — 제출/심사 대기"
# Android 안내 기준은 compose 가 정본이라, 스토어 게시 후에만 올려야 한다.
[ "$cmp_and" != "$and_name" ] && note "Play 게시가 끝났다면 APP_LATEST_ANDROID 를 $and_name 로 올리고 재배포(게시 전이면 두지 말 것)"
[ "$todo" = 0 ] && echo "  없음 — 전부 최신"
echo
