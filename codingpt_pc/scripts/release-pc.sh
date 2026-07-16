#!/usr/bin/env bash
# CodingPT PC 릴리스 — 서명 빌드 → 업데이터 아티팩트 → objectstore 업로드 → latest.json 발행
#
# 사용법: bash scripts/release-pc.sh [--notes "릴리스 노트"]
#
# 요구사항:
#  · 키체인에 Developer ID Application 인증서(빌드 서명 — bundle-sidecar 가 자동 탐지)
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

# 1) 서명 릴리스 빌드 (beforeBuildCommand 가 CPT_RELEASE=1 로 사이드카 서명 필수화 수행)
export TAURI_SIGNING_PRIVATE_KEY_PATH="$KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
( cd "$PC_DIR" && npm run tauri build )

BUNDLE="$PC_DIR/src-tauri/target/release/bundle"
TARGZ="$(ls "$BUNDLE"/macos/*.app.tar.gz | head -1)"
SIG="$TARGZ.sig"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
[ -f "$TARGZ" ] && [ -f "$SIG" ] && [ -f "$DMG" ] || { echo "✗ 빌드 산출물 누락 (tar.gz/sig/dmg)" >&2; exit 1; }

# 2) 외부 앱 서명 검증 — ad-hoc 이면 중단(릴리스 규율)
APP="$(ls -d "$BUNDLE"/macos/*.app | head -1)"
if ! codesign -dv "$APP" 2>&1 | grep -q "Developer ID Application"; then
  echo "✗ 앱이 Developer ID 로 서명되지 않았습니다:" >&2
  codesign -dv "$APP" 2>&1 | grep Authority >&2 || true
  exit 1
fi
echo "▸ 서명 검증 OK: $(codesign -dv "$APP" 2>&1 | grep 'Authority=Developer ID' | head -1)"

# 3) objectstore 업로드 + latest.json (back 의 aws-sdk 재사용 — OBJECTSTORE_* 는 .env.local)
set -a; source "$BACK_DIR/.env.local"; set +a
node "$PC_DIR/scripts/_release-upload.js" "$VERSION" "$TARGZ" "$SIG" "$DMG" "$NOTES"

echo "✅ 릴리스 $VERSION 발행 완료 — 업데이트 확인: /api/pc/update/darwin/aarch64/<구버전>"
