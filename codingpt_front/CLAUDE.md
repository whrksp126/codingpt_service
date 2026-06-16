# Public Web Rules (`codingpt_front/`)

**Next.js (App Router, SSR)** 공개 사이트 — 랜딩 + **월 구독 결제(PortOne V2 정기결제/빌링키)** + 약관/사업자정보 + **웹 바이브코딩(`/app`)**.
배포: **`codingpt.ghmate.com`**(정식, PG 계약 URL) / `codingpt-front.ghmate.com`(별칭). compose 서비스명 `front`, port 3400. 어드민은 독립 프로젝트 `../../codingpt_admin`.

## 왜 SSR인가 (중요)
PG(KG이니시스 정기결제) 심사 크롤러가 **상품·가격·사업자정보·약관을 JS 실행 없이 정적 HTML로** 읽어야 통과한다.
→ 랜딩(상품/가격)·법적·푸터는 **서버 컴포넌트(SSR)** 로 유지. 웹 바이브코딩(`/app`)은 인증 기반 client 영역.

## 구조
- `app/` — page(랜딩)·pricing·checkout·account(usage/credits/subscription)·legal(terms/privacy/refund)·login
- `components/` — Footer(사업자정보+민원담당자 SSR), CheckoutButtons(client)
- `lib/` — api(서버 serverGet / 클라 clientFetch+bearer), auth(핸드오프 토큰), portone(결제 클라)
- `config/business.ts` — 사업자정보(푸터/약관 단일 소스)

## 디자인 시스템
앱 `v2Tokens.ts` 와 동일 다크 토큰을 `app/globals.css` `:root` 변수로 포팅. accent 민트 `#34D399`, CTA 딥그린 `#08875D`, Pretendard. 인라인 스타일 + globals 유틸 클래스.

## 인증
앱→웹 핸드오프(`?handoff=<JWT>`, lib/auth) 또는 `/login` ID/PW(심사용 계정, 백엔드 `/api/users/login-local`). 결제 시크릿(`PORTONE_API_SECRET`)은 백엔드만 보유.

## 환경변수
`NEXT_PUBLIC_BACKEND_URL`, `BACKEND_INTERNAL_URL`(SSR), `NEXT_PUBLIC_PORTONE_STORE_ID/CHANNEL_KEY_CHARGE/CHANNEL_KEY_BILLING`. `.env.example` 참조. **deps 미설치 — `npm install` 필요(승인 후).**
