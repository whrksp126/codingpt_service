#!/usr/bin/env bash
# bump-version.sh — 버전을 **한 군데도 빠뜨리지 않고** 올린다.
#
# 왜 스크립트인가: 앱 버전은 4곳(android versionName/versionCode, iOS MARKETING_VERSION/
# CURRENT_PROJECT_VERSION — pbxproj 는 Debug/Release 두 벌)에 흩어져 있고, 하나만 빠뜨리면
# 스토어가 거부하거나(같은 build 번호) 사용자에게 엉뚱한 버전이 표시된다. 손으로 하면 반드시 샌다.
#
# ⚠ 변수 뒤에 한글/화살표 같은 멀티바이트가 붙으면 bash 가 변수명으로 읽는다($build→ → "build→: unbound
#   variable"). 이 스크립트의 모든 확장은 ${} 로 감싼다 — 오늘 이걸 안 감싸 실패했고, sed 는 이미 실행된
#   뒤라 **파일만 바뀌고 스크립트는 죽어** 재실행 때 번호가 중복 증가했다(23→24→25→26).
#   실패했다면 반드시 `git diff` 로 실제 값을 확인할 것.
#
#   사용: bash scripts/bump-version.sh app <새버전>     # 예: app 0.3.0  (versionCode/build 는 +1)
#         bash scripts/bump-version.sh app-build        # 빌드 번호만 +1(같은 버전 재업로드용)
#         bash scripts/bump-version.sh pc  <새버전>     # 예: pc 0.1.209
set -euo pipefail
SVC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SVC_ROOT/.." && pwd)"
APP="$ROOT/codingpt_app"
PC="$SVC_ROOT/codingpt_pc"

target="${1:-}"; newver="${2:-}"
[ -n "$target" ] || { echo "사용법: bump-version.sh <app|pc> <새버전>  |  bump-version.sh app-build"; exit 1; }
[ "$target" = "app-build" ] || [ -n "$newver" ] || { echo "사용법: bump-version.sh <app|pc> <새버전>"; exit 1; }
[ "$target" = "app-build" ] || echo "$newver" | grep -Eq '^[0-9]+(\.[0-9]+)*$' || { echo "버전 형식이 아닙니다: $newver"; exit 1; }

# 버전 비교(내림 방지) — 스토어는 버전이 내려가면 거부하고, 업데이터는 역행을 무시한다.
higher() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$2" ] && [ "$1" != "$2" ]; }

case "$target" in
  app-build)
    # 마케팅 버전은 그대로 두고 **빌드 번호만** 올린다 — 같은 버전을 다시 업로드해야 할 때
    #  (스토어는 같은 빌드 번호를 거부한다). 예: Info.plist 신고를 고쳐 재업로드.
    pbx="$APP/ios/codingpt.xcodeproj/project.pbxproj"
    gradle="$APP/android/app/build.gradle"
    build=$(grep -Eo 'CURRENT_PROJECT_VERSION = [0-9]+' "$pbx" | grep -Eo '[0-9]+' | head -1)
    code=$(grep -Eo 'versionCode +[0-9]+' "$gradle" | grep -Eo '[0-9]+' | head -1)
    nb=$((build + 1)); nc=$((code + 1))
    sed -i '' "s/CURRENT_PROJECT_VERSION = $build;/CURRENT_PROJECT_VERSION = $nb;/g" "$pbx"
    sed -i '' "s/versionCode $code/versionCode $nc/" "$gradle"
    echo "빌드 번호만 상향 — iOS ${build}→${nb} · Android ${code}→${nc}"
    ;;
  app)
    gradle="$APP/android/app/build.gradle"
    pbx="$APP/ios/codingpt.xcodeproj/project.pbxproj"
    cur=$(grep -Eo 'versionName +"[^"]+"' "$gradle" | grep -Eo '"[^"]+"' | tr -d '"' | head -1)
    code=$(grep -Eo 'versionCode +[0-9]+' "$gradle" | grep -Eo '[0-9]+' | head -1)
    build=$(grep -Eo 'CURRENT_PROJECT_VERSION = [0-9]+' "$pbx" | grep -Eo '[0-9]+' | head -1)
    higher "$cur" "$newver" || { echo "❌ $cur → $newver 는 상향이 아닙니다(스토어가 거부)"; exit 1; }
    nc=$((code + 1)); nb=$((build + 1))
    sed -i '' "s/versionCode $code/versionCode $nc/; s/versionName \"$cur\"/versionName \"$newver\"/" "$gradle"
    # pbxproj 는 Debug/Release 두 벌 — 반드시 전역 치환.
    sed -i '' "s/CURRENT_PROJECT_VERSION = $build;/CURRENT_PROJECT_VERSION = $nb;/g; s/MARKETING_VERSION = $cur;/MARKETING_VERSION = $newver;/g" "$pbx"
    echo "앱 ${cur}(${code}/${build}) → ${newver}(${nc}/${nb})"
    # 빠뜨린 곳이 없는지 되읽어 확인(치환 실패를 조용히 넘기지 않는다).
    grep -q "versionName \"$newver\"" "$gradle" && [ "$(grep -c "MARKETING_VERSION = $newver;" "$pbx")" -ge 2 ] \
      || { echo "❌ 일부 파일이 안 바뀌었습니다 — 수동 확인 필요"; exit 1; }
    echo "  다음: 커밋 → (스토어 제출) → 게시 후 APP_LATEST_ANDROID 갱신"
    ;;
  pc)
    conf="$PC/src-tauri/tauri.conf.json"
    cargo="$PC/src-tauri/Cargo.toml"
    cur=$(python3 -c "import json;print(json.load(open('$conf'))['version'])")
    higher "$cur" "$newver" || { echo "❌ $cur → $newver 는 상향이 아닙니다(업데이터가 무시)"; exit 1; }
    python3 - "$conf" "$newver" <<'PY'
import json,sys,io
p,v=sys.argv[1],sys.argv[2]
s=io.open(p,encoding='utf-8').read()
d=json.loads(s); old=d['version']
io.open(p,'w',encoding='utf-8').write(s.replace(f'"version": "{old}"', f'"version": "{v}"',1))
PY
    # Cargo.toml 은 릴리스에 쓰이지 않지만(정본은 tauri.conf) 방치하면 사람이 오독한다 — 같이 맞춘다.
    # package version 만 줄 시작에 단독으로 있다. macOS BSD sed 는 GNU 의 `0,/pattern/` 주소를
    # 조용히 적용하지 않아 과거엔 성공 메시지만 뜨고 Cargo.toml 이 안 바뀌었다.
    sed -i '' "s/^version = \"[^\"]*\"/version = \"$newver\"/" "$cargo"
    echo "PC ${cur} → ${newver} (tauri.conf + Cargo.toml)"
    echo "  다음: 커밋 → bash codingpt_service/codingpt_pc/scripts/release-pc.sh"
    ;;
  *) echo "대상은 app | app-build | pc"; exit 1 ;;
esac
