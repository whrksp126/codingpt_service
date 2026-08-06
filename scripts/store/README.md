# 스토어 제출 자동화 — 어디까지 되고 어디부터 사람이 필요한가

결론부터: **심사 상태 확인과 승인 후 출시는 완전 자동화된다.** 업로드도 자격증명만 갖추면
자동이다. 사람이 반드시 필요한 건 **최초 1회 세팅**과 **심사 제출 버튼**뿐이다.

## 지금 이 Mac 의 자격증명 상태

| 자격 | 상태 | 없으면 |
|---|---|---|
| App Store Connect API 키(.p8) | ✅ `~/.appstoreconnect/private_keys/AuthKey_N5ZVQFND28.p8` | — |
| **ASC Issuer ID(UUID)** | ✅ `f1908b5f-e631-41e0-b723-3b46c7c13041` (2026-08-01 실호출 확인) | — |
| Apple 배포 인증서 | ❌ 이 키체인엔 Development 만 | **Xcode 없이도 생성 가능** — `openssl` 로 CSR 만들어 `POST /v1/certificates` (Team 키 한정) |
| Android 서명 키스토어 | ✅ `codingpt_app/android/app/release-key.keystore` | — |
| **Play 서비스계정 JSON** | ✅ `~/other/secrets/play/service-account.json` (2026-08-01, 권한 600) | — |

Issuer ID 는 App Store Connect → 사용자 및 액세스 → **통합(Integrations)** 상단에서 얻는다.
비밀이 아니지만(계정 식별자) 값은 env 로 넘긴다(`ASC_ISSUER_ID`).

### ⚠ 스토어 버전 조회에는 캐시버스터가 필수다 (2026-08-01 실측)

같은 URL 로 반복 조회하면 **iTunes CDN 이 낡은 값을 고정으로 돌려준다.** ASC 는 0.2.9 게시
(READY_FOR_SALE)라고 답하는데 plain lookup 은 계속 0.2.5 를 줬고, 쿼리 파라미터 하나만 덧붙이면
즉시 0.2.9 가 나왔다(반복 재현). 이걸 빼면 "자동 감지" 가 조용히 낡은 값을 고정해 손으로 고치던
시절과 똑같아진다. `appReleaseService.js` 와 `release-status.sh` 둘 다 `_cb=` 를 붙인다.

### Android 도 자동 감지된다

Play 는 공식 조회 API 가 없지만(Developer API = 서비스계정 필요) 공개 상세 페이지의 내장 데이터
(`"141":[[["0.2.9"]]`)에서 버전을 읽는다. **부서지기 쉬운 경로라 "env 보다 높을 때만 채택"** 규칙으로
감싸므로, 파싱이 깨져도 최악이 기존 동작(env 유지)이다. 덕분에 게시 후 손으로 값을 올리는 단계가
사라졌다 — env 는 조회가 막혔을 때의 폴백일 뿐이다.

## asc.mjs — App Store Connect (의존성 0, 지금 동작 확인됨)

```bash
export ASC_KEY_ID=N5ZVQFND28
export ASC_ISSUER_ID=f1908b5f-e631-41e0-b723-3b46c7c13041

node codingpt_service/scripts/store/asc.mjs status    # 버전별 심사 상태(한국어 해설)
node codingpt_service/scripts/store/asc.mjs builds     # 업로드된 빌드 처리 상태
node codingpt_service/scripts/store/asc.mjs prepare 0.3.0 --notes "..."  # 버전+빌드+노트
node codingpt_service/scripts/store/asc.mjs review-set --demo-file demo.json --notes-file notes.txt --yes
                                                      # 심사원용 데모 계정·심사 메모(값은 **파일로만**)
node codingpt_service/scripts/store/asc.mjs release-type after-approval --yes   # 승인되면 자동 게시
node codingpt_service/scripts/store/asc.mjs preflight  # 제출해도 되는지 점검(무해)
node codingpt_service/scripts/store/asc.mjs submit --yes    # 심사 제출
node codingpt_service/scripts/store/asc.mjs cancel --yes    # 제출 철회
node codingpt_service/scripts/store/asc.mjs watch      # 상태 전이를 주기 감시(무인 폴링)
node codingpt_service/scripts/store/asc.mjs release --yes   # 승인 대기 버전을 출시

node codingpt_service/scripts/store/play.mjs status    # Play 트랙별 심사 상태
node codingpt_service/scripts/store/play.mjs watch     # Play 상태 전이 감시
```

⚠ **상태 enum 이 바뀌었다(실측)**: 같은 버전이 구 필드 `appStoreState=READY_FOR_SALE` 와
신 필드 `appVersionState=READY_FOR_DISTRIBUTION` 로 **동시에** 내려온다. 구 이름으로만 매칭하면
어느 날 조용히 안 걸린다 — `asc.mjs` 는 신 필드를 우선하고 양쪽 이름을 모두 해석한다.

`status` 가 보여주는 상태와 뜻:

| Apple 상태 | 뜻 | 다음 행동 |
|---|---|---|
| `PREPARE_FOR_SUBMISSION` | 아직 심사에 안 보냄 | 리스팅·설문 채우고 제출 |
| `WAITING_FOR_REVIEW` / `IN_REVIEW` | 대기열 / 심사 중 | `watch` 로 감시 |
| `PENDING_DEVELOPER_RELEASE` | **승인됨, 출시만 남음** | `release --yes` |
| `READY_FOR_SALE` | 게시 완료 | `APP_LATEST_*` 갱신 |
| `REJECTED` | 거절 | 사유는 ASC 웹/Resolution Center |

### 심사 제출도 자동화된다 — 단 preflight 를 통과해야 한다

사람이 "제출 버튼 누르기 전에 눈으로 보던 것" 을 코드가 대신 확인한다. 이게 없으면 자동 제출은
**거절을 쌓는 기계**가 된다(거절 사유는 어느 스토어 API 로도 못 읽으니 원인 파악까지 사람 몫).

`preflight` 가 막는 것(하나라도 걸리면 제출 안 함):
- 제출 가능한 상태의 버전이 없음(이미 심사 중이거나 게시됨)
- 버전에 **빌드가 연결 안 됨**
- 빌드의 **수출규정 미답변** → WAITING_FOR_EXPORT_COMPLIANCE 에 걸려 심사가 시작도 안 된다
- **릴리스 노트가 전부 비어 있음**
- 데모 계정이 "필요" 인데 계정/비번이 빈 칸(로그인 앱에서 거의 확실한 거절 사유)

경고만 하는 것(제출은 진행): 일부 로케일 릴리스 노트 누락, 심사 연락처 공란.

제출은 **되돌릴 수 있다** — `cancel --yes` 로 철회한다. 그래서 `--yes` 한 겹만 두었다.

## 자동화 가능 범위 (양 스토어)

2026-08 기준, Play 는 `androidpublisher` v3 디스커버리 문서(rev 20260730)를 직접 훑어 확인했다.

| 단계 | Apple | Google Play |
|---|---|---|
| 빌드 생성 | ✅ `xcodebuild archive`(단, **배포 인증서 필요** → 현재 Xcode 로) | ✅ `gradlew bundleRelease`(서명키 있음) |
| 업로드 | ✅ `xcrun altool --upload-app`(ASC 키로) | ⛔→✅ 서비스계정만 있으면 자동(`edits.bundles.upload`) |
| 트랙·단계적 출시 | ✅ API | ⛔→✅ 서비스계정(`edits.tracks`, userFraction) |
| 리스팅·스크린샷·릴리스 노트 | ✅ API | ⛔→✅ 서비스계정(`edits.listings/images`) |
| **심사 제출** | ✅ **자동**(`submit --yes`, preflight 통과 시) | 서비스계정 있으면 ✅(`edits.commit`) |
| **심사 상태 조회** | ✅ **자동**(`asc.mjs status/watch`) | ✅ **자동**(`play.mjs status/watch` — 2026 신규 API) |
| **승인 후 출시** | ✅ **자동**(`release --yes`) | ✅ 트랙 `status: completed` 로 게시 |
| **게시 버전 조회**(안내값 자동화) | ✅ **자동**(iTunes lookup) | ✅ **자동**(공개 페이지 파싱 — 보조) |
| 연령/콘텐츠 등급 | ✅ `ageRatingDeclarations` API | ❌ IARC 는 영구 GUI |
| 개인정보 양식 | ❌ App Privacy 는 API 없음 | ✅ `dataSafety` 에 CSV 전송(최초 1회만 GUI) |
| 앱 콘텐츠 선언(광고·타깃연령·건강 등) | ⛔ 사람 | ❌ **API 없음**(영구 GUI) |

### ★ Play 에도 심사 상태 API 가 있다 (2026 신규 — 오래된 자료는 전부 "불가능" 이라 말한다)

`GET /applications/{pkg}/tracks/{track}/releases` 가 `releaseLifecycleState` 를 준다.
**라이브 디스커버리 문서(rev 20260730)에서 직접 확인**했다 — `TrackRelease.status`(배포 상태:
draft/inProgress/halted/completed)와는 **다른 필드**라, 그걸로 grep 하면 없다고 오판한다.

```
DRAFT · NOT_SENT_FOR_REVIEW · IN_REVIEW · APPROVED_NOT_PUBLISHED · NOT_APPROVED · PUBLISHED
```

→ **"승인되면 자동 출시" 루프가 양 스토어 모두 성립한다.** 다만 **거절 사유는 어느 쪽 API에도 없다** —
자동화가 알 수 있는 건 "거절됐다" 까지고 "왜" 는 사람이 콘솔에서 봐야 한다.

### 🔴 Play 커밋 시 필수 파라미터

`edits.commit` 의 `changesInReviewBehavior` 기본값이 `CANCEL_IN_REVIEW_AND_SUBMIT` 라
**진행 중인 심사를 취소하고 대기열 순번을 잃는다.** 자동화에서는 반드시 `ERROR_IF_IN_REVIEW` 를
명시할 것(디스커버리 문서에서 enum 실측 확인).

### Play 서비스계정 — 발급 완료(2026-08-01)

- 계정: `play-publisher@codingpt-464903.iam.gserviceaccount.com` (GCP 프로젝트 `codingpt-464903`)
- 권한 부여 앱: **CodingPT + 헤이보카**(GHK VPN 은 의도적으로 제외 — 필요할 때 추가)
- 부여한 권한: 앱 정보 보기 · 프로덕션 출시 · 테스트 트랙 출시/관리 · 앱 정보 관리 · 정책 선언 관리
- ⚠ 키 하나가 **두 앱의 출시 권한**을 갖는다 — 유출 시 두 앱 모두 영향. 앱별 분리가 더 안전하지만
  1인 운영에서는 관리 비용이 커서 통합을 택했다.
- **전파 지연 없었음** — 초대 직후 바로 200 이 떨어졌다(자료들이 말하는 24~36h 는 항상 걸리는 게 아니다).

다른 앱을 보려면 `--pkg`:
```bash
node scripts/store/play.mjs status --pkg com.ghmate.heyvoca
```

(참고: 예전 절차의 "Play Console → API 액세스에서 GCP 프로젝트 연결" 단계는 이제 없어졌다.
GCP 에서 API 활성화 + 서비스계정 생성 → Play Console 에서 사용자로 초대, 두 갈래면 끝이다.)

## 무인 릴리스 루프(자격증명이 갖춰졌을 때)

```
[Apple]  버전 범프 → 빌드 → 업로드 → (사람: 심사 제출 1클릭)
           → watch 가 승인 감지 → release --yes → READY_FOR_SALE 확인
[Play]   버전 범프 → 빌드 → (서비스계정 있으면) 업로드+롤아웃 자동
           → 심사 상태는 조회 불가 → 공개 페이지 버전 폴링으로 게시 확인
[공통]   안내 버전은 자동 반영(수동 갱신 불필요) → verify-deploy.sh
```

### 심사원용 데모 계정도 자동화된다 (2026-08-07 추가)

`appStoreReviewDetail` 은 **버전에 딸린 리소스**라 새 버전을 만들면 비어 있을 수 있다 — 그래서
릴리스마다 `review-set` 을 돌리는 것이 정상 절차다. 비밀번호는 **파일로만** 받는다(인자로 주면
셸 히스토리·`ps` 에 남는다). 화면에는 길이만 찍는다.

```json
// demo.json  — 커밋 금지. 임시 디렉토리에 두고 쓰고 나면 지운다.
{ "name": "demo@codingpt.app", "password": "...", "required": true }
```

제출 **전에** 데모 계정이 실제로 되는지 확인하는 것이 정본 절차다(2026-07-28 에 402 로 막혀 있던
전례): 로그인 → `POST /api/daemon/runner/cloud/ensure` 가 **200** 이어야 한다. 이것만 확인해도
"로그인 직후 아무것도 안 되는" 거절 사유는 거의 다 막힌다.

### Play 는 `status: completed`, Apple 은 `release-type after-approval`

두 스토어를 같은 규칙("승인되면 바로 게시")으로 두면 승인 뒤 사람이 누를 것이 없다. Apple 기본값은
MANUAL 이라 승인돼도 `PENDING_DEVELOPER_RELEASE` 에서 멈춘다 — 이걸 모르면 "승인됐는데 왜 안 올라오지"
가 된다. 심사 대기/심사 중에도 전환된다(실측).

사람이 남는 것: **거절 사유 읽기와 대응**(양 스토어 모두 API 없음), Play 의 콘텐츠 등급·앱 콘텐츠
선언(최초 1회, 이후 재사용), 그리고 Apple 배포 인증서 최초 생성(이것도 API 로 가능 — 아래).

## 함정

- ASC JWT 는 **만료 20분 이내**여야 한다(이 스크립트는 15분). 시계가 틀어지면 401.
- 401 이 나면 대개 Issuer ID 오타이거나 키 권한이 "앱 관리자" 미만이다.
- 스토어 게시(`READY_FOR_SALE`)를 **확인한 뒤에만** `APP_LATEST_*` 를 올린다 — 먼저 올리면
  사용자가 "업데이트하세요" 를 보고 스토어에 갔을 때 아직 이전 버전만 있다.
- 안내 버전(`APP_LATEST_*`)은 **양 스토어 모두 자동 반영**된다. env 는 조회가 막혔을 때의 폴백일 뿐이라
  낡아도 안전하다(맞춰두면 더 좋음).
