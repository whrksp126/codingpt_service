# 스토어 제출 자동화 — 어디까지 되고 어디부터 사람이 필요한가

결론부터: **심사 상태 확인과 승인 후 출시는 완전 자동화된다.** 업로드도 자격증명만 갖추면
자동이다. 사람이 반드시 필요한 건 **최초 1회 세팅**과 **심사 제출 버튼**뿐이다.

## 지금 이 Mac 의 자격증명 상태

| 자격 | 상태 | 없으면 |
|---|---|---|
| App Store Connect API 키(.p8) | ✅ `~/.appstoreconnect/private_keys/AuthKey_N5ZVQFND28.p8` | — |
| **ASC Issuer ID(UUID)** | ❌ **사용자가 알려줘야 함** | 조회·출시 전부 불가 |
| Apple 배포 인증서 | ❌ 이 키체인엔 Development 만 | Archive 를 Xcode 로 해야 함 |
| Android 서명 키스토어 | ✅ `codingpt_app/android/app/release-key.keystore` | — |
| **Play 서비스계정 JSON** | ❌ 없음 | Play 업로드·상태조회 전부 수동 |

Issuer ID 얻는 법: App Store Connect → 사용자 및 액세스 → **통합(Integrations)** → 상단에 표시.
비밀이 아니지만 값은 env 로만 넘긴다(`ASC_ISSUER_ID`).

## asc.mjs — App Store Connect (의존성 0, 지금 동작 확인됨)

```bash
export ASC_KEY_ID=N5ZVQFND28
export ASC_ISSUER_ID=<Issuer ID>

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

| 단계 | Apple | Google Play |
|---|---|---|
| 빌드 생성 | ✅ `xcodebuild archive`(단, **배포 인증서 필요** → 현재 Xcode 로) | ✅ `gradlew bundleRelease`(서명키 있음) |
| 업로드 | ✅ `xcrun altool --upload-app`(ASC 키로) | ⛔ 서비스계정 JSON 필요 |
| 릴리스 노트 입력 | ✅ API | ⛔ 서비스계정 필요 |
| **심사 제출** | ✅ API 로 가능하지만 **의도적으로 자동화 안 함** | ⛔ 서비스계정 필요 |
| **심사 상태 조회** | ✅ **자동** (`status`/`watch`) | ⛔ 서비스계정 필요 |
| **승인 후 출시** | ✅ **자동** (`release --yes`) | ⛔ 서비스계정 필요 |
| 스크린샷·개인정보 설문 | ⛔ 사람(최초 1회, 이후 재사용) | ⛔ 사람 |

### Play 를 자동화하려면(사용자 1회 작업)

1. Play Console → 설정 → **API 액세스** → Google Cloud 프로젝트 연결
2. GCP 에서 서비스계정 생성 → JSON 키 다운로드
3. Play Console 에서 그 서비스계정에 **앱 릴리스 권한** 부여
4. JSON 을 `~/other/secrets/play/` 에 두고 알려주기

그러면 업로드·트랙 승격·단계적 출시·상태 조회까지 Apple 과 같은 수준으로 자동화된다.

## 무인 릴리스 루프(자격증명이 갖춰졌을 때)

```
버전 범프 → 빌드 → 업로드 → (사람: 심사 제출 1클릭)
   → watch 가 승인 감지 → release --yes → READY_FOR_SALE 확인
   → APP_LATEST_ANDROID 갱신 → prod 재배포 → verify-deploy.sh
```

이 중 사람이 남는 건 **심사 제출 1회**뿐이다(그리고 Apple 이 요구하는 배포 인증서 최초 생성).

## 함정

- ASC JWT 는 **만료 20분 이내**여야 한다(이 스크립트는 15분). 시계가 틀어지면 401.
- 401 이 나면 대개 Issuer ID 오타이거나 키 권한이 "앱 관리자" 미만이다.
- 스토어 게시(`READY_FOR_SALE`)를 **확인한 뒤에만** `APP_LATEST_*` 를 올린다 — 먼저 올리면
  사용자가 "업데이트하세요" 를 보고 스토어에 갔을 때 아직 이전 버전만 있다.
- iOS 안내 버전은 back 이 App Store 를 실조회하므로 자동 반영된다(손댈 필요 없음). Android 만 수동.
