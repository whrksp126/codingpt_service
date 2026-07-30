#!/usr/bin/env bash
# CodingPT PC 릴리스 — 서명 빌드 → 업데이터 아티팩트 → objectstore 업로드 → latest.json 발행
#
# 사용법: bash scripts/release-pc.sh [--notes "릴리스 노트"]
#
# 요구사항:
#  · 키체인에 Developer ID Application 인증서(빌드 서명 — bundle-sidecar 가 자동 탐지)
#  · 키체인 공증 프로필 `codingpt-notary` (xcrun notarytool store-credentials 로 등록)
#  · ~/.codingpt-release/pc-updater.key (업데이터 서명 개인키 — 유출 금지·분실 시 업데이트 불가)
#  · codingpt_back/.env.local 의 OBJECTSTORE_* (업로드 자격)
#
# 산출물(objectstore codingpt/pc-releases/):
#  darwin-aarch64/CodingPT_<ver>.app.tar.gz  ← 자동 업데이트용(서명 .sig 는 latest.json 에 인라인)
#  CodingPT_<ver>_aarch64.dmg + CodingPT.dmg ← 수동 설치/다운로드 페이지용
#  latest.json                               ← /api/pc/update 가 읽는 매니페스트
set -euo pipefail

PC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACK_DIR="$PC_DIR/../codingpt_back"
KEY="$HOME/.codingpt-release/pc-updater.key"
NOTES=""
[ "${1:-}" = "--notes" ] && NOTES="${2:-}"

[ -f "$KEY" ] || { echo "✗ 업데이터 개인키 없음: $KEY (tauri signer generate 로 생성)" >&2; exit 1; }

VERSION="$(python3 -c "import json;print(json.load(open('$PC_DIR/src-tauri/tauri.conf.json'))['version'])")"
echo "▸ 릴리스 버전: $VERSION"

# 웹의 두 버튼이 같은 버전별 공개 DMG를 가리키는지 릴리스 전에 강제 검증한다.
# 새 버전인데 URL 갱신을 잊으면 구 DMG가 영구 캐시된 것처럼 보이므로 발행 자체를 중단한다.
EXPECTED_PUBLIC_DMG="https://objectstore.ghmate.com/codingpt/common/downloads/CodingPT-${VERSION}-arm64.dmg"
for FRONT_FILE in "$PC_DIR/../codingpt_front/app/(public)/page.tsx" "$PC_DIR/../codingpt_front/app/(public)/download/page.tsx"; do
  grep -Fq "$EXPECTED_PUBLIC_DMG" "$FRONT_FILE" || {
    echo "✗ 웹 DMG URL 버전 불일치: $FRONT_FILE" >&2
    echo "  다음 URL로 먼저 갱신하세요: $EXPECTED_PUBLIC_DMG" >&2
    exit 1
  }
done

# 1) 서명 릴리스 빌드 (beforeBuildCommand 가 CPT_RELEASE=1 로 사이드카 서명 필수화 수행)
#  주의: _PATH 변형은 CLI 버전에 따라 무시됨(실측) — 키 내용을 직접 넘긴다.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
( cd "$PC_DIR" && npm run tauri build )

BUNDLE="$PC_DIR/src-tauri/target/release/bundle"
TARGZ="$(ls "$BUNDLE"/macos/*.app.tar.gz | head -1)"
SIG="$TARGZ.sig"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
[ -f "$TARGZ" ] && [ -f "$SIG" ] && [ -f "$DMG" ] || { echo "✗ 빌드 산출물 누락 (tar.gz/sig/dmg)" >&2; exit 1; }

# 2) 외부 앱 서명 검증 — ad-hoc 이면 중단(릴리스 규율)
#  주의: pipefail 아래서 `codesign | grep -q` 는 grep 조기종료가 codesign 에 SIGPIPE(141)를 먹여
#  성공을 실패로 오판한다(실측) — 출력을 변수로 캡처해 검사한다.
APP="$(ls -d "$BUNDLE"/macos/*.app | head -1)"
SIGN_INFO="$(codesign -dvv "$APP" 2>&1 || true)"
if ! grep -q "Developer ID Application" <<<"$SIGN_INFO"; then
  echo "✗ 앱이 Developer ID 로 서명되지 않았습니다:" >&2
  grep Authority <<<"$SIGN_INFO" >&2 || true
  exit 1
fi
echo "▸ 서명 검증 OK: $(grep 'Authority=Developer ID' <<<"$SIGN_INFO" | head -1)"

# 3) 공증 + 스테이플 — Gatekeeper 첫 실행 경고 제거. dmg 공증이 내부 .app 까지 커버하고,
#  업데이터 서명(latest.json)은 tar.gz 기준이라 dmg 스테이플과 무관하다.
#  프로필 없으면 중단(미공증 릴리스 금지) — 등록: xcrun notarytool store-credentials codingpt-notary
NOTARY_PROFILE="codingpt-notary"
if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "✗ 공증 프로필 없음: $NOTARY_PROFILE (notarytool store-credentials 로 등록)" >&2; exit 1
fi
echo "▸ 공증 제출(수 분 소요)..."
NOTARY_OUT="$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1 || true)"
if ! grep -q "status: Accepted" <<<"$NOTARY_OUT"; then
  echo "✗ 공증 실패:" >&2; tail -10 <<<"$NOTARY_OUT" >&2; exit 1
fi
xcrun stapler staple "$DMG" >/dev/null
echo "▸ 공증+스테이플 OK"

# 4) objectstore 업로드 + latest.json (back 의 aws-sdk 재사용 — OBJECTSTORE_* 는 .env.local)
set -a; source "$BACK_DIR/.env.local"; set +a
node "$PC_DIR/scripts/_release-upload.cjs" "$VERSION" "$TARGZ" "$SIG" "$DMG" "$NOTES"

echo "✅ 릴리스 $VERSION 발행 완료 — 업데이트 확인: /api/pc/update/darwin/aarch64/<구버전>"
