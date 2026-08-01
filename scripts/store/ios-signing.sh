#!/usr/bin/env bash
# ios-signing.sh — iOS 배포 서명 자산(인증서 + 프로비저닝 프로파일)을 **API 로** 준비한다.
#
# 왜 필요한가: "iOS 아카이브는 사람이 Xcode 로 해야 한다" 는 오랜 전제가 사실이 아니었다.
#  ASC API 키로 배포 인증서를 만들고(CSR 만 보내면 됨) 프로파일까지 발급해 설치하면
#  xcodebuild 만으로 App Store 용 IPA 를 만들 수 있다. 2026-08-01 실제로 이렇게 0.3.0 을 올렸다.
#
# ⚠ xcodebuild 의 `-allowProvisioningUpdates`(클라우드 서명) 는 **안 된다** —
#   "Cloud signing permission error / No signing certificate iOS Distribution found" 로 막힌다.
#   같은 키로 REST 는 201 을 준다. 즉 권한 문제가 아니라 클라우드 서명 경로의 제약이다.
#   → CSR 을 우리가 만들어 REST 로 발급받고, **수동 서명(manual)** 으로 export 한다.
#
# ⚠ PKCS12 는 반드시 레거시 알고리즘으로 — OpenSSL 3 기본값은 macOS `security import` 가
#   "MAC verification failed" 로 거부한다(암호가 맞아도).
#
# 사용: ASC_KEY_ID=... ASC_ISSUER_ID=... bash ios-signing.sh
#   이미 키체인에 배포 인증서가 있으면 아무것도 하지 않는다(멱등).
set -euo pipefail

: "${ASC_KEY_ID:?ASC_KEY_ID 필요}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID 필요}"
BUNDLE_ID="${BUNDLE_ID:-com.ghmate.codingpt.app}"
PROFILE_NAME="${PROFILE_NAME:-CodingPT AppStore Auto}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT   # 개인키는 키체인에 들어간 뒤 디스크에서 지운다

if security find-identity -v -p codesigning 2>/dev/null | grep -qiE "iPhone Distribution|Apple Distribution"; then
  echo "배포 인증서가 이미 키체인에 있습니다 — 인증서 생성 건너뜀"
else
  echo "배포 인증서 생성(CSR → ASC API)…"
  openssl genrsa -out "$WORK/dist.key" 2048 2>/dev/null
  openssl req -new -key "$WORK/dist.key" -out "$WORK/dist.csr" \
    -subj "/CN=${PROFILE_NAME}/O=CodingPT/C=KR" 2>/dev/null
  CSR="$(tr -d '\n' < "$WORK/dist.csr")" WORK="$WORK" node "$HERE/_signing-api.mjs" cert
  openssl x509 -inform DER -in "$WORK/dist.cer" -out "$WORK/dist.pem"
  # ⚠ -legacy 필수(위 주석). 없으면 import 가 MAC verification failed 로 실패한다.
  openssl pkcs12 -export -legacy -inkey "$WORK/dist.key" -in "$WORK/dist.pem" \
    -out "$WORK/dist.p12" -passout pass:cptbuild -name "$PROFILE_NAME" 2>/dev/null
  security import "$WORK/dist.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P cptbuild -T /usr/bin/codesign -T /usr/bin/security -A
  echo "키체인 등록 완료"
fi

echo "프로비저닝 프로파일 준비…"
WORK="$WORK" BUNDLE_ID="$BUNDLE_ID" PROFILE_NAME="$PROFILE_NAME" node "$HERE/_signing-api.mjs" profile

IDENTITY="$(security find-identity -v -p codesigning | grep -iE "iPhone Distribution|Apple Distribution" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
echo "서명 ID: $IDENTITY"
echo "프로파일: $PROFILE_NAME"
echo
echo "다음(export 시 이 값들을 exportOptions 에 넣는다):"
echo "  signingStyle=manual · signingCertificate=\"$IDENTITY\" · provisioningProfiles[$BUNDLE_ID]=\"$PROFILE_NAME\""
