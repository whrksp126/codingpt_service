# Supporter 웹 결제 운영 설정

CodingPT의 글로벌 웹 구독은 Showsound와 같은 **Lemon Squeezy**를 사용한다. Lemon Squeezy가
Merchant of Record로 결제, 글로벌 판매세/VAT, 영수증과 환불 업무를 처리한다. 모바일 스토어
결제는 이번 출시 범위에 포함하지 않는다.

## 상품

- 상품명: `CodingPT Supporter`
- 변형: 월 구독
- 표시 통화/가격: `KRW 4,900 / month`
- Personal: 개인 기기 등록 무제한
- Supporter: Personal과 동일하게 기기 등록 무제한

기존 GHMATE 스토어에 KRW 4,900 월 구독 Variant를 만든다.

## 백엔드 환경 변수

값은 저장소에 넣지 않고 각 서버의 비공개 env에만 설정한다.

```text
SUBSCRIPTION_SALES_ENABLED=false
PAYMENT_WEB_URL=https://codingpt.ghmate.com
LEMON_SQUEEZY_API_KEY=
LEMON_SQUEEZY_STORE_ID=
LEMON_SQUEEZY_SUPPORTER_VARIANT_ID=
LEMON_SQUEEZY_WEBHOOK_SECRET=
```

설정과 테스트가 끝날 때까지 서버와 웹의 판매 게이트는 모두 `false`로 둔다.

프론트의 `NEXT_PUBLIC_*` 값은 빌드 시 고정된다. Docker 배포에서는 compose를 실행하는
환경의 `SUBSCRIPTION_SALES_ENABLED`가 이 값으로 전달된다. 출시할 때는 백엔드 env와 compose
실행 환경을 모두 `true`로 맞춘 뒤 **프론트를 다시 빌드**해야 한다. 컨테이너 재시작만으로는
프론트 버튼이 열리지 않는다.

## 웹훅

- URL: `https://codingpt-back.ghmate.com/api/billing/lemonsqueezy/webhook`
- 최소 이벤트:
  - `subscription_created`
  - `subscription_updated`
  - `subscription_cancelled`
  - `subscription_resumed`
  - `subscription_expired`
  - `subscription_paused`
  - `subscription_unpaused`
  - `subscription_payment_failed`
  - `subscription_payment_success`
  - `subscription_payment_recovered`

대시보드 Test mode에서 체크아웃, 최초 결제, 갱신 성공/실패, 해지, 재개 웹훅을 확인한다. 이후
백엔드 `SUBSCRIPTION_SALES_ENABLED=true`와 웹 빌드 변수
`NEXT_PUBLIC_SUBSCRIPTION_SALES_ENABLED=true`를 함께 반영한다.

## 현재 테스트 리소스

- GHMATE test store: `436537`
- CodingPT Supporter test product: `1265743`
- Monthly KRW 4,900 test variant: `1978884`

Live mode에서는 테스트 API 키·상품·Variant ID를 재사용할 수 없다. 기존에 운영 중인 GHMATE
스토어의 Live mode로 테스트 상품을 복사하고, 운영 env를 Live 값으로 교체한 다음 최종 결제
검증을 진행한다. 단일 Variant의 API 상태가 `pending`인 것은 승인 대기가 아니라 기본 Variant를
체크아웃의 별도 선택지로 표시하지 않는 Lemon Squeezy의 정상 동작이다.
