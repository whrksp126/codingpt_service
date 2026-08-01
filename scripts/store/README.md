# 스토어 제출 자동화 — 어디까지 되고 어디부터 사람이 필요한가

결론부터: **심사 상태 확인과 승인 후 출시는 완전 자동화된다.** 업로드도 자격증명만 갖추면
자동이다. 사람이 반드시 필요한 건 **최초 1회 세팅**과 **심사 제출 버튼**뿐이다.

## 지금 이 Mac 의 자격증명 상태

| 자격 | 상태 | 없으면 |
|---|---|---|
| App Store Connect API 키(.p8) | ✅ `~/.appstoreconnect/private_keys/AuthKey_N5ZVQFND28.p8` | — |
| **ASC Issuer ID(UUID)** | ✅ `f1908b5f-e631-41e0-b723-3b46c7c13041` (2026-08-01 실호출 확인) | — |
| Apple 배포 인증서 | ❌ 이 키체인엔 Development 만 | Archive 를 Xcode 로 해야 함 |
| Android 서명 키스토어 | ✅ `codingpt_app/android/app/release-key.keystore` | — |
| **Play 서비스계정 JSON** | ❌ 없음 | Play 업로드·상태조회 전부 수동 |

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
node codingpt_service/scripts/store/asc.mjs watch      # 상태 전이를 주기 감시(무인 폴링)
node codingpt_service/scripts/store/asc.mjs release --yes   # 승인 대기 버전을 출시
```

`status` 가 보여주는 상태와 뜻:

| Apple 상태 | 뜻 | 다음 행동 |
|---|---|---|
| `PREPARE_FOR_SUBMISSION` | 아직 심사에 안 보냄 | 리스팅·설문 채우고 제출 |
| `WAITING_FOR_REVIEW` / `IN_REVIEW` | 대기열 / 심사 중 | `watch` 로 감시 |
| `PENDING_DEVELOPER_RELEASE` | **승인됨, 출시만 남음** | `release --yes` |
| `READY_FOR_SALE` | 게시 완료 | `APP_LATEST_*` 갱신 |
| `REJECTED` | 거절 | 사유는 ASC 웹/Resolution Center |

**의도적으로 안 하는 것**: 심사 제출(submit). 제출은 되돌리기 번거롭고, 리스팅·스크린샷·
개인정보 설문이 갖춰졌는지는 사람이 봐야 한다. 그래서 이 스크립트에는 제출 명령을 넣지 않았다.

## 자동화 가능 범위 (양 스토어)

2026-08 기준, Play 는 `androidpublisher` v3 디스커버리 문서(rev 20260730)를 직접 훑어 확인했다.

| 단계 | Apple | Google Play |
|---|---|---|
| 빌드 생성 | ✅ `xcodebuild archive`(단, **배포 인증서 필요** → 현재 Xcode 로) | ✅ `gradlew bundleRelease`(서명키 있음) |
| 업로드 | ✅ `xcrun altool --upload-app`(ASC 키로) | ⛔→✅ 서비스계정만 있으면 자동(`edits.bundles.upload`) |
| 트랙·단계적 출시 | ✅ API | ⛔→✅ 서비스계정(`edits.tracks`, userFraction) |
| 리스팅·스크린샷·릴리스 노트 | ✅ API | ⛔→✅ 서비스계정(`edits.listings/images`) |
| **심사 제출** | ✅ API 로 가능하지만 **의도적으로 자동화 안 함** | ⛔→✅ 서비스계정(`edits.commit`) |
| **심사 상태 조회** | ✅ **자동**(`status`/`watch`) | ❌ **API 자체가 없음**(아래 참조) |
| **승인 후 출시** | ✅ **자동**(`release --yes`) | ✅ 단계적 출시 %로 대체(별도 출시 버튼 없음) |
| **게시 버전 조회**(안내값 자동화) | ✅ **자동**(iTunes lookup) | ✅ **자동**(공개 페이지 파싱 — 보조) |
| 콘텐츠 등급 설문 | ⛔ 사람(최초 1회) | ❌ **API 없음**(영구 GUI) |
| 데이터 안전 양식 | ⛔ 사람 | ✅ CSV 를 API 로 갱신 가능(최초 1회는 GUI → CSV 내보내기) |
| 앱 콘텐츠 선언(광고·타깃연령·건강 등) | ⛔ 사람 | ❌ **API 없음**(영구 GUI) |

### ⚠ Play 는 심사 상태를 API 로 알 수 없다 (Apple 과 결정적 차이)

`androidpublisher` v3 와 Play Developer Reporting API 양쪽 모두에 리뷰/정책 상태 필드가 **0건**이다
(`reviewStatus`/`policy`/`rejection` 전부 없음). `TrackRelease.status` 는 배포 상태
(`draft|inProgress|halted|completed`)일 뿐 심사 상태가 아니다. 게다가 거절 후 재제출은 Google 이
API 문서에서 **"Play Console UI 에서 명시적으로 보내야 한다"** 고 못 박는다(`changesNotSentForReview`).

→ **"승인되면 자동 출시" 루프는 Apple 에서만 성립한다.** Play 는 거절 확인·재제출이 영구 수동이고,
게시 여부는 우리가 하는 것처럼 **공개 페이지의 버전을 폴링**해 사후 확인하는 게 최선이다.

### Play 를 자동화하려면(사용자 1회 작업)

1. Play Console → 설정 → **API 액세스** → Google Cloud 프로젝트 연결
2. GCP 에서 서비스계정 생성 → JSON 키 다운로드
3. Play Console 에서 그 서비스계정에 **앱 릴리스 권한** 부여
4. JSON 을 `~/other/secrets/play/` 에 두고 알려주기

그러면 **업로드·트랙 승격·단계적 출시·리스팅 갱신**이 자동화된다(심사 상태 조회는 여전히 불가).
우리 앱은 이미 게시된 상태라 "최초 1회 수동 업로드" 전제도 이미 충족돼 있다.

## 무인 릴리스 루프(자격증명이 갖춰졌을 때)

```
[Apple]  버전 범프 → 빌드 → 업로드 → (사람: 심사 제출 1클릭)
           → watch 가 승인 감지 → release --yes → READY_FOR_SALE 확인
[Play]   버전 범프 → 빌드 → (서비스계정 있으면) 업로드+롤아웃 자동
           → 심사 상태는 조회 불가 → 공개 페이지 버전 폴링으로 게시 확인
[공통]   안내 버전은 자동 반영(수동 갱신 불필요) → verify-deploy.sh
```

사람이 남는 것: Apple 은 **심사 제출 1클릭 + 배포 인증서 최초 생성**, Play 는 **거절 시 확인·재제출**
(영구 수동) + 콘텐츠 등급·앱 콘텐츠 선언(최초 1회, 이후 재사용).

## 함정

- ASC JWT 는 **만료 20분 이내**여야 한다(이 스크립트는 15분). 시계가 틀어지면 401.
- 401 이 나면 대개 Issuer ID 오타이거나 키 권한이 "앱 관리자" 미만이다.
- 스토어 게시(`READY_FOR_SALE`)를 **확인한 뒤에만** `APP_LATEST_*` 를 올린다 — 먼저 올리면
  사용자가 "업데이트하세요" 를 보고 스토어에 갔을 때 아직 이전 버전만 있다.
- 안내 버전(`APP_LATEST_*`)은 **양 스토어 모두 자동 반영**된다. env 는 조회가 막혔을 때의 폴백일 뿐이라
  낡아도 안전하다(맞춰두면 더 좋음).
