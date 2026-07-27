// store-qr.js — 앱 설치 QR(스토어 링크) 정본. 고정 URL 을 qrencode 로 미리 생성한 정적 이미지.
//
// ★ 스토어 URL 은 **여기와 back `routes/appReleaseRoutes.js` 두 곳이 같은 값**이어야 한다.
//   랜딩(codingpt_front `app/(public)/page.tsx`)도 같은 링크를 쓴다 — 한 곳이 스테일하면 사용자가
//   설치 페이지를 못 찾는다(iOS 는 실제로 `apps.apple.com/search?term=CodingPT` 검색 URL 로 오래
//   방치돼 있었다). 앱 ID 가 바뀌면 세 곳을 함께 고치고 QR 도 재생성해야 한다.
//
// 재생성:
//   qrencode -t PNG -o qr.png -m 2 -s 16 --level=M "<URL>" → base64 → data URI
// 검증(반드시 할 것 — QR 은 눈으로 틀린 것을 알 수 없다):
//   osascript -l JavaScript 로 CIDetector(CIDetectorTypeQRCode) 디코드 → 원본 URL 과 문자 일치 확인.
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.ghmate.codingpt.app";
export const APP_STORE_URL = "https://apps.apple.com/app/id6751457159";
export const ANDROID_QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAApAAAAKQAQMAAAASe9gTAAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAJjSURBVHic7dQ7juQwDAVA3f/SXgx6ZD7KHWwwEV0CLEv8FB15XX++FhKJRCKRSCTy5eRq6+e+o1G4erRqey8SiUTOJrM1iWw6h+zs2YtEIpGzyWrb4I7kLSvyaRkkEol8DVnpDZ7vPgCJRCLfTu74rnnCSCQS+T5yr0itb225qrbuSCQSOZvMVaX/9/ReJBKJnEyeq+Bs6Zn1tROJRCJnkztdv9SKVi5/uL366EAikcjh5E71oh157rumYr83JBKJHE3mU2X7vJ88ffsEJBKJnE6e6Lrja+WAXtmH3R+DRCKR48kkck+o1+So+4xEIpHDyZPq5I7VPbsqi0QikZPJHdxludet89lxjEQikcixZJXd4QdWo1v7elYhkUjkbLLT+c5svs8OJBKJnE9+krUXdl3Z/Ml/QVo1EolEziWzZCdrz3cOX9FbH4NEIpGTyUKrrcpO9ollFIlEIieT+1JAEatV5Kgc12JIJBI5ltzp87z3YpLI0xULiUQiJ5Ofpr0XmE8f0euTRSKRyPlkttfqLc+qTd8jkUgkcjiZ7b/JtRue78rmG4lEImeTySR/XXk6Bz2HIJFI5HQyrnfpuX/eCWcUiUQi30dmcR9VUEZqLBKJRM4nz3TR2VCjzkj+ppFIJHIyea6i9pi1erbYHkEikcjZ5Gqr7tmY8TOLRCKR7yGve617SEI1OCtvJEYgkUjkdDLDieTIBIvaC4lEIt9HJlzcOaZ3IZFI5HvJyvTsuldW1kIikcjZ5B1o52z/xqz2SUgkEjmfPJt7ee1nLMfcJyQSiRxL/u1CIpFIJBKJRL6Y/AckPW04DVH+NAAAAABJRU5ErkJggg==";
export const IOS_QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAhAAAAIQAQMAAADqzsXKAAAABlBMVEUAAAD///+l2Z/dAAAAAnRSTlP//8i138cAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAGOSURBVHic7dQxEsIwEEPRvf+lQ8MiyXFHqb8zAceWXjrP8/cMBAQEBAQEBMSLmJjvwXc9kbhlISAguojnNxvblfadVBYCAqKPOCNae+mWhYCA6CZ8R1UICAiIc1vVBCEgICC24GvntqBafAACAqKK8PH67cksBAREF/GeLWjtO0cWAgKiiDivlQz7ZaMd+wQEBEQRoUhGLTZKnB+CgIBoIvzojNx21IGAgOgj9OvHY5MnnoeAgGgitLXV3Nma1spCQEB0ETqYcTAZ/e8pBAREJ7EBTUbz8Q9CQEA0ETte3PXSdxACAqKP2Jj+FdldTX4EAgKijXhinHufbB0CAqKP8Evkd5FMVhIXAwEB0UXsa/5GbMT7AwEB0UZkfWsefkMaCAiIJuIcYc+j+En/YAgIiCJiYhQ/f/MKgoCA6CTyulEhr5vdOc4gICDKiC1drpTJld4gICAgVN/RyeUNAgKimDiZGS+elw4EBEQbsfOuv6uehICAaCN8nFHFz/IzEBAQTcR/AwEBAQEBAQER8wH6QpHvBa89RQAAAABJRU5ErkJggg==";
