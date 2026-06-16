# CodingPT 결제 웹 (`codingpt_front`)

인앱 결제(스토어 수수료) 회피를 위한 **별도 결제 웹**. 구독(정기결제 빌링키)·크레딧 충전(신용카드 일시불, 환금성)을 PortOne V2 로 처리. **Next.js App Router(SSR)** — PG 심사 크롤러가 상품·가격·사업자정보·약관을 JS 실행 없이 읽을 수 있게 서버 렌더한다.

## 로컬 실행
```bash
cd codingpt_service/codingpt_front
cp .env.example .env.local   # 값 채우기 (PortOne 키 등)
npm install                  # @portone/browser-sdk, next 등 (사용자 승인 후)
npm run dev                  # http://localhost:3400
```

## 환경변수 (.env.local)
- `BACKEND_INTERNAL_URL` — SSR 서버사이드 호출 대상(도커 내부망). 미설정 시 PUBLIC 사용.
- `NEXT_PUBLIC_BACKEND_URL` — 클라이언트 호출 대상(codingpt_back).
- `NEXT_PUBLIC_PORTONE_STORE_ID` / `..._CHANNEL_KEY_CHARGE` / `..._CHANNEL_KEY_BILLING` — PortOne publishable.
  - **테스트 단계**: PortOne 테스트 채널(INIpayTest) 키. 카드사 심사 통과 후 실채널 키로 교체.
- 백엔드(`codingpt_back/.env`)엔 `PORTONE_API_SECRET`, `PORTONE_WEBHOOK_SECRET`, `PORTONE_CHANNEL_KEY_CHARGE`, `PORTONE_CHANNEL_KEY_BILLING`, `PORTONE_STORE_ID` 필요(시크릿은 백엔드만).

## 인증 흐름
- **앱 진입(주)**: 앱이 인앱 브라우저로 `?handoff=<JWT>` 를 붙여 열면 토큰 저장 → 같은 user_id 로 결제.
- **직접 로그인**: `/login` ID/PW(카드사 심사용 계정). 백엔드 `POST /api/users/login-local`.
  - 심사 계정 시드(백엔드): `printf '%s' '<pw>' | REVIEWER_EMAIL=reviewer@codingpt.app node scripts/seed-reviewer.js`

## 페이지
- `/` 랜딩(SSR), `/pricing` 요금·충전(SSR + 결제), `/legal/{terms,privacy,refund}`(SSR), `/account/{usage,credits,subscription}`, `/login`.
- 푸터(전 페이지 SSR): 사업자정보 + 민원책임 고지 + 민원담당자.

## 배포 (ghmate 홈서버)
- 신규 nginx vhost: `codingpt-front.ghmate.com` → 컨테이너 :3400.
- `docker-compose.{dev,prod}.yml` 에 서비스 추가 + `deploy.sh` 에 포함. `NEXT_PUBLIC_*` 는 build arg.

## 환금성 심사 체크리스트 매핑
footer 민원고지/담당자, 충전 ≥₩1,000·일시불, 1년 소멸 고지, 원장(/account/credits), 환불=원카드/현금불가(/legal/refund), 약관/개인정보(PG위탁)/상품가격 SSR 노출, 심사용 ID/PW. 자세한 건 루트 `.claude/plans` 설계 문서 참조.
